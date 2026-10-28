"use strict";
/**
 * V1.2.15 回归：审批中心「点通过报不存在、单子却还在」
 * 运行：node --experimental-sqlite --test test/v1215.test.js
 *
 * 老板 2026-10-28 报的：总管理员 → 审批中心 → 待审批两条（例外单 / 付款），
 * 点「通过」都提示「不存在了」，可单子还挂在列表里。
 *
 * 根因是 ref_id 从种子起就写成了项目号，两头都断：
 *   · 点通过 → 按 ref_id 找例外单 / 付款单 → 拿到项目号 → notFound；
 *   · 业务侧处理完（付款已审批、改判自动撤销例外单）→ 按 ref_id 找审批单 → 找不到 → 单子永远待审批。
 *
 * 这里验四件事：
 *   1. 种子审批单的 ref_id 指向真实业务单据；
 *   2. 真实形状的两条单子，点通过能真的批掉；
 *   3. 业务单据已经有结论时，点通过不报错，而是同步关闭审批单；
 *   4. 老库里的脏数据，重启后能被迁移自愈（独立库，不污染主用例）。
 */
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { fillMaterials } = require("./helpers/materials");
const { DatabaseSync } = require("node:sqlite");

const ROOT = path.join(__dirname, "..");
const PORT = 8823;
const BASE = `http://127.0.0.1:${PORT}`;
const DB = path.join(ROOT, "data", "test23.db");
const UP = path.join(ROOT, "data", "test23-uploads");

// 迁移用例单独一套库 + 端口：要反复重启、还要写脏数据，不能和主用例共用
const MPORT = 8824;
const MBASE = `http://127.0.0.1:${MPORT}`;
const MDB = path.join(ROOT, "data", "test23m.db");
const MUP = path.join(ROOT, "data", "test23m-uploads");

let proc = null;
let mproc = null;
let admin, exec, finance;
let seq = 0;

function clean() {
  for (const f of [DB, DB + "-wal", DB + "-shm"]) if (fs.existsSync(f)) fs.renameSync(f, f + ".old");
  if (fs.existsSync(UP)) fs.rmSync(UP, { recursive: true, force: true });
  for (const f of [MDB, MDB + "-wal", MDB + "-shm"]) if (fs.existsSync(f)) fs.renameSync(f, f + ".old");
  if (fs.existsSync(MUP)) fs.rmSync(MUP, { recursive: true, force: true });
}

async function waitHealth(base, timeout = 40000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    try {
      const r = await fetch(`${base}/api/health`);
      if (r.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`测试服务 ${base} 启动超时`);
}

function spawnServer({ port, db, up }) {
  const p = spawn(process.execPath, ["--experimental-sqlite", "server/index.js"], {
    cwd: ROOT,
    env: { ...process.env, ERP_PORT: String(port), ERP_DB: db, ERP_UPLOAD_DIR: up },
    stdio: ["ignore", "pipe", "pipe"]
  });
  p.stderr.on("data", (d) => {
    const s = d.toString();
    if (!s.includes("ExperimentalWarning") && !s.includes("trace-warnings")) process.stderr.write("[srv] " + s);
  });
  return p;
}

async function stop(p) {
  if (!p) return;
  p.kill("SIGTERM");
  await new Promise((r) => {
    if (p.exitCode !== null) return r();
    p.once("exit", r);
    setTimeout(r, 3000);
  });
}

async function login(base, username, password = "123456") {
  const r = await fetch(`${base}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password })
  });
  assert.equal(r.status, 200, `${username} 登录失败`);
  return r.headers.get("set-cookie").split(";")[0];
}

function client(base, cookie) {
  return async (method, url, body) => {
    const r = await fetch(base + url, {
      method,
      headers: { "Content-Type": "application/json", cookie },
      body: body ? JSON.stringify(body) : undefined
    });
    const text = await r.text();
    let data = null;
    try { data = JSON.parse(text); } catch { data = text; }
    return { status: r.status, data };
  };
}

/** 直连库改一行 —— 只用于造「业务单据已处理、审批单还挂着」这种线上真实脏状态 */
async function patchDb(file, sql, params = []) {
  let lastErr;
  for (let i = 0; i < 5; i++) {
    const d = new DatabaseSync(file);
    try {
      d.prepare(sql).run(...params);
      return;
    } catch (e) {
      lastErr = e;
      await new Promise((r) => setTimeout(r, 120));
    } finally {
      try { d.close(); } catch {}
    }
  }
  throw lastErr;
}

function readDb(file, sql, params = []) {
  const d = new DatabaseSync(file);
  try {
    return d.prepare(sql).all(...params);
  } finally {
    d.close();
  }
}

before(async () => {
  clean();
  proc = spawnServer({ port: PORT, db: DB, up: UP });
  await waitHealth(BASE);
  admin = await login(BASE, "admin");
  exec = await login(BASE, "exec");
  finance = await login(BASE, "finance");
});

after(async () => {
  await stop(proc);
  await stop(mproc);
});

/* ------------------------------------------------------------------ */

test("种子审批单的 ref_id 指向真实业务单据，不是项目号", async () => {
  const c = client(BASE, admin);
  const r = await c("GET", "/api/approvals");
  assert.equal(r.status, 200);
  const byId = Object.fromEntries(r.data.rows.map((a) => [a.id, a]));

  // 付款审批：必须指向 PY 付款单，且该单存在
  const pay = byId["AP-2026-012"];
  assert.ok(pay, "种子缺少 AP-2026-012");
  assert.match(pay.ref_id, /^PY-\d{4}-\d+$/, `付款审批 ref_id 应为付款单号，实际 ${pay.ref_id}`);
  const py = readDb(DB, "SELECT id, status FROM payments WHERE id = ?", [pay.ref_id]);
  assert.equal(py.length, 1, `ref_id ${pay.ref_id} 对应的付款单不存在`);

  // 例外单审批：必须指向 EX 例外单
  const ex = byId["AP-2026-013"];
  assert.ok(ex, "种子缺少 AP-2026-013");
  assert.equal(ex.ref_id, "EX-2026-018");
  const exRow = readDb(DB, "SELECT id FROM exceptions WHERE id = ?", [ex.ref_id]);
  assert.equal(exRow.length, 1, "例外单审批指向的例外单不存在");

  // 立项 / 变更的 ref 本来就是项目号，不能被误改
  assert.equal(byId["AP-2026-014"].ref_id, "MP-2026-005");
  assert.equal(byId["AP-2026-011"].ref_id, "MP-2026-001");
});

test("线上那两条待审批：点通过能真的批掉，不再报「不存在」", async () => {
  const c = client(BASE, admin);
  const me = await c("GET", "/api/auth/me");
  const adminName = me.data.user.name;

  // ① 例外单审批：通过后例外单已通过，第 4 步变「已解例外」
  const r1 = await c("POST", "/api/approvals/AP-2026-013/decide", { approve: true, comment: "同意补录议程" });
  assert.equal(r1.status, 200, `例外单审批失败：${JSON.stringify(r1.data)}`);
  assert.match(r1.data.message, /已通过/);
  const ex = readDb(DB, "SELECT status, approved_by FROM exceptions WHERE id = 'EX-2026-018'")[0];
  assert.equal(ex.status, "已通过");
  assert.equal(ex.approved_by, adminName);
  const step = readDb(DB, "SELECT result FROM verify_steps WHERE pid = 'MP-2026-003' AND step_no = 4")[0];
  assert.equal(step.result, "已解例外");

  // ② 付款审批：通过后付款单已审批
  const r2 = await c("POST", "/api/approvals/AP-2026-012/decide", { approve: true, comment: "" });
  assert.equal(r2.status, 200, `付款审批失败：${JSON.stringify(r2.data)}`);
  const pay = readDb(DB, "SELECT status FROM payments WHERE pid = 'MP-2026-003' AND amount = 84000")[0];
  assert.equal(pay.status, "已审批");

  // ③ 这两条从「待审批」里消失（种子里还有两条立项审批，不能按总数断言）
  const list = await c("GET", "/api/approvals?status=待审批");
  const left = list.data.rows.map((x) => x.id);
  assert.ok(!left.includes("AP-2026-012"), `付款审批仍在待审批：${JSON.stringify(left)}`);
  assert.ok(!left.includes("AP-2026-013"), `例外单审批仍在待审批：${JSON.stringify(left)}`);
});

test("业务单据已有结论时，点通过不报错，而是同步关闭审批单", async () => {
  const e = client(BASE, exec);
  const c = client(BASE, admin);

  // 造一个待核销项目 → 第 1 步判不通过 → 自动生成例外单 + 审批单
  const pid = await (async () => {
    const r = await e("POST", "/api/projects", {
      name: `V1.2.15 幽灵单用例 ${Date.now()}-${++seq}`,
      assoc: "华东医学会", form: "线下", date: "2027-08-08", budget: 60000, people: 60,
      owner: "陈静", agenda: "09:00 开幕"
    });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    const id = r.data.project.id;
    const submit = await e("POST", `/api/projects/${id}/transition`, { action: "submit" });
    assert.equal(submit.status, 200, `提交立项失败：${JSON.stringify(submit.data)}`);
    const approve = await c("POST", `/api/projects/${id}/transition`, { action: "approve" });
    assert.equal(approve.status, 200, `立项审批失败：${JSON.stringify(approve.data)}`);
    // 已立项 → 筹备中 → 执行中 → 待核销
    await fillMaterials(e, id); // V1.2.19 核销前置：材料 8 类
    for (const action of ["prep", "exec", "request_verify"]) {
      const t = await e("POST", `/api/projects/${id}/transition`, { action });
      assert.equal(t.status, 200, `${action} 失败：${JSON.stringify(t.data)}`);
    }
    return id;
  })();

  const judge = await e("POST", `/api/projects/${pid}/verify/steps/1`, { result: "不通过", remark: "签到表缺页" });
  assert.equal(judge.status, 200, JSON.stringify(judge.data));
  const apId = judge.data.verification.exceptions[0].id
    ? readDb(DB, "SELECT id FROM approvals WHERE ref_id = ? AND type = '例外单审批' ORDER BY id DESC LIMIT 1",
        [judge.data.verification.exceptions[0].id])[0].id
    : null;
  assert.ok(apId, "判定不通过后没有生成例外单审批");

  // 模拟线上真实状态：例外单已在别处被撤销，审批单还挂在「待审批」
  await patchDb(DB, "UPDATE exceptions SET status = '已撤销', comment = '第 1 步改判通过，系统自动撤销' WHERE pid = ? AND step_no = 1", [pid]);

  const r = await c("POST", `/api/approvals/${apId}/decide`, { approve: true, comment: "" });
  assert.equal(r.status, 200, `应同步关闭而不是报错：${JSON.stringify(r.data)}`);
  assert.match(r.data.message, /同步关闭/);
  assert.equal(r.data.synced, true);

  const after = readDb(DB, "SELECT status, comment FROM approvals WHERE id = ?", [apId])[0];
  assert.equal(after.status, "已撤销");
  assert.match(after.comment, /同步关闭/);

  // 不再出现在待审批列表里
  const pending = await c("GET", "/api/approvals?status=待审批");
  assert.ok(!pending.data.rows.some((x) => x.id === apId), "同步关闭后仍留在待审批列表");
});

test("老库脏数据重启后自愈：ref_id 回填 + 业务单据结论同步", async () => {
  // 独立库：先起一次服务把种子写进去，再停掉写脏数据，最后重启看迁移
  mproc = spawnServer({ port: MPORT, db: MDB, up: MUP });
  await waitHealth(MBASE);
  await stop(mproc);

  // 还原线上事故的形状：ref_id 全是项目号；付款已审批、例外单已撤销，审批单却还待审批
  await patchDb(MDB, "UPDATE approvals SET ref_id = 'MP-2026-003', status = '待审批' WHERE id IN ('AP-2026-012','AP-2026-013')");
  await patchDb(MDB, "UPDATE payments SET status = '已审批' WHERE pid = 'MP-2026-003' AND amount = 84000");
  await patchDb(MDB, "UPDATE exceptions SET status = '已撤销', approved_by = '李静', approved_at = '2026-10-27 06:46' WHERE id = 'EX-2026-018'");

  mproc = spawnServer({ port: MPORT, db: MDB, up: MUP });
  await waitHealth(MBASE);

  const rows = readDb(MDB, "SELECT id, ref_id, status, comment FROM approvals WHERE id IN ('AP-2026-012','AP-2026-013')");
  const byId = Object.fromEntries(rows.map((r) => [r.id, r]));

  // ref_id 回填成真实单据
  assert.match(byId["AP-2026-012"].ref_id, /^PY-\d{4}-\d+$/, `付款审批 ref_id 未回填：${byId["AP-2026-012"].ref_id}`);
  assert.equal(byId["AP-2026-013"].ref_id, "EX-2026-018", "例外单审批 ref_id 未回填");

  // 结论同步：付款已审批 → 审批单已通过；例外单已撤销 → 审批单已撤销
  assert.equal(byId["AP-2026-012"].status, "已通过");
  assert.equal(byId["AP-2026-013"].status, "已撤销");
  assert.match(byId["AP-2026-012"].comment, /同步关闭/);
  assert.match(byId["AP-2026-013"].comment, /同步关闭/);

  // 迁移是幂等的：再重启一次，结果不变
  await stop(mproc);
  mproc = spawnServer({ port: MPORT, db: MDB, up: MUP });
  await waitHealth(MBASE);
  const again = readDb(MDB, "SELECT status FROM approvals WHERE id = 'AP-2026-013'")[0];
  assert.equal(again.status, "已撤销");

  // 自愈后点通过不再 404（此时已是终态，应给 409 而不是「不存在」）
  const ck = await login(MBASE, "admin");
  const c = client(MBASE, ck);
  const r = await c("POST", "/api/approvals/AP-2026-013/decide", { approve: true, comment: "" });
  assert.equal(r.status, 409, `终态审批单应给 409，实际 ${r.status} ${JSON.stringify(r.data)}`);
  assert.match(String(r.data.error?.message || ""), /已撤销|已是/);
});

test("付款单新建时审批单 ref 直接指向它，通过后两边同时到位", async () => {
  const f = client(BASE, finance);
  const c = client(BASE, admin);

  // MP-2026-008 种子里就是「已核销」，可以直接挂付款
  const r = await f("POST", "/api/payments", {
    pid: "MP-2026-008", type: "个人报销", payee: "周涛", amount: 1200, invoice_no: `T${Date.now()}`
  , payee_bank: "中国银行北京分行", payee_account: "3210987654321098"});
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const py = r.data.payment.id;

  const ap = readDb(DB, "SELECT id, ref_id FROM approvals WHERE ref_id = ? AND type = '付款审批'", [py])[0];
  assert.ok(ap, "新建付款后没有生成审批单");
  assert.equal(ap.ref_id, py, "新建审批单的 ref_id 必须就是付款单号");

  const ok = await c("POST", `/api/approvals/${ap.id}/decide`, { approve: true, comment: "同意" });
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  assert.equal(readDb(DB, "SELECT status FROM payments WHERE id = ?", [py])[0].status, "已审批");
  assert.equal(readDb(DB, "SELECT status FROM approvals WHERE id = ?", [ap.id])[0].status, "已通过");
});
