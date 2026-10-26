"use strict";
/**
 * 自助修改密码回归
 * 运行：node --test test/password.test.js
 */
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const PORT = 8806;
const BASE = `http://127.0.0.1:${PORT}`;
const DB = path.join(__dirname, "..", "data", "test6.db");
let proc;

const U = "pwdtest";
const P0 = "Init1234";
const P1 = "Changed9876";

function cleanDb() {
  for (const f of [DB, DB + "-wal", DB + "-shm"]) if (fs.existsSync(f)) fs.unlinkSync(f);
}
async function waitHealth(timeout = 15000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    try { const r = await fetch(`${BASE}/api/health`); if (r.ok) return; } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("测试服务启动超时");
}
async function login(username, password) {
  const r = await fetch(`${BASE}/api/auth/login`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password })
  });
  const text = await r.text();
  let data = null; try { data = JSON.parse(text); } catch { data = text; }
  return { status: r.status, data, cookie: (r.headers.get("set-cookie") || "").split(";")[0] };
}
function client(cookie) {
  return async (method, url, body) => {
    const r = await fetch(BASE + url, {
      method, headers: { "Content-Type": "application/json", cookie },
      body: body ? JSON.stringify(body) : undefined
    });
    const text = await r.text();
    let data = null; try { data = JSON.parse(text); } catch { data = text; }
    return { status: r.status, data, setCookie: r.headers.get("set-cookie") };
  };
}

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

  // 用总管理员建一个专用测试账号，避免污染种子账号
  const admin = client((await login("admin", "123456")).cookie);
  const r = await admin("POST", "/api/users", { username: U, name: "改密测试", role: "user", password: P0 });
  assert.equal(r.status, 200, `创建测试账号失败：${JSON.stringify(r.data)}`);
});
after(() => { if (proc) proc.kill("SIGTERM"); });

test("未登录不能改密", async () => {
  const r = await client("")("POST", "/api/auth/password", { oldPassword: P0, newPassword: P1 });
  assert.equal(r.status, 401);
});

test("原密码错误被拒绝", async () => {
  const c = client((await login(U, P0)).cookie);
  const r = await c("POST", "/api/auth/password", { oldPassword: "Wrong1234", newPassword: P1 });
  assert.equal(r.status, 400);
  assert.match(r.data.error.message, /原密码/);
});

test("新密码规则校验：过短 / 纯数字 / 纯字母 / 弱口令 / 与原密码相同", async () => {
  const c = client((await login(U, P0)).cookie);
  const cases = [
    ["Ab1", /至少 8 位/],
    ["12345678", /字母和数字|常见/],
    ["abcdefgh", /字母和数字/],
    ["password1", /常见/],
    [P0, /不能与原密码相同/]
  ];
  for (const [pwd, rx] of cases) {
    const r = await c("POST", "/api/auth/password", { oldPassword: P0, newPassword: pwd });
    assert.equal(r.status, 400, `${pwd} 应被拒绝，实际 ${r.status}`);
    assert.match(r.data.error.message, rx, `${pwd} 的提示应匹配 ${rx}`);
  }
});

test("两次输入不一致被拒绝", async () => {
  const c = client((await login(U, P0)).cookie);
  const r = await c("POST", "/api/auth/password", { oldPassword: P0, newPassword: P1, confirmPassword: "Other1234" });
  assert.equal(r.status, 400);
  assert.match(r.data.error.message, /不一致/);
});

test("改密成功：旧密码失效、新密码可登录、旧令牌被吊销", async () => {
  const oldSess = await login(U, P0);
  const oldCookie = oldSess.cookie;
  const c = client(oldCookie);

  const r = await c("POST", "/api/auth/password", { oldPassword: P0, newPassword: P1, confirmPassword: P1 });
  assert.equal(r.status, 200, `改密应成功，实际 ${r.status} ${JSON.stringify(r.data)}`);
  assert.ok(r.setCookie, "应重新下发会话 Cookie");

  // 旧密码不能登录
  const bad = await login(U, P0);
  assert.equal(bad.status, 401, "旧密码应已失效");

  // 新密码可以登录
  const good = await login(U, P1);
  assert.equal(good.status, 200, "新密码应可登录");

  // 旧令牌（改密前签发）必须失效：token_ver 已 +1
  const stale = await client(oldCookie)("GET", "/api/auth/me");
  assert.equal(stale.data.user, null, "改密前的旧令牌应失效");

  // 改密返回的新 Cookie 仍然可用
  const fresh = await client((r.setCookie || "").split(";")[0])("GET", "/api/auth/me");
  assert.equal(fresh.data.user?.username, U, "改密后当前会话应保持登录");
});

test("改密写入审计日志", async () => {
  const admin = client((await login("admin", "123456")).cookie);
  const r = await admin("GET", `/api/audit?q=${U}`);
  assert.equal(r.status, 200);
  const hit = (r.data.rows || []).find((x) => x.action === "修改密码" && x.target === U);
  assert.ok(hit, "审计日志应记录本次改密");
});
