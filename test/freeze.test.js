"use strict";
/**
 * 冻结状态回归：已结算 / 已归档之后，账目基准数据与核销凭证不能再动
 * 运行：node --test test/freeze.test.js
 *
 * 这一组是 2026-10-26 实测出来的三个洞：
 *   1) assoc 能改「已结算」项目资料（原来只拦了「已归档」）
 *   2) 已结算项目能删材料（核销凭证被销毁）
 *   3) 超管改「已结算」项目预算无任何门槛（结算单 income 取自 budget，改完永久对不上）
 */
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const PORT = 8812;
const BASE = `http://127.0.0.1:${PORT}`;
const DB = path.join(__dirname, "..", "data", "test12.db");
const UP = path.join(__dirname, "..", "data", "test12-uploads");
let proc;
let admin, assoc;

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
  return async (m, u, b) => {
    const r = await fetch(BASE + u, {
      method: m, headers: { "Content-Type": "application/json", cookie },
      body: b === undefined ? undefined : JSON.stringify(b)
    });
    const t = await r.text();
    let d = null; try { d = JSON.parse(t); } catch { d = t; }
    return { status: r.status, data: d, code: d?.error?.code, msg: d?.error?.message || "" };
  };
}

/** 种子里已结算的项目：MP-2026-006（对应结算单 ST-2026-001） */
const SETTLED = "MP-2026-006";
const ARCHIVED = "MP-2026-007";

before(async () => {
  clean();
  proc = spawn(process.execPath, ["--experimental-sqlite", "server/index.js"], {
    cwd: path.join(__dirname, ".."),
    env: { ...process.env, ERP_PORT: String(PORT), ERP_DB: DB, ERP_UPLOAD_DIR: UP },
    stdio: ["ignore", "pipe", "pipe"]
  });
  proc.stderr.on("data", (d) => {
    const s = d.toString();
    if (!s.includes("ExperimentalWarning") && !s.includes("trace-warnings")) process.stderr.write("[srv] " + s);
  });
  await waitHealth();
  admin = await login("admin");
  assoc = await login("assoc");
});
after(() => {
  if (proc) proc.kill("SIGTERM");
  if (fs.existsSync(UP)) fs.rmSync(UP, { recursive: true, force: true });
});

test("前置：种子里的 MP-2026-006 确为已结算且有结算单", async () => {
  const d = (await client(admin)("GET", `/api/projects/${SETTLED}`)).data;
  assert.equal(d.project.status, "已结算");
  assert.ok(d.settlement, "应有结算单");
  assert.equal(Number(d.settlement.income), Number(d.project.budget), "结算单 income 取自项目预算");
});

test("超管改已结算项目预算：无 force 被拒，带 force 放行", async () => {
  const c = client(admin);
  const before = (await c("GET", `/api/projects/${SETTLED}`)).data.project.budget;

  const blocked = await c("PATCH", `/api/projects/${SETTLED}`, { budget: 9999999 });
  assert.equal(blocked.status, 409, JSON.stringify(blocked.data));
  assert.equal(blocked.code, "FROZEN");
  assert.match(blocked.msg, /force/);

  const forced = await c("PATCH", `/api/projects/${SETTLED}`, { budget: 9999999, force: true });
  assert.equal(forced.status, 200, JSON.stringify(forced.data));

  const after = (await c("GET", `/api/projects/${SETTLED}`)).data.project.budget;
  assert.equal(Number(after), 9999999);
  // 收尾：改回去，不影响后续用例
  await c("PATCH", `/api/projects/${SETTLED}`, { budget: before, force: true });
});

test("已结算项目改非金额字段不受 force 限制（避免误伤）", async () => {
  const r = await client(admin)("PATCH", `/api/projects/${SETTLED}`, { people: 320 });
  assert.equal(r.status, 200, JSON.stringify(r.data));
});

test("assoc 不能改已结算项目（原来只拦了已归档）", async () => {
  // 先把该项目的协会改成 assoc 所属协会，否则会先被数据范围拦掉，
  // 验不到冻结逻辑本身。
  await client(admin)("PATCH", `/api/projects/${SETTLED}`, { assoc: "华东医学会" });

  const r = await client(assoc)("PATCH", `/api/projects/${SETTLED}`, { budget: 1 });
  assert.equal(r.status, 409, JSON.stringify(r.data));
  assert.equal(r.code, "FROZEN");
  assert.match(r.msg, /已结算/);
});

test("已结算项目不能删材料（核销凭证冻结）", async () => {
  const c = client(admin);
  // 已结算项目可能没材料，先补一条
  const add = await c("POST", `/api/projects/${SETTLED}/materials`, { kind: "发票", name: "结算后补录发票.pdf" });
  assert.equal(add.status, 200, JSON.stringify(add.data));

  const mats = (await c("GET", "/api/materials")).data.rows.filter((m) => m.pid === SETTLED);
  assert.ok(mats.length, "应有材料");

  const del = await c("DELETE", `/api/materials/${mats[0].id}`);
  assert.equal(del.status, 409, JSON.stringify(del.data));
  assert.equal(del.code, "FROZEN");
  assert.match(del.msg, /凭证|冻结/);

  // 材料还在
  const still = (await c("GET", "/api/materials")).data.rows.filter((m) => m.pid === SETTLED);
  assert.equal(still.length, mats.length, "被拒后材料不应减少");
});

test("已归档项目仍不能删材料（原有行为不被破坏）", async () => {
  const c = client(admin);
  const mats = (await c("GET", "/api/materials")).data.rows.filter((m) => m.pid === ARCHIVED);
  assert.ok(mats.length, "归档项目应有材料");
  const del = await c("DELETE", `/api/materials/${mats[0].id}`);
  assert.equal(del.status, 409);
  assert.match(del.msg, /已归档/);
});

test("已归档项目改预算同样需要 force", async () => {
  const c = client(admin);
  const before = (await c("GET", `/api/projects/${ARCHIVED}`)).data.project.budget;
  const blocked = await c("PATCH", `/api/projects/${ARCHIVED}`, { budget: before + 1000 });
  assert.equal(blocked.status, 409, JSON.stringify(blocked.data));
  assert.equal(blocked.code, "FROZEN");
});

test("核销结论：已结算项目连超管也不能改", async () => {
  const r = await client(admin)("POST", `/api/projects/${SETTLED}/verify/steps/1`, { result: "不通过", remark: "事后篡改" });
  assert.ok(r.status >= 400, `应被拒，实际 ${r.status}`);
  assert.ok(["FROZEN", "ILLEGAL_STATE"].includes(r.code), `实际 code=${r.code}`);
});

test("已结算项目不能再提交例外单", async () => {
  const r = await client(admin)("POST", `/api/projects/${SETTLED}/exceptions`, { step_no: 3, reason: "事后补例外" });
  assert.equal(r.status, 409);
  assert.equal(r.code, "FROZEN");
});
