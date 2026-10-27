"use strict";
/**
 * 待办口径 + 账号开关字段（V1.2.4）
 * 运行：node --test test/todo-flag.test.js
 *
 * 两处都是「接口能用但语义不对」的缺陷：
 *   1) 工作台待办把 LIMIT 加在 SQL 上，而角色过滤在 JS 里做 ——
 *      被截掉的可能是别的角色该处理的单子，本角色的待办就凭空少几条，
 *      而工作台显示的「N 项」看起来又像全量。实测 29 条待审批只显示 17 条。
 *   2) PATCH /api/users/:id 直接接收 active，JSON 传布尔 false 时
 *      node:sqlite 抛 "Provided value cannot be bound to SQLite parameter 1"，
 *      最终 500 并把内部实现细节透给用户。
 */
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const PORT = 8822;
const BASE = `http://127.0.0.1:${PORT}`;
const DB = path.join(__dirname, "..", "data", "test17.db");
const UP = path.join(__dirname, "..", "data", "test17-uploads");
let proc;
let admin, assoc, finance;

function clean() {
  for (const f of [DB, DB + "-wal", DB + "-shm"]) if (fs.existsSync(f)) fs.renameSync(f, f + ".old");
  if (fs.existsSync(UP)) fs.rmSync(UP, { recursive: true, force: true });
}
async function waitHealth(t = 40000) {
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
  assoc = client(await login("assoc"));
  finance = client(await login("finance"));
});

after(() => {
  proc?.kill();
  clean();
});

/* ---------------- 工作台待办口径 ---------------- */

test("待审批超过 20 条时，工作台审批待办数仍等于审批中心待审批数", async () => {
  // MP-2026-017 已核销 + 华东医学会（assoc 可见），可挂付款申请
  const pid = "MP-2026-017";
  let made = 0;
  for (let i = 0; i < 25; i++) {
    const r = await assoc("POST", "/api/payments", {
      pid, type: "学会公付", payee: `批量供应商${i}`, amount: 100 + i, invoice_no: `BULK-${i}`
    });
    assert.equal(r.status, 200, `第 ${i} 条付款失败：${r.msg}`);
    made++;
  }
  assert.equal(made, 25);

  const ap = (await admin("GET", "/api/approvals")).data;
  const pending = (ap.rows || ap).filter((a) => a.status === "待审批");
  const dash = (await admin("GET", "/api/dashboard")).data;
  const todos = dash.todos.filter((t) => t.kind === "审批");

  assert.ok(pending.length > 20, `待审批应超过 20 条，实际 ${pending.length}`);
  assert.equal(todos.length, pending.length,
    `工作台审批待办 ${todos.length} 条，审批中心待审批 ${pending.length} 条`);

  // 按类型逐一比对，避免「总数碰巧相等」
  const byType = {};
  for (const a of pending) byType[a.type] = (byType[a.type] || 0) + 1;
  const todoType = {};
  for (const t of todos) {
    const ty = String(t.title).split("：")[0];
    todoType[ty] = (todoType[ty] || 0) + 1;
  }
  assert.deepEqual(todoType, byType);
});

/* ---------------- 账号开关字段 ---------------- */

test("active 传 JSON 布尔 false 可正常停用（不报 500）", async () => {
  const rows = (await admin("GET", "/api/users")).data.rows;
  const u = rows.find((x) => x.username === "zhoutao");
  const r = await admin("PATCH", `/api/users/${u.id}`, { active: false });
  assert.equal(r.status, 200, `${r.status} ${r.code} ${r.msg}`);
  const after = (await admin("GET", "/api/users")).data.rows.find((x) => x.id === u.id);
  assert.equal(Number(after.active), 0);
  await admin("PATCH", `/api/users/${u.id}`, { active: true });
});

test("active 传 0/\"0\" 同样可停用，传非法值被 400 拒绝", async () => {
  const rows = (await admin("GET", "/api/users")).data.rows;
  const u = rows.find((x) => x.username === "zhoutao");

  const r0 = await admin("PATCH", `/api/users/${u.id}`, { active: 0 });
  assert.equal(r0.status, 200, r0.msg);
  assert.equal(Number((await admin("GET", "/api/users")).data.rows.find((x) => x.id === u.id).active), 0);

  const bad1 = await admin("PATCH", `/api/users/${u.id}`, { active: "也许" });
  assert.equal(bad1.status, 400);
  assert.match(bad1.msg, /账号状态/);

  await admin("PATCH", `/api/users/${u.id}`, { active: 1 });
});

test("停用账号后，该账号已签发的令牌立即失效", async () => {
  const ck = await login("zhoutao");
  const zt = client(ck);
  const beforeMe = await zt("GET", "/api/auth/me");
  assert.ok(beforeMe.data.user, "停用前应能取到用户信息");

  const rows = (await admin("GET", "/api/users")).data.rows;
  const u = rows.find((x) => x.username === "zhoutao");
  const off = await admin("PATCH", `/api/users/${u.id}`, { active: false });
  assert.equal(off.status, 200, off.msg);

  const afterMe = await zt("GET", "/api/auth/me");
  assert.equal(afterMe.data.user, null, "停用后令牌必须立即失效");
  await admin("PATCH", `/api/users/${u.id}`, { active: true });
});

test("登出后令牌立即失效", async () => {
  const zl = client(await login("zhaolei"));
  assert.ok((await zl("GET", "/api/auth/me")).data.user);
  await zl("POST", "/api/auth/logout", {});
  assert.equal((await zl("GET", "/api/auth/me")).data.user, null);
});
