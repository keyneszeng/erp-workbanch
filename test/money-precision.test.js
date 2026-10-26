"use strict";
/**
 * 金额定点 + 核销改判与例外单联动（V1.2.6）
 * 运行：node --test test/money-precision.test.js
 *
 * 这一组抓到的都是「数算得出来、但算错了」的缺陷，界面上不崩、接口也 200：
 *
 *   A. 浮点尾巴
 *      - 结算单 profit = income - expense 直接算，140000 - 135580.6 = 4419.399999999994，
 *        带 12 位小数入库，导出 CSV 就是这一串；实测 96000 - 71444.44 = 24555.559999999998。
 *      - 预算门禁 `已占用 + 本笔 > 预算` 拿浮点和比：预算 5389.78、已用 2789.69、
 *        本笔 2600.09，明明正好用尽，却被判「将超预算 ¥0」——把差额打印出来是 0，
 *        用户只会觉得系统在乱拦。
 *      - 预算下调到「刚好等于已占用」同样被拒。
 *
 *   B. 例外单联动
 *      - 同一步连判两次「不通过」会生成两张例外单，审批中心挂同一问题两张；
 *      - 改判「通过」后旧例外单仍是「待审批」，openExceptions 永远 > 0，
 *        核销永远 complete 不了，只能求财务去批一张问题已不存在的单子。
 */
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const PORT = 8818;
const BASE = `http://127.0.0.1:${PORT}`;
const DB = path.join(__dirname, "..", "data", "test18.db");
const UP = path.join(__dirname, "..", "data", "test18-uploads");
let proc;
let admin;

function clean() {
  for (const f of [DB, DB + "-wal", DB + "-shm"]) if (fs.existsSync(f)) fs.unlinkSync(f);
  if (fs.existsSync(UP)) fs.rmSync(UP, { recursive: true, force: true });
}
async function waitHealth(t = 15000) {
  const t0 = Date.now();
  while (Date.now() - t0 < t) {
    try { const r = await fetch(`${BASE}/api/health`); if (r.ok) return; } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("测试服务启动超时");
}
async function login(u, p = "123456") {
  const r = await fetch(`${BASE}/api/auth/login`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: u, password: p })
  });
  assert.equal(r.status, 200, `${u} 登录失败`);
  return r.headers.get("set-cookie").split(";")[0];
}
function client(cookie) {
  return async (method, url, body) => {
    const r = await fetch(BASE + url, {
      method, headers: { "Content-Type": "application/json", cookie },
      body: body ? JSON.stringify(body) : undefined
    });
    const text = await r.text();
    let data; try { data = JSON.parse(text); } catch { data = text; }
    return { status: r.status, data, code: data?.error?.code, msg: data?.error?.message || data?.message || "" };
  };
}
const dec = (n) => (String(n).split(".")[1] || "").length;

/** 建项目 → 推到「待核销」→ 6 步全通过 → 核销通过 */
async function projectReadyToPay(name, budget) {
  const mk = await admin("POST", "/api/projects", {
    name, assoc: "华东医学会", form: "线下", date: "2026-12-20",
    budget, owner: "王敏", agenda: "金额精度回归", people: 20
  });
  assert.equal(mk.status, 200, mk.msg);
  const pid = mk.data.project.id;
  for (const a of ["submit", "approve", "prep", "exec", "request_verify"]) {
    const r = await admin("POST", `/api/projects/${pid}/transition`, { action: a });
    assert.equal(r.status, 200, `${a} 失败：${r.msg}`);
  }
  for (let no = 1; no <= 6; no++) {
    const r = await admin("POST", `/api/projects/${pid}/verify/steps/${no}`, { result: "通过", remark: "" });
    assert.equal(r.status, 200, `第 ${no} 步失败：${r.msg}`);
  }
  const vp = await admin("POST", `/api/projects/${pid}/transition`, { action: "verify_pass" });
  assert.equal(vp.status, 200, vp.msg);
  return pid;
}

async function payAll(pid, amounts) {
  for (const amount of amounts) {
    const y = await admin("POST", "/api/payments", {
      pid, type: "学会公付", payee: `收款方${amount}`, amount, invoice_no: "", remark: ""
    });
    assert.equal(y.status, 200, `付款 ${amount} 被拒：${y.code || ""} ${y.msg}`);
    const id = y.data.payment.id;
    assert.equal((await admin("POST", `/api/payments/${id}/approve`, { approve: true })).status, 200);
    assert.equal((await admin("POST", `/api/payments/${id}/pay`, {})).status, 200);
  }
}

before(async () => {
  clean();
  proc = spawn(process.execPath, ["--experimental-sqlite", "server/index.js"], {
    cwd: path.join(__dirname, ".."),
    env: { ...process.env, ERP_PORT: String(PORT), ERP_DB: DB, ERP_UPLOAD_DIR: UP },
    stdio: ["ignore", "pipe", "pipe"]
  });
  proc.stdout.on("data", () => {});
  proc.stderr.on("data", () => {});
  await waitHealth();
  admin = client(await login("admin"));
});

after(() => {
  proc?.kill();
  clean();
});

/* ---------------- A. 金额定点 ---------------- */

test("预算正好用尽不被判超预算（浮点相加不得成为拒绝理由）", async () => {
  // 2789.69 + 2600.09 = 5389.780000000001（浮点），预算 5389.78
  const pid = await projectReadyToPay("预算正好用尽", 5389.78);
  await payAll(pid, [2789.69, 2600.09]);

  const v = (await admin("GET", `/api/projects/${pid}/verify`)).data;
  assert.equal(Number(v.paidTotal), 5389.78, `paidTotal=${v.paidTotal}`);

  const st = await admin("POST", `/api/projects/${pid}/transition`, { action: "settle" });
  assert.equal(st.status, 200, st.msg);
  const s = (await admin("GET", `/api/projects/${pid}`)).data.settlement;
  assert.equal(Number(s.expense), 5389.78);
  assert.equal(Number(s.profit), 0);
});

test("结算单 profit 落在「分」上，不出现 24555.559999999998", async () => {
  // 96000 - 71444.44 在浮点里是 24555.559999999998
  const pid = await projectReadyToPay("结余带尾巴", 96000);
  await payAll(pid, [71444.44]);
  assert.equal((await admin("POST", `/api/projects/${pid}/transition`, { action: "settle" })).status, 200);

  const s = (await admin("GET", `/api/projects/${pid}`)).data.settlement;
  assert.ok(dec(s.profit) <= 2, `profit 有 ${dec(s.profit)} 位小数：${s.profit}`);
  assert.equal(Number(s.profit), 24555.56);
  assert.ok(dec(s.expense) <= 2, `expense 有 ${dec(s.expense)} 位小数：${s.expense}`);
});

test("结算单导出 CSV 的结余列是两位小数，不是浮点尾巴", async () => {
  const r = await fetch(`${BASE}/api/export/settlements`, {
    headers: { cookie: await login("admin") }
  });
  assert.equal(r.status, 200);
  const text = await r.text();
  assert.ok(!/\d\.\d{6,}/.test(text), `导出里出现长小数：${(text.match(/\d\.\d{6,}/) || [])[0]}`);
});

test("预算下调到「刚好等于已占用」不被拒", async () => {
  const pid = await projectReadyToPay("下调到刚好", 6000);
  await payAll(pid, [2789.69, 2600.09]);
  const used = 5389.78;

  // 已结算项目不让改预算，先建一个只挂单不结算的
  const pid2 = await projectReadyToPay("下调到刚好 B", 6000);
  await payAll(pid2, [2789.69, 2600.09]);
  const r = await admin("PATCH", `/api/projects/${pid2}`, { budget: used });
  assert.equal(r.status, 200, `${r.code || ""} ${r.msg}`);
  assert.equal(Number((await admin("GET", `/api/projects/${pid2}`)).data.project.budget), used);
});

/* ---------------- B. 例外单联动 ---------------- */

test("同一步连判两次「不通过」只生成一张例外单", async () => {
  const pid = "MP-2026-004"; // 待核销
  const r1 = await admin("POST", `/api/projects/${pid}/verify/steps/1`, { result: "不通过", remark: "议程缺一份" });
  assert.equal(r1.status, 200, r1.msg);
  const r2 = await admin("POST", `/api/projects/${pid}/verify/steps/1`, { result: "不通过", remark: "议程仍然缺一份" });
  assert.equal(r2.status, 200, r2.msg);

  const v = (await admin("GET", `/api/projects/${pid}/verify`)).data.verification;
  const ex = v.exceptions.filter((e) => e.step_no === 1 && e.status === "待审批");
  assert.equal(ex.length, 1, `第 1 步挂 ${ex.length} 张待审批例外单：${ex.map((e) => e.id).join(",")}`);
  assert.equal(ex[0].reason, "议程仍然缺一份", "沿用同一张单时应更新问题描述");
});

test("改判「通过」自动撤销该步待审批的例外单，核销不再被卡住", async () => {
  const pid = "MP-2026-004";
  const before = (await admin("GET", `/api/projects/${pid}/verify`)).data.verification;
  const openBefore = before.exceptions.filter((e) => e.step_no === 1 && e.status === "待审批");
  assert.ok(openBefore.length, "前置条件：第 1 步应有一张待审批例外单");

  const r = await admin("POST", `/api/projects/${pid}/verify/steps/1`, { result: "通过", remark: "复核实为齐备" });
  assert.equal(r.status, 200, r.msg);
  assert.match(r.msg, /撤销/);

  const v = (await admin("GET", `/api/projects/${pid}/verify`)).data.verification;
  const open = v.exceptions.filter((e) => e.step_no === 1 && e.status === "待审批");
  assert.equal(open.length, 0, "改判通过后不应再有待审批例外单");
  assert.equal(v.openExceptions, 0, `仍有 ${v.openExceptions} 张待审批例外单`);

  // 对应审批单也必须一起关掉，否则审批中心还挂着一条永远处理不了的项
  const ap = (await admin("GET", "/api/approvals?status=待审批")).data.rows;
  for (const e of openBefore) {
    assert.ok(!ap.some((a) => a.ref_id === e.id), `审批中心仍挂着 ${e.id}`);
  }

  // 6 步走完就能真正核销通过
  for (let no = 2; no <= 6; no++) {
    const rr = await admin("POST", `/api/projects/${pid}/verify/steps/${no}`, { result: "通过", remark: "" });
    assert.equal(rr.status, 200, `第 ${no} 步失败：${rr.msg}`);
  }
  const vp = await admin("POST", `/api/projects/${pid}/transition`, { action: "verify_pass" });
  assert.equal(vp.status, 200, `${vp.code || ""} ${vp.msg}`);
});

test("已撤销的例外单不可再审批", async () => {
  const pid = "MP-2026-004";
  const v = (await admin("GET", `/api/projects/${pid}/verify`)).data.verification;
  const revoked = v.exceptions.find((e) => e.status === "已撤销");
  assert.ok(revoked, "应有已撤销的例外单");
  const r = await admin("POST", `/api/exceptions/${revoked.id}/decide`, { approve: true, comment: "补批" });
  assert.equal(r.status, 409, `${r.status} ${r.msg}`);
  assert.match(r.msg, /已撤销/);
});
