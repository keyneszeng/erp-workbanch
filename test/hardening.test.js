"use strict";
/**
 * 加固测试 —— 静态资源安全、协议边界、会话生命周期、CSV 注入、并发一致性、字段长度
 */
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const PORT = 8802;
const BASE = `http://127.0.0.1:${PORT}`;
const DB = path.join(__dirname, "..", "data", "hard.db");
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

const client = (cookie) => async (method, url, body, headers = {}) => {
  const r = await fetch(BASE + url, {
    method,
    headers: { "Content-Type": "application/json", cookie, ...headers },
    body: body === undefined ? undefined : (typeof body === "string" ? body : JSON.stringify(body))
  });
  const text = await r.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  return { status: r.status, data, headers: r.headers };
};

let admin, assoc, finance, exec;

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
  finance = client(await login("finance"));
  exec = client(await login("exec"));
});

after(() => proc && proc.kill("SIGTERM"));

/* ---------------- 静态资源与路径穿越 ---------------- */
test("静态资源不能读到 web 根之外的文件", async () => {
  for (const p of ["/package.json", "/server/index.js", "/data/erp.db", "/../package.json", "/%2e%2e/package.json", "/..%2fpackage.json"]) {
    const r = await fetch(BASE + p);
    assert.notEqual(r.status, 200, `${p} 不应可访问（${r.status}）`);
  }
});

test("HEAD 请求不返回 500", async () => {
  const r = await fetch(BASE + "/api/health", { method: "HEAD" });
  assert.ok(r.status < 500, `HEAD 返回 ${r.status}`);
});

/* ---------------- 协议边界 ---------------- */
test("畸形 JSON 不导致 500", async () => {
  const r = await fetch(`${BASE}/api/auth/login`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: "{bad json"
  });
  assert.ok(r.status < 500, `应返回 4xx，实际 ${r.status}`);
});

test("超大请求体返回 413 而非 500", async () => {
  const big = "x".repeat(3 * 1024 * 1024);
  const r = await fetch(`${BASE}/api/projects`, {
    method: "POST",
    headers: { "Content-Type": "application/json", cookie: await login("assoc") },
    body: JSON.stringify({ name: big })
  });
  assert.equal(r.status, 413, `超大请求体应 413，实际 ${r.status}`);
});

test("Unicode / emoji 项目名可正确存取", async () => {
  const name = "国际会议 🎉 Ünïcode テスト";
  const c = await assoc("POST", "/api/projects", {
    name, assoc: "华东医学会", form: "线下", date: "2027-02-01",
    budget: 5000, owner: "王敏", agenda: "09:00 开幕", people: 10
  });
  assert.equal(c.status, 200);
  const d = await assoc("GET", `/api/projects/${c.data.project.id}`);
  assert.equal(d.data.project.name, name);
});

test("超长项目名（>80 字）被拒", async () => {
  const r = await assoc("POST", "/api/projects", {
    name: "长".repeat(81), assoc: "华东医学会", form: "线下", date: "2027-02-01",
    budget: 5000, owner: "王敏", agenda: "09:00 开幕"
  });
  assert.equal(r.status, 400);
});

test("超长议程（>2000 字）被拒", async () => {
  const r = await assoc("POST", "/api/projects", {
    name: "议程超长", assoc: "华东医学会", form: "线下", date: "2027-02-01",
    budget: 5000, owner: "王敏", agenda: "议".repeat(2001)
  });
  assert.equal(r.status, 400);
});

/* ---------------- 会话生命周期 ---------------- */
test("会话过期后接口返回 401", async () => {
  const c = await login("exec");
  const { DatabaseSync } = require("node:sqlite");
  const db = new DatabaseSync(DB);
  db.prepare("UPDATE sessions SET expires_at = ? WHERE token = ?")
    .run(new Date(Date.now() - 1000).toISOString(), c.replace("erp_sid=", ""));
  db.close();
  const r = await client(c)("GET", "/api/auth/me");
  assert.equal(r.data.user, null, "过期会话不应再返回用户");
});

test("重置密码后旧会话失效", async () => {
  const oldCookie = await login("zhoutao");
  const me = await admin("GET", "/api/users");
  const u = me.data.rows.find((x) => x.username === "zhoutao");
  const r = await admin("PATCH", `/api/users/${u.id}`, { password: "newpass123" });
  assert.equal(r.status, 200);
  const after = await client(oldCookie)("GET", "/api/auth/me");
  assert.equal(after.data.user, null, "改密后旧会话应失效");
  // 新密码可登录
  const c2 = await login("zhoutao", "newpass123");
  assert.ok(c2);
});

test("登录 Cookie 带 HttpOnly 与 SameSite", async () => {
  const r = await fetch(`${BASE}/api/auth/login`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "exec", password: "123456" })
  });
  const sc = r.headers.get("set-cookie") || "";
  assert.match(sc, /HttpOnly/i);
  assert.match(sc, /SameSite=Lax/i);
});

/* ---------------- CSV ---------------- */
test("CSV：逗号、引号、换行正确转义", async () => {
  const name = '含,逗号 "引号" 与\n换行';
  await assoc("POST", "/api/projects", {
    name, assoc: "华东医学会", form: "线下", date: "2027-03-01",
    budget: 6000, owner: "王敏", agenda: "09:00 开幕"
  });
  const r = await fetch(`${BASE}/api/export/projects`, { headers: { cookie: await login("assoc") } });
  const text = Buffer.from(await r.arrayBuffer()).toString("utf8");
  assert.ok(text.includes('""引号""'), "双引号应被转义为两个双引号");
  // 引号内的换行不应被当作记录分隔符：以 "MP- 开头的物理行数应等于接口返回的项目数
  const total = (await assoc("GET", "/api/projects")).data.total;
  const records = text.split("\r\n").filter((l) => l.startsWith('"MP-')).length;
  assert.equal(records, total, `引号内换行不应产生多余记录（${records} vs ${total}）`);
});

test("CSV：公式注入被中和", async () => {
  await assoc("POST", "/api/projects", {
    name: '=HYPERLINK("http://evil","click")', assoc: "华东医学会", form: "线下",
    date: "2027-03-02", budget: 7000, owner: "王敏", agenda: "09:00 开幕"
  });
  const r = await fetch(`${BASE}/api/export/projects`, { headers: { cookie: await login("assoc") } });
  const text = Buffer.from(await r.arrayBuffer()).toString("utf8");
  const line = text.split("\r\n").find((l) => l.includes("HYPERLINK"));
  assert.ok(line, "应能在导出中找到该行");
  assert.ok(line.includes("\"'=HYPERLINK"), "以 = 开头的值应加单引号前缀，实际：" + line.slice(0, 40));
});

/* ---------------- 预算与金额 ---------------- */
test("超预算付款被拦截，总管理员可特批", async () => {
  // MP-2026-008 预算 72000，已付 3600
  const over = await finance("POST", "/api/payments", {
    pid: "MP-2026-008", type: "学会公付", payee: "超预算测试", amount: 80000
  });
  assert.equal(over.status, 409);
  assert.equal(over.data.error.code, "OVER_BUDGET");

  const forced = await admin("POST", "/api/payments", {
    pid: "MP-2026-008", type: "学会公付", payee: "超预算测试", amount: 80000, force: true
  });
  assert.equal(forced.status, 200, "总管理员 force 应放行");
});

test("付款金额为负或 0 被拒", async () => {
  for (const amount of [0, -100]) {
    const r = await finance("POST", "/api/payments", {
      pid: "MP-2026-008", type: "学会公付", payee: "x", amount
    });
    assert.equal(r.status, 400, `金额 ${amount} 应被拒`);
  }
});

/* ---------------- 字段长度 ---------------- */
test("核销备注超长（>1000）被拒", async () => {
  const r = await finance("POST", "/api/projects/MP-2026-003/verify/steps/1", {
    result: "通过", remark: "长".repeat(1001)
  });
  assert.equal(r.status, 400);
});

test("例外原因超长（>500）被拒", async () => {
  const r = await assoc("POST", "/api/projects/MP-2026-001/exceptions", {
    step_no: 1, reason: "因".repeat(501)
  });
  assert.equal(r.status, 400);
});

/* ---------------- 并发一致性 ---------------- */
async function buildVerifyProject(tag) {
  const c = await assoc("POST", "/api/projects", {
    name: `并发测试-${tag}`, assoc: "华东医学会", form: "线下", date: "2027-04-01",
    budget: 90000, owner: "王敏", agenda: "09:00 开幕 / 10:00 报告", people: 30
  });
  const pid = c.data.project.id;
  const users = await assoc("GET", "/api/users");
  for (const nm of ["张伟", "陈静"]) {
    const u = users.data.rows.find((x) => x.name === nm);
    await assoc("POST", `/api/projects/${pid}/members`, { user_id: u.id });
  }
  for (const a of ["submit", "approve", "prep", "exec", "request_verify"]) {
    const r = await assoc("POST", `/api/projects/${pid}/transition`, { action: a });
    assert.equal(r.status, 200, `${a} 失败`);
  }
  for (let no = 1; no <= 6; no++) {
    const r = await exec("POST", `/api/projects/${pid}/verify/steps/${no}`, { result: "通过" });
    assert.equal(r.status, 200, `第 ${no} 步失败`);
  }
  return pid;
}

test("并发：6 次同时提交立项，只有 1 次成功", async () => {
  const c = await assoc("POST", "/api/projects", {
    name: "并发提交测试", assoc: "华东医学会", form: "线下", date: "2027-05-01",
    budget: 20000, owner: "王敏", agenda: "09:00 开幕"
  });
  const pid = c.data.project.id;
  const rs = await Promise.all(Array.from({ length: 6 }, () =>
    assoc("POST", `/api/projects/${pid}/transition`, { action: "submit" })));
  const ok = rs.filter((r) => r.status === 200);
  assert.equal(ok.length, 1, `应只有 1 次成功，实际 ${ok.length}：${rs.map((r) => r.status).join(",")}`);
});

test("并发：8 次同时核销通过，只有 1 次成功", async () => {
  const pid = await buildVerifyProject("pass");
  const rs = await Promise.all(Array.from({ length: 8 }, () =>
    finance("POST", `/api/projects/${pid}/transition`, { action: "verify_pass" })));
  const ok = rs.filter((r) => r.status === 200);
  assert.equal(ok.length, 1, `应只有 1 次成功，实际 ${ok.length}：${rs.map((r) => r.status).join(",")}`);
});

test("并发：8 次同时结算，只生成 1 张结算单", async () => {
  const pid = await buildVerifyProject("settle");
  const pass = await finance("POST", `/api/projects/${pid}/transition`, { action: "verify_pass" });
  assert.equal(pass.status, 200);
  const rs = await Promise.all(Array.from({ length: 8 }, () =>
    finance("POST", `/api/projects/${pid}/transition`, { action: "settle" })));
  const ok = rs.filter((r) => r.status === 200);
  assert.equal(ok.length, 1, `应只有 1 次成功，实际 ${ok.length}`);
  const st = await finance("GET", "/api/settlements");
  assert.equal(st.data.rows.filter((s) => s.pid === pid).length, 1, "结算单不应重复");
});
