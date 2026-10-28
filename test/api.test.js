"use strict";
/**
 * 接口级回归测试 —— 覆盖权限、工作流门禁、核销链、付款门禁、结算冻结、归档与导出
 * 运行：npm test
 */
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const PORT = 8799;
const BASE = `http://127.0.0.1:${PORT}`;
const DB = path.join(__dirname, "..", "data", "test.db");
let proc;

function cleanDb() {
  for (const f of [DB, DB + "-wal", DB + "-shm"]) if (fs.existsSync(f)) fs.renameSync(f, f + ".old");
}

async function waitHealth(timeout = 40000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    try {
      const r = await fetch(`${BASE}/api/health`);
      if (r.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("测试服务启动超时");
}

async function login(username, password = "123456") {
  const r = await fetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password })
  });
  assert.equal(r.status, 200, `${username} 登录应成功`);
  const raw = r.headers.get("set-cookie") || "";
  return raw.split(";")[0];
}

function client(cookie) {
  return async (method, url, body) => {
    const r = await fetch(BASE + url, {
      method,
      headers: { "Content-Type": "application/json", cookie },
      body: body ? JSON.stringify(body) : undefined
    });
    const text = await r.text();
    let data = null;
    try { data = JSON.parse(text); } catch { data = text; }
    return { status: r.status, data, headers: r.headers };
  };
}

let admin, assoc, exec, finance, guest;
let api = {};
let adminCookieStr = "";
const adminCookie = () => adminCookieStr;

before(async () => {
  cleanDb();
  proc = spawn(process.execPath, ["--experimental-sqlite", "server/index.js"], {
    cwd: path.join(__dirname, ".."),
    env: { ...process.env, ERP_PORT: String(PORT), ERP_DB: DB },
    stdio: ["ignore", "pipe", "pipe"]
  });
  proc.stderr.on("data", (d) => {
    const s = d.toString();
    if (!s.includes("ExperimentalWarning") && !s.includes("trace-warnings")) process.stderr.write("[srv] " + s);
  });
  await waitHealth();

  adminCookieStr = await login("admin");
  admin = client(adminCookieStr);
  assoc = client(await login("assoc"));
  exec = client(await login("exec"));
  finance = client(await login("finance"));
  guest = client(await login("guest"));
});

after(() => {
  if (proc) proc.kill("SIGTERM");
});

/* ---------------- 认证 ---------------- */
test("登录：错误密码返回 401", async () => {
  const r = await fetch(`${BASE}/api/auth/login`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "admin", password: "wrong" })
  });
  assert.equal(r.status, 401);
});

test("未登录访问业务接口返回 401", async () => {
  const r = await fetch(`${BASE}/api/projects`);
  assert.equal(r.status, 401);
});

test("总管理员是超级角色", async () => {
  const r = await admin("GET", "/api/auth/me");
  assert.equal(r.data.super, true);
  assert.equal(r.data.role.modules.length, 11);
});

/* ---------------- 数据范围 ---------------- */
test("数据范围：协会管理员只看到本协会项目", async () => {
  const r = await assoc("GET", "/api/projects");
  assert.ok(r.data.rows.length > 0);
  assert.ok(r.data.rows.every((p) => p.assoc === "华东医学会"), "不应出现其他协会项目");
});

test("数据范围：嘉宾看到「成员 + 负责人 + 创建人」三类项目", async () => {
  /**
   * V1.2.17 BUG-01：原来只认成员表，刘洋（guest）作为 MP-2026-005 / MP-2026-011 的
   * 负责人一场都看不到 —— 负责人登录后看不到自己的会议，推进阶段、填需求、核销取证全断。
   * 现在负责人与创建人也算数据范围内，所以是 3 场。
   */
  const r = await guest("GET", "/api/projects");
  const ids = r.data.rows.map((p) => p.id).sort();
  assert.deepEqual(ids, ["MP-2026-002", "MP-2026-005", "MP-2026-011"],
    `实际：${ids.join(", ")}`);
});

test("数据范围：总管理员看到全平台项目", async () => {
  const r = await admin("GET", "/api/projects");
  assert.equal(r.data.total, 18);
});

/* ---------------- 权限 ---------------- */
test("会务执行不能审批立项", async () => {
  const r = await exec("POST", "/api/approvals/AP-2026-014/decide", { approve: true });
  assert.equal(r.status, 403);
});

test("会务执行不能创建用户", async () => {
  const r = await exec("POST", "/api/users", { username: "hack", name: "x", role: "admin" });
  assert.equal(r.status, 403);
});

test("财务不能发起立项", async () => {
  const r = await finance("POST", "/api/projects", { name: "x", assoc: "华东医学会", form: "线下", date: "2026-12-01", budget: 1000, owner: "x", agenda: "abc" });
  assert.equal(r.status, 403);
});

test("立项必填校验：缺议程被拒", async () => {
  const r = await assoc("POST", "/api/projects", { name: "缺议程", assoc: "华东医学会", form: "线下", date: "2026-12-01", budget: 1000, owner: "王敏" });
  assert.equal(r.status, 400);
});

/* ---------------- 工作流 ---------------- */
let pid;

test("工作流：新建 → 提交 → 审批 → 筹备 → 执行 → 待核销", async () => {
  const created = await assoc("POST", "/api/projects", {
    name: "回归测试会议", assoc: "华东医学会", form: "线下", date: "2026-12-20",
    budget: 100000, people: 80, owner: "王敏", agenda: "09:00 开幕 / 10:00 主题报告", dept: "会务部"
  });
  assert.equal(created.status, 200);
  pid = created.data.project.id;
  assert.equal(created.data.project.status, "草稿");

  // 把执行与财务加入项目，才能进入其数据范围
  const us = await assoc("GET", "/api/users/pickable");
  for (const nm of ["张伟", "陈静"]) {
    const u = us.data.rows.find((x) => x.name === nm);
    const r = await assoc("POST", `/api/projects/${pid}/members`, { user_id: u.id });
    assert.equal(r.status, 200);
  }

  const submit = await assoc("POST", `/api/projects/${pid}/transition`, { action: "submit" });
  assert.equal(submit.status, 200);
  assert.equal(submit.data.project.status, "待审批");

  // 重复提交应被拒
  const again = await assoc("POST", `/api/projects/${pid}/transition`, { action: "submit" });
  assert.equal(again.status, 409);

  const approve = await assoc("POST", `/api/projects/${pid}/transition`, { action: "approve", comment: "同意" });
  assert.equal(approve.data.project.status, "已立项");

  const prep = await assoc("POST", `/api/projects/${pid}/transition`, { action: "prep" });
  assert.equal(prep.data.project.status, "筹备中");

  const ex = await assoc("POST", `/api/projects/${pid}/transition`, { action: "exec" });
  assert.equal(ex.data.project.status, "执行中");

  const rv = await assoc("POST", `/api/projects/${pid}/transition`, { action: "request_verify" });
  assert.equal(rv.data.project.status, "待核销");
});

test("工作流：非法流转被拒", async () => {
  const r = await admin("POST", `/api/projects/${pid}/transition`, { action: "archive" });
  assert.equal(r.status, 409);
  assert.equal(r.data.error.code, "ILLEGAL_TRANSITION");
});

test("核销：跳步判定被拒", async () => {
  const r = await finance("POST", `/api/projects/${pid}/verify/steps/3`, { result: "通过" });
  assert.equal(r.status, 409);
  assert.equal(r.data.error.code, "OUT_OF_ORDER");
});

test("付款门禁：待核销项目付款被拦截", async () => {
  const r = await finance("POST", "/api/payments", { pid, type: "学会公付", payee: "测试酒店", amount: 1000 });
  assert.equal(r.status, 409);
  assert.equal(r.data.error.code, "VERIFY_GATE");
  assert.match(r.data.error.message, /核销/);
});

test("核销：不通过自动生成例外单，核销通过被门禁拦截", async () => {
  for (const no of [1, 2, 3]) {
    const r = await exec("POST", `/api/projects/${pid}/verify/steps/${no}`, { result: "通过" });
    assert.equal(r.status, 200);
  }
  const bad = await exec("POST", `/api/projects/${pid}/verify/steps/4`, { result: "不通过", remark: "课件与议程不一致" });
  assert.equal(bad.status, 200);
  assert.equal(bad.data.verification.openExceptions, 1);

  const pass = await finance("POST", `/api/projects/${pid}/transition`, { action: "verify_pass" });
  assert.equal(pass.status, 409);
  assert.equal(pass.data.error.code, "GATE_BLOCKED");
});

test("例外单：财务审批通过后该步记为已解例外", async () => {
  const v = await finance("GET", `/api/projects/${pid}/verify`);
  const exId = v.data.verification.exceptions[0].id;
  const r = await finance("POST", `/api/exceptions/${exId}/decide`, { approve: true, comment: "同意补录" });
  assert.equal(r.status, 200);
  assert.equal(r.data.verification.steps.find((s) => s.no === 4).result, "已解例外");
});

test("核销：6 步全过后可核销通过", async () => {
  for (const no of [5, 6]) {
    const r = await exec("POST", `/api/projects/${pid}/verify/steps/${no}`, { result: "通过" });
    assert.equal(r.status, 200);
  }
  const r = await finance("POST", `/api/projects/${pid}/transition`, { action: "verify_pass" });
  assert.equal(r.status, 200);
  assert.equal(r.data.project.status, "已核销");
});

test("付款门禁：核销通过后付款可提交，审批 + 付款走通", async () => {
  const c = await finance("POST", "/api/payments", { pid, type: "学会公付", payee: "测试酒店", amount: 32000, invoice_no: "INV-001" });
  assert.equal(c.status, 200);
  const payId = c.data.payment.id;
  assert.equal(c.data.payment.status, "待审批");

  const a = await finance("POST", `/api/payments/${payId}/approve`, { approve: true });
  assert.equal(a.data.payment.status, "已审批");

  const p = await finance("POST", `/api/payments/${payId}/pay`, {});
  assert.equal(p.data.payment.status, "已付款");
});

test("结算：生成结算单后核销结论冻结", async () => {
  const r = await finance("POST", `/api/projects/${pid}/transition`, { action: "settle" });
  assert.equal(r.status, 200);
  assert.equal(r.data.project.status, "已结算");

  const again = await finance("POST", `/api/projects/${pid}/transition`, { action: "settle" });
  assert.equal(again.status, 409);

  const judge = await finance("POST", `/api/projects/${pid}/verify/steps/6`, { result: "不通过", remark: "改判" });
  assert.equal(judge.status, 409);
  assert.equal(judge.data.error.code, "FROZEN");
});

test("归档：材料未齐备被拦截，补齐 8 类后归档成功", async () => {
  const bad = await assoc("POST", `/api/projects/${pid}/transition`, { action: "archive" });
  assert.equal(bad.status, 409);
  assert.match(bad.data.error.message, /归档材料缺/);

  for (const kind of ["立项文件", "合同", "议程", "课件", "签到表", "劳务表", "发票", "现场照片"]) {
    const r = await assoc("POST", `/api/projects/${pid}/materials`, { kind, name: `${kind}.pdf` });
    assert.equal(r.status, 200);
  }
  const ok = await assoc("POST", `/api/projects/${pid}/transition`, { action: "archive" });
  assert.equal(ok.status, 200);
  assert.equal(ok.data.project.status, "已归档");
});

test("归档后材料不可删除", async () => {
  const d = await assoc("GET", `/api/projects/${pid}`);
  const m = d.data.materials[0];
  const r = await assoc("DELETE", `/api/materials/${m.id}`);
  assert.equal(r.status, 409);
});

/* ---------------- 总管理员越权验证 ---------------- */
test("总管理员可执行任意角色动作（跨角色）", async () => {
  const r = await admin("POST", "/api/projects/MP-2026-013/transition", { action: "approve", comment: "总管理员代审批" });
  assert.equal(r.status, 200);
  assert.equal(r.data.project.status, "已立项");
});

test("总管理员可修改任意项目资料", async () => {
  const r = await admin("PATCH", "/api/projects/MP-2026-009", { people: 60 });
  assert.equal(r.status, 200);
  assert.equal(r.data.project.people, 60);
});

/* ---------------- 导出与审计 ---------------- */
test("导出：CSV 带 BOM 与表头", async () => {
  const r = await fetch(`${BASE}/api/export/projects`, { headers: { cookie: adminCookie() } });
  assert.equal(r.status, 200);
  const buf = Buffer.from(await r.arrayBuffer());
  assert.deepEqual([...buf.subarray(0, 3)], [0xef, 0xbb, 0xbf], "应带 UTF-8 BOM");
  const text = buf.toString("utf8");
  assert.match(text, /项目编号/);
  assert.ok(text.split("\r\n").length >= 19);
});

test("审计：关键动作均留痕", async () => {
  const r = await admin("GET", "/api/audit?q=" + encodeURIComponent(pid));
  assert.equal(r.status, 200);
  const acts = r.data.rows.map((x) => x.action);
  for (const a of ["状态流转", "结论", "付款", "归档"]) {
    assert.ok(acts.some((x) => x.includes(a)), `应包含「${a}」审计记录`);
  }
});

test("审计：非审计角色进不了审计日志", async () => {
  // V1.2.17 SEC-02：侧栏里根本没有这个入口，接口却还通着「只看本人」——
  // 属于界面上看不见、接口能探到的口子，现在按模块白名单统一 403。
  const r = await exec("GET", "/api/audit");
  assert.equal(r.status, 403, `${r.status} ${JSON.stringify(r.data)}`);
  assert.equal(r.data.error.code, "FORBIDDEN");
});
