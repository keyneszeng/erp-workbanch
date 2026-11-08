"use strict";
/**
 * 滥用与越权测试 —— 注入、IDOR、状态机全枚举、幂等、金额/日期脏数据、并发登录
 */
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { fillMaterials } = require("./helpers/materials");

const PORT = 8803;
const BASE = `http://127.0.0.1:${PORT}`;
const DB = path.join(__dirname, "..", "data", "abuse.db");
let proc;

const cleanDb = () => { for (const f of [DB, DB + "-wal", DB + "-shm"]) if (fs.existsSync(f)) fs.renameSync(f, f + ".old"); };

async function waitHealth(t = 40000) {
  const t0 = Date.now();
  while (Date.now() - t0 < t) {
    try { if ((await fetch(`${BASE}/api/health`)).ok) return; } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("服务启动超时");
}

async function login(u, p = "123456") {
  const r = await fetch(`${BASE}/api/auth/login`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: u, password: p })
  });
  assert.equal(r.status, 200, `${u} 登录失败`);
  return (r.headers.get("set-cookie") || "").split(";")[0];
}

const client = (cookie) => async (method, url, body) => {
  const r = await fetch(BASE + url, {
    method,
    headers: { "Content-Type": "application/json", cookie },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await r.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
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

/* ---------------- 注入 ---------------- */

test("路径穿越：多形态编码均不可读到源码", async () => {
  const paths = [
    "/assets/../server/index.js",
    "/assets/../../server/index.js",
    "/%252e%252e/package.json",
    "/..%5cpackage.json",
    "/assets/%2e%2e/%2e%2e/server/lib/db.js",
    "/index.html%00.js"
  ];
  for (const p of paths) {
    const r = await fetch(BASE + p);
    const body = await r.text();
    assert.notEqual(r.status, 200, `${p} 不应 200`);
    assert.ok(!body.includes("DatabaseSync"), `${p} 不应泄露源码`);
  }
});

test("SQL 注入：搜索参数不放大结果集", async () => {
  const base = await guest("GET", "/api/projects");
  const inj = await guest("GET", "/api/projects?q=" + encodeURIComponent("' OR 1=1 --"));
  assert.equal(inj.status, 200);
  assert.equal(inj.data.rows.length, 0, "注入串不应匹配到任何项目");
  assert.ok(base.data.rows.length >= 0);
  const inj2 = await guest("GET", "/api/projects?status=" + encodeURIComponent("' OR '1'='1"));
  assert.equal(inj2.status, 200);
  assert.equal(inj2.data.rows.length, 0, "status 注入不应返回数据");
});

test("SQL 注入：项目 ID 带注入串返回 404 而非 500", async () => {
  for (const id of ["MP-2026-001' OR '1'='1", "MP-2026-001--", "%27%20OR%201%3D1"]) {
    const r = await guest("GET", `/api/projects/${id}`);
    assert.ok([403, 404].includes(r.status), `${id} 应 403/404，实际 ${r.status}`);
  }
});

/* ---------------- 越权 / IDOR ---------------- */

test("嘉宾不能读取非成员项目详情", async () => {
  const r = await guest("GET", "/api/projects/MP-2026-001");
  assert.equal(r.status, 403);
  assert.equal(r.data.error.code, "FORBIDDEN");
});

test("嘉宾不能立项 / 付款 / 导出 / 核销", async () => {
  const cases = [
    ["POST", "/api/projects", { name: "越权", assoc: "华东医学会", form: "线下", date: "2027-01-01", budget: 1000, owner: "x", agenda: "abcd" }],
    ["POST", "/api/payments", { pid: "MP-2026-002", type: "学会公付", payee: "x", amount: 100 , payee_bank: "中国银行北京分行", payee_account: "3210987654321098"}],
    ["GET", "/api/export/projects", undefined],
    ["POST", "/api/projects/MP-2026-002/verify/steps/1", { result: "通过" }]
  ];
  for (const [m, u, b] of cases) {
    const r = await guest(m, u, b);
    assert.equal(r.status, 403, `${m} ${u} 应 403，实际 ${r.status}`);
  }
});

test("会务执行不能改角色 / 建账号", async () => {
  const me = await exec("GET", "/api/auth/me");
  const r1 = await exec("PATCH", `/api/users/${me.data.user.id}`, { role: "admin" });
  assert.equal(r1.status, 403);
  const r2 = await exec("POST", "/api/users", { username: "hacker", name: "h", role: "admin" });
  assert.equal(r2.status, 403);
});

test("协会管理员不能创建总管理员账号", async () => {
  const r = await assoc("POST", "/api/users", { username: "newadmin", name: "新管理员", role: "admin" });
  assert.equal(r.status, 403);
});

test("非成员不能给项目加成员", async () => {
  const r = await finance("POST", "/api/projects/MP-2026-003/members", { user_id: 1 });
  assert.ok([403].includes(r.status), `应 403，实际 ${r.status}`);
});

test("伪造 / 篡改会话 Cookie 一律 401", async () => {
  for (const c of ["erp_sid=" + "a".repeat(64), "erp_sid=", "erp_sid=../../etc/passwd"]) {
    const r = await client(c)("GET", "/api/projects");
    assert.equal(r.status, 401, `${c.slice(0, 20)} 应 401`);
  }
});

/* ---------------- 状态机全枚举 ---------------- */

const ALL_ACTIONS = ["submit", "approve", "prep", "exec", "request_verify", "verify_pass", "settle", "archive"];

test("状态机：草稿项目除 submit 外全部动作被拒", async () => {
  const c = await assoc("POST", "/api/projects", {
    name: "状态机枚举-草稿", assoc: "华东医学会", form: "线下", date: "2027-06-01",
    budget: 30000, owner: "王敏", agenda: "09:00 开幕"
  });
  assert.equal(c.status, 200);
  const pid = c.data.project.id;
  for (const a of ALL_ACTIONS.filter((x) => x !== "submit")) {
    const r = await assoc("POST", `/api/projects/${pid}/transition`, { action: a });
    assert.equal(r.status, 409, `草稿状态 ${a} 应 409，实际 ${r.status}`);
    assert.equal(r.data.error.code, "ILLEGAL_TRANSITION", `${a} 错误码`);
  }
});

test("状态机：待审批项目除 approve/reject 外全部动作被拒", async () => {
  const c = await assoc("POST", "/api/projects", {
    name: "状态机枚举-待审批", assoc: "华东医学会", form: "线下", date: "2027-06-02",
    budget: 30000, owner: "王敏", agenda: "09:00 开幕"
  });
  const pid = c.data.project.id;
  await assoc("POST", `/api/projects/${pid}/transition`, { action: "submit" });
  for (const a of ALL_ACTIONS.filter((x) => !["approve"].includes(x))) {
    const r = await assoc("POST", `/api/projects/${pid}/transition`, { action: a });
    assert.equal(r.status, 409, `待审批状态 ${a} 应 409，实际 ${r.status}`);
  }
  const rj = await assoc("POST", `/api/projects/${pid}/transition`, { action: "reject" });
  assert.equal(rj.status, 400, "驳回未填理由应 400");
  const rj2 = await assoc("POST", `/api/projects/${pid}/transition`, { action: "reject", comment: "预算依据不足" });
  assert.equal(rj2.status, 200);
});

test("未知流转动作返回 409 并列出可执行动作", async () => {
  const r = await admin("POST", "/api/projects/MP-2026-002/transition", { action: "fly_to_moon" });
  assert.equal(r.status, 409);
  assert.equal(r.data.error.code, "ILLEGAL_TRANSITION");
  assert.ok(Array.isArray(r.data.error.detail.allowed));
});

/* ---------------- 幂等 ---------------- */

test("幂等：同一付款单重复审批 / 重复付款被拒", async () => {
  const c = await finance("POST", "/api/payments", {
    pid: "MP-2026-008", type: "学会公付", payee: "幂等测试", amount: 200
  , payee_bank: "中国银行北京分行", payee_account: "3210987654321098"});
  assert.equal(c.status, 200);
  const id = c.data.payment.id;
  const a1 = await finance("POST", `/api/payments/${id}/approve`, { approve: true });
  assert.equal(a1.status, 200);
  const a2 = await finance("POST", `/api/payments/${id}/approve`, { approve: true });
  assert.equal(a2.status, 409, "重复审批应 409");
  const p1 = await finance("POST", `/api/payments/${id}/pay`, {});
  assert.equal(p1.status, 200);
  const p2 = await finance("POST", `/api/payments/${id}/pay`, {});
  assert.equal(p2.status, 409, "重复付款应 409");
});

test("幂等：重复结算 / 重复归档被拒", async () => {
  const c = await assoc("POST", "/api/projects", {
    name: "幂等-结算归档", assoc: "华东医学会", form: "线下", date: "2027-06-03",
    budget: 50000, owner: "王敏", agenda: "09:00 开幕"
  });
  const pid = c.data.project.id;
  const users = await assoc("GET", "/api/users/pickable");
  for (const nm of ["张伟", "陈静"]) {
    const u = users.data.rows.find((x) => x.name === nm);
    await assoc("POST", `/api/projects/${pid}/members`, { user_id: u.id });
  }
  await fillMaterials(assoc, pid); // V1.2.19 核销前置：材料 8 类
  for (const a of ["submit", "approve", "prep", "exec", "request_verify"]) {
    const r = await assoc("POST", `/api/projects/${pid}/transition`, { action: a });
    assert.equal(r.status, 200, `${a} 失败`);
  }
  for (let no = 1; no <= 6; no++) {
    await exec("POST", `/api/projects/${pid}/verify/steps/${no}`, { result: "通过" });
  }
  assert.equal((await finance("POST", `/api/projects/${pid}/transition`, { action: "verify_pass" })).status, 200);
  assert.equal((await finance("POST", `/api/projects/${pid}/transition`, { action: "settle", payee_bank: "中国银行北京分行", payee_account: "3210987654321098" })).status, 200);
  const s2 = await finance("POST", `/api/projects/${pid}/transition`, { action: "settle", payee_bank: "中国银行北京分行", payee_account: "3210987654321098" });
  assert.equal(s2.status, 409, "重复结算应 409");

  const kinds = (await admin("GET", "/api/meta")).data.materialKinds;
  for (const k of kinds) {
    await admin("POST", `/api/projects/${pid}/materials`, { kind: k, name: `${k}样例` });
  }
  const ar = await finance("POST", `/api/projects/${pid}/transition`, { action: "archive" });
  assert.equal(ar.status, 200, "材料齐备后应可归档：" + JSON.stringify(ar.data));
  const ar2 = await finance("POST", `/api/projects/${pid}/transition`, { action: "archive" });
  assert.equal(ar2.status, 409, "重复归档应 409");
});

/* ---------------- 脏数据 ---------------- */

test("金额脏数据：字符串 / 空 / 三位小数被拒", async () => {
  const cases = [
    { amount: "abc" }, { amount: null }, { amount: "" }, { amount: 0.001 }, { amount: -1 }
  ];
  for (const c of cases) {
    const r = await finance("POST", "/api/payments", {
      pid: "MP-2026-008", type: "学会公付", payee: "脏数据", ...c
    , payee_bank: "中国银行北京分行", payee_account: "3210987654321098"});
    assert.equal(r.status, 400, `${JSON.stringify(c)} 应 400，实际 ${r.status}`);
  }
});

test("金额上限：单笔超 10 亿被拒", async () => {
  const r = await admin("POST", "/api/payments", {
    pid: "MP-2026-008", type: "学会公付", payee: "巨额", amount: 2e9, force: true
  , payee_bank: "中国银行北京分行", payee_account: "3210987654321098"});
  assert.equal(r.status, 400);
});

test("日期脏数据：不存在的日期被拒", async () => {
  for (const date of ["2026-02-30", "2026-13-01", "2026-00-10", "2026-04-31"]) {
    const r = await assoc("POST", "/api/projects", {
      name: "日期脏数据", assoc: "华东医学会", form: "线下", date,
      budget: 1000, owner: "王敏", agenda: "09:00 开幕"
    });
    assert.equal(r.status, 400, `${date} 应 400，实际 ${r.status}`);
  }
});

test("人数 / 会期必须为整数", async () => {
  const base = { name: "整数校验", assoc: "华东医学会", form: "线下", date: "2027-07-01", budget: 1000, owner: "王敏", agenda: "09:00 开幕" };
  for (const patch of [{ people: 3.5 }, { people: -1 }, { days: 1.5 }, { days: 0 }, { days: 61 }]) {
    const r = await assoc("POST", "/api/projects", { ...base, ...patch });
    assert.equal(r.status, 400, `${JSON.stringify(patch)} 应 400，实际 ${r.status}`);
  }
});

/* ---------------- 会话 ---------------- */

test("同账号多端登录互不影响，退出仅失效当前会话", async () => {
  const c1 = await login("exec");
  const c2 = await login("exec");
  assert.notEqual(c1, c2, "两次登录应得到不同会话");
  assert.equal((await client(c1)("GET", "/api/auth/me")).data.user.username, "exec");
  assert.equal((await client(c2)("GET", "/api/auth/me")).data.user.username, "exec");
  const out = await client(c1)("POST", "/api/auth/logout", {});
  assert.equal(out.status, 200);
  assert.equal((await client(c1)("GET", "/api/auth/me")).data.user, null, "已退出会话应失效");
  assert.equal((await client(c2)("GET", "/api/auth/me")).data.user.username, "exec", "另一会话应仍有效");
});

/* ---------------- 导出范围 ---------------- */

test("导出范围与列表口径一致（嘉宾 / 协会）", async () => {
  for (const [name, c] of [["assoc", assoc]]) {
    const list = await c("GET", "/api/projects");
    const r = await fetch(`${BASE}/api/export/projects`, { headers: { cookie: await login(name) } });
    assert.equal(r.status, 200);
    const text = Buffer.from(await r.arrayBuffer()).toString("utf8");
    const records = text.split("\r\n").filter((l) => l.startsWith('"MP-')).length;
    assert.equal(records, list.data.total, `${name} 导出行数应与列表一致`);
  }
  const g = await guest("GET", "/api/export/projects");
  assert.equal(g.status, 403);
});

/* ---------------- 协议健壮性 ---------------- */

test("方法不对返回 405 + Allow，路径不存在才 404", async () => {
  // V1.2.17 API-01：路径在、方法不对 → 405（原来一律 404，客户端会去怀疑地址写错）
  const r1 = await admin("PUT", "/api/projects", {});
  assert.equal(r1.status, 405, `${r1.status} ${JSON.stringify(r1.data)}`);
  assert.equal(r1.data.error.code, "METHOD_NOT_ALLOWED");
  const r2 = await admin("GET", "/api/not-exist");
  assert.equal(r2.status, 404);
  assert.equal(r2.data.error.code, "NO_ROUTE");
});

test("POST 无 Content-Type 仍可解析 JSON", async () => {
  const r = await fetch(`${BASE}/api/auth/login`, {
    method: "POST", body: JSON.stringify({ username: "admin", password: "123456" })
  });
  assert.equal(r.status, 200, "无 Content-Type 时应回退为 JSON 解析");
});

test("并发 20 次只读请求全部成功", async () => {
  const rs = await Promise.all(Array.from({ length: 20 }, () => admin("GET", "/api/dashboard")));
  assert.equal(rs.filter((r) => r.status === 200).length, 20);
});

/* ---------------- 封账 / 封存 ---------------- */

test("已结算项目不得再新增付款（账目已封账）", async () => {
  const r = await admin("POST", "/api/payments", {
    pid: "MP-2026-016", type: "学会公付", payee: "封账测试", amount: 100, force: true
  , payee_bank: "中国银行北京分行", payee_account: "3210987654321098"});
  assert.equal(r.status, 409, "已结算项目新增付款应 409");
  assert.equal(r.data.error.code, "SETTLED");
});

test("已归档项目不得录合同 / 登记材料", async () => {
  const c = await admin("POST", "/api/contracts", {
    pid: "MP-2026-007", name: "归档后合同", vendor: "测试方", amount: 1000
  });
  assert.equal(c.status, 409, "已归档项目录合同应 409");
  assert.equal(c.data.error.code, "ARCHIVED");
  const m = await admin("POST", "/api/projects/MP-2026-007/materials", { kind: "合同协议", name: "归档后材料" });
  assert.equal(m.status, 409, "已归档项目登记材料应 409");
});

test("已结算 / 已归档项目不得再提交例外单", async () => {
  for (const pid of ["MP-2026-016", "MP-2026-007"]) {
    const r = await admin("POST", `/api/projects/${pid}/exceptions`, { step_no: 1, reason: "封存后补录" });
    assert.equal(r.status, 409, `${pid} 提交例外单应 409，实际 ${r.status}`);
  }
});

test("健康检查不泄露数据库路径等内部信息", async () => {
  const r = await fetch(`${BASE}/api/health`);
  const body = await r.text();
  assert.equal(r.status, 200);
  assert.ok(!body.includes("/"), "健康检查不应返回文件路径：" + body);
});

test("导出记录仅可导出角色可见", async () => {
  const g = await guest("GET", "/api/exports");
  assert.equal(g.status, 403);
  const a = await assoc("GET", "/api/exports");
  assert.equal(a.status, 200);
});
