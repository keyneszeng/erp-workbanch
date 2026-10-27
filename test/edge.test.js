"use strict";
/**
 * 边界与安全回归 —— 越权、隐私、非法输入、重复操作、归档后付款等
 * 运行：node --experimental-sqlite --test test/edge.test.js
 */
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const PORT = 8800;
const BASE = `http://127.0.0.1:${PORT}`;
const DB = path.join(__dirname, "..", "data", "edge.db");
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
  return (r.headers.get("set-cookie") || "").split(";")[0];
}

const client = (cookie) => async (method, url, body) => {
  const r = await fetch(BASE + url, {
    method,
    headers: { "Content-Type": "application/json", cookie },
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await r.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  return { status: r.status, data };
};

let admin, assoc, exec, finance, guest;

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
  admin = client(await login("admin"));
  assoc = client(await login("assoc"));
  exec = client(await login("exec"));
  finance = client(await login("finance"));
  guest = client(await login("guest"));
});

after(() => proc && proc.kill("SIGTERM"));

/* ---------------- 越权与隐私 ---------------- */
test("IDOR：嘉宾直接访问未授权项目详情被拒", async () => {
  const r = await guest("GET", "/api/projects/MP-2026-003");
  assert.equal(r.status, 403);
});

test("IDOR：嘉宾直接访问未授权项目核销页被拒", async () => {
  const r = await guest("GET", "/api/projects/MP-2026-003/verify");
  assert.equal(r.status, 403);
});

test("隐私：普通用户拿不到全员手机号", async () => {
  const r = await guest("GET", "/api/users");
  assert.equal(r.status, 200);
  const leaked = r.data.rows.some((u) => u.phone);
  assert.equal(leaked, false, "嘉宾不应看到其他账号手机号");
});

test("隐私：接口不返回口令散列", async () => {
  const r = await admin("GET", "/api/users");
  const raw = JSON.stringify(r.data);
  assert.ok(!raw.includes("pass_hash"), "不应返回 pass_hash");
  assert.ok(!raw.includes("pass_salt"), "不应返回 pass_salt");
});

/* ---------------- 非法输入 ---------------- */
test("校验：人数为负数被拒", async () => {
  const r = await assoc("POST", "/api/projects", {
    name: "负数人数", assoc: "华东医学会", form: "线下", date: "2026-12-01",
    budget: 1000, people: -5, owner: "王敏", agenda: "09:00 开幕"
  });
  assert.equal(r.status, 400);
});

test("校验：会期 0 天被拒", async () => {
  const r = await assoc("POST", "/api/projects", {
    name: "零会期", assoc: "华东医学会", form: "线下", date: "2026-12-01",
    budget: 1000, days: 0, owner: "王敏", agenda: "09:00 开幕"
  });
  assert.equal(r.status, 400);
});

test("校验：日期格式非法被拒", async () => {
  const r = await assoc("POST", "/api/projects", {
    name: "坏日期", assoc: "华东医学会", form: "线下", date: "2026/12/01",
    budget: 1000, owner: "王敏", agenda: "09:00 开幕"
  });
  assert.equal(r.status, 400);
});

test("校验：协会不在枚举内被拒", async () => {
  const r = await assoc("POST", "/api/projects", {
    name: "野协会", assoc: "不存在协会", form: "线下", date: "2026-12-01",
    budget: 1000, owner: "王敏", agenda: "09:00 开幕"
  });
  assert.equal(r.status, 400);
});

test("校验：合同金额 0 被拒", async () => {
  const r = await assoc("POST", "/api/contracts", { pid: "MP-2026-001", name: "零元合同", vendor: "某方", amount: 0 });
  assert.equal(r.status, 400);
});

test("校验：核销步骤号越界被拒", async () => {
  const r = await finance("POST", "/api/projects/MP-2026-003/verify/steps/7", { result: "通过" });
  assert.equal(r.status, 400);
});

test("校验：判定结果枚举非法被拒", async () => {
  const r = await finance("POST", "/api/projects/MP-2026-003/verify/steps/1", { result: "差不多通过" });
  assert.equal(r.status, 400);
});

test("校验：账号重复被拒", async () => {
  const r = await admin("POST", "/api/users", { username: "assoc", name: "重复", role: "exec" });
  assert.equal(r.status, 409);
});

test("校验：角色非法被拒", async () => {
  const r = await admin("POST", "/api/users", { username: "newguy", name: "新人", role: "god" });
  assert.equal(r.status, 400);
});

/* ---------------- 重复与状态机 ---------------- */
test("重复操作：付款单不能重复审批", async () => {
  const list = await finance("GET", "/api/payments?status=待审批");
  const y = list.data.rows.find((x) => x.pid === "MP-2026-003");
  assert.ok(y, "应有待审批付款单");
  const a1 = await finance("POST", `/api/payments/${y.id}/approve`, { approve: true });
  assert.equal(a1.status, 200);
  const a2 = await finance("POST", `/api/payments/${y.id}/approve`, { approve: true });
  assert.equal(a2.status, 409);
});

test("重复操作：未审批的付款单不能直接付款", async () => {
  const list = await finance("GET", "/api/payments?status=待审批");
  const y = list.data.rows[0];
  if (!y) return;
  const r = await finance("POST", `/api/payments/${y.id}/pay`, {});
  assert.equal(r.status, 409);
});

test("驳回：立项驳回必须写理由", async () => {
  const r = await assoc("POST", "/api/projects/MP-2026-013/transition", { action: "reject", comment: "" });
  assert.equal(r.status, 400);
});

test("驳回：立项驳回后退回草稿，可再次提交", async () => {
  const r = await assoc("POST", "/api/projects/MP-2026-013/transition", { action: "reject", comment: "预算依据不足" });
  assert.equal(r.status, 200);
  assert.equal(r.data.project.status, "草稿");
  const again = await assoc("POST", "/api/projects/MP-2026-013/transition", { action: "submit" });
  assert.equal(again.status, 200);
  assert.equal(again.data.project.status, "待审批");
});

test("归档后不得新增付款", async () => {
  const r = await admin("POST", "/api/payments", {
    pid: "MP-2026-007", type: "学会公付", payee: "归档后付款测试", amount: 100
  });
  assert.equal(r.status, 409, "已归档项目不应再允许新增付款");
});

test("存在未完成付款时不得结算", async () => {
  // MP-2026-017 已核销；先制造一张待审批付款
  const p = await finance("POST", "/api/payments", {
    pid: "MP-2026-017", type: "学会公付", payee: "结算前待审批", amount: 500
  });
  assert.equal(p.status, 200);
  const s = await finance("POST", "/api/projects/MP-2026-017/transition", { action: "settle" });
  assert.equal(s.status, 409, "有未完成付款时不应允许结算");
});

test("管理员不能停用自己", async () => {
  const me = await admin("GET", "/api/auth/me");
  const r = await admin("PATCH", `/api/users/${me.data.user.id}`, { active: 0 });
  assert.equal(r.status, 400, "不应允许停用当前登录账号");
});

/* ---------------- 路由与会话 ---------------- */
test("未知接口返回结构化 404", async () => {
  const r = await admin("GET", "/api/nope");
  assert.equal(r.status, 404);
  assert.equal(r.data.error.code, "NO_ROUTE");
});

test("不存在的项目返回 404", async () => {
  const r = await admin("GET", "/api/projects/MP-9999-999");
  assert.equal(r.status, 404);
});

test("伪造会话 Cookie 被拒", async () => {
  const r = await client("erp_sid=deadbeef")("GET", "/api/projects");
  assert.equal(r.status, 401);
});

test("登出后原 Cookie 立即失效", async () => {
  const c = await login("exec");
  const api = client(c);
  assert.equal((await api("GET", "/api/auth/me")).data.user.username, "exec");
  await api("POST", "/api/auth/logout", {});
  const r = await api("GET", "/api/auth/me");
  assert.equal(r.data.user, null);
});

test("普通用户不能导出", async () => {
  const r = await guest("GET", "/api/export/projects");
  assert.equal(r.status, 403);
});

test("登录失败不泄露账号是否存在", async () => {
  const a = await fetch(`${BASE}/api/auth/login`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "nobody", password: "x" })
  });
  const b = await fetch(`${BASE}/api/auth/login`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "admin", password: "wrong" })
  });
  assert.equal(a.status, b.status);
  const am = (await a.json()).error.message;
  const bm = (await b.json()).error.message;
  assert.equal(am, bm, "两种失败应返回同一文案");
});
