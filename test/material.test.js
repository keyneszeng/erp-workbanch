"use strict";
/**
 * 材料写入权限回归 —— 会务执行人员必须能登记/删除材料，但不得获得项目归档权限
 * 运行：node --test test/material.test.js
 */
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { can } = require("../server/lib/rbac");

const PORT = 8805;
const BASE = `http://127.0.0.1:${PORT}`;
const DB = path.join(__dirname, "..", "data", "test5.db");
let proc;

function cleanDb() {
  for (const f of [DB, DB + "-wal", DB + "-shm"]) if (fs.existsSync(f)) fs.renameSync(f, f + ".old");
}
async function waitHealth(timeout = 40000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    try { const r = await fetch(`${BASE}/api/health`); if (r.ok) return; } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("测试服务启动超时");
}
async function login(username, password = "123456") {
  const r = await fetch(`${BASE}/api/auth/login`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password })
  });
  assert.equal(r.status, 200, `${username} 登录应成功`);
  return r.headers.get("set-cookie").split(";")[0];
}
function client(cookie) {
  return async (method, url, body) => {
    const r = await fetch(BASE + url, {
      method, headers: { "Content-Type": "application/json", cookie },
      body: body ? JSON.stringify(body) : undefined
    });
    const text = await r.text();
    let data = null; try { data = JSON.parse(text); } catch { data = text; }
    return { status: r.status, data };
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
});
after(() => { if (proc) proc.kill("SIGTERM"); });

test("权限矩阵：exec 可写材料但不可归档", () => {
  assert.equal(can({ role: "exec" }, "material:write"), true, "exec 应可写材料");
  assert.equal(can({ role: "exec" }, "archive:write"), false, "exec 不应可归档");
  assert.equal(can({ role: "assoc" }, "material:write"), true);
  assert.equal(can({ role: "finance" }, "material:write"), true);
  assert.equal(can({ role: "user" }, "material:write"), false, "普通用户不可写材料");
  assert.equal(can({ role: "admin" }, "material:write"), true, "超级角色恒可");
});

test("exec 登录后 /me 权限包含 material:write 且不含 archive:write", async () => {
  const exec = client(await login("exec"));
  const me = await exec("GET", "/api/auth/me");
  assert.equal(me.status, 200);
  assert.ok(me.data.perms.includes("material:write"), "应含 material:write");
  assert.ok(!me.data.perms.includes("archive:write"), "不应含 archive:write");
});

test("exec 可登记并删除材料", async () => {
  const exec = client(await login("exec"));
  const list = await exec("GET", "/api/projects");
  const p = list.data.rows.find((x) => x.status !== "已归档");
  assert.ok(p, "exec 应有可见且未归档的项目");

  const add = await exec("POST", `/api/projects/${p.id}/materials`, { kind: "现场照片", name: "巡检测试材料.jpg" });
  assert.equal(add.status, 200, `exec 登记材料应成功，实际 ${add.status} ${JSON.stringify(add.data)}`);

  const all = await exec("GET", "/api/materials");
  const row = all.data.rows.find((m) => m.pid === p.id && m.kind === "现场照片" && m.name === "巡检测试材料.jpg");
  assert.ok(row, "应能查到刚登记的材料");

  const del = await exec("DELETE", `/api/materials/${row.id}`);
  assert.equal(del.status, 200, "exec 删除材料应成功");
});

test("guest 登记材料返回 403", async () => {
  const guest = client(await login("guest"));
  const list = await guest("GET", "/api/projects");
  const p = list.data.rows[0];
  if (!p) return; // guest 可能无可见项目
  const r = await guest("POST", `/api/projects/${p.id}/materials`, { kind: "现场照片", name: "x.jpg" });
  assert.equal(r.status, 403);
});

test("assoc 仍可登记材料（回归）", async () => {
  const assoc = client(await login("assoc"));
  const list = await assoc("GET", "/api/projects");
  const p = list.data.rows.find((x) => x.status !== "已归档");
  const r = await assoc("POST", `/api/projects/${p.id}/materials`, { kind: "签到表", name: "回归测试.pdf" });
  assert.equal(r.status, 200);
});
