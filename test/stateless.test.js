"use strict";
/**
 * 无状态会话兜底测试 —— 模拟 Serverless「请求落到另一个实例」的场景。
 *
 * 线上每个实例的 /tmp 独立，会话表在别的实例里查不到。
 * 开启 ERP_SESSION_FALLBACK=1 后，令牌自带 HMAC 签名，换实例仍可识别；
 * 同时必须保证：伪造签名、改密吊销仍然有效。
 */
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");

const PORT = 8803;
const BASE = `http://127.0.0.1:${PORT}`;
const DB = path.join(__dirname, "..", "data", "stateless.db");
let proc;

const cleanDb = () => { for (const f of [DB, DB + "-wal", DB + "-shm"]) if (fs.existsSync(f)) fs.unlinkSync(f); };

async function waitHealth(t = 15000) {
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

const get = async (cookie, url) => {
  const r = await fetch(BASE + url, { headers: { cookie } });
  return r.status;
};

/** 模拟「另一个实例」：本实例会话表里没有这条记录 */
function wipeSessions() {
  const db = new DatabaseSync(DB);
  db.exec("DELETE FROM sessions");
  db.close();
}

before(async () => {
  cleanDb();
  proc = spawn(process.execPath, ["--experimental-sqlite", "server/index.js"], {
    cwd: path.join(__dirname, ".."),
    env: { ...process.env, ERP_PORT: String(PORT), ERP_DB: DB, ERP_SESSION_FALLBACK: "1" },
    stdio: ["ignore", "pipe", "pipe"]
  });
  proc.stderr.on("data", (d) => {
    const s = d.toString();
    if (!s.includes("ExperimentalWarning") && !s.includes("trace-warnings")) process.stderr.write("[srv] " + s);
  });
  await waitHealth();
});

after(() => { if (proc) proc.kill("SIGTERM"); });

test("会话表被清空后（等价于换到另一个实例），签名令牌仍可放行", async () => {
  const cookie = await login("admin");
  assert.equal(await get(cookie, "/api/projects"), 200, "清空前应正常");
  wipeSessions();
  assert.equal(await get(cookie, "/api/projects"), 200, "清空后应由签名兜底放行");
});

test("篡改签名后立即 401", async () => {
  const cookie = await login("assoc");
  const token = cookie.split("=")[1];
  const parts = token.split(".");
  parts[4] = parts[4].slice(0, -1) + (parts[4].endsWith("A") ? "B" : "A");
  assert.equal(await get(`erp_sid=${parts.join(".")}`, "/api/projects"), 401);
});

test("篡改用户 id 冒充他人 401（签名与 id 绑定）", async () => {
  const cookie = await login("guest");
  const token = cookie.split("=")[1];
  const parts = token.split(".");
  parts[1] = "1"; // 改成总管理员
  assert.equal(await get(`erp_sid=${parts.join(".")}`, "/api/projects"), 401);
});

test("令牌过期后 401（exp 参与签名，改 exp 即失效）", async () => {
  const cookie = await login("exec");
  const token = cookie.split("=")[1];
  const parts = token.split(".");
  parts[2] = String(Date.now() + 999999999); // 延长有效期 → 签名对不上
  assert.equal(await get(`erp_sid=${parts.join(".")}`, "/api/projects"), 401);
});

test("改密后旧令牌即使换实例也失效（token_ver 递增）", async () => {
  const victim = await login("finance");
  const adminCookie = await login("admin");
  const r = await fetch(`${BASE}/api/users/4`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", cookie: adminCookie },
    body: JSON.stringify({ password: "newpass123" })
  });
  assert.equal(r.status, 200);
  wipeSessions();
  assert.equal(await get(victim, "/api/projects"), 401, "改密后旧令牌必须失效");
  // 恢复原密码，避免影响其它用例
  await fetch(`${BASE}/api/users/4`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", cookie: adminCookie },
    body: JSON.stringify({ password: "123456" })
  });
});

test("完全不存在的令牌 401", async () => {
  assert.equal(await get("erp_sid=v1.1.9999999999999.0.deadbeefdeadbeefdeadbeefdeadbeef", "/api/projects"), 401);
});
