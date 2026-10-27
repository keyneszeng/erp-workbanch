"use strict";
/**
 * 存储不可用时的降级行为
 * 运行：node --test test/storage-unavailable.test.js
 *
 * 场景：Cloudflare 部署没绑 R2 桶。
 * 要求：上传接口返回 **503 STORAGE_UNAVAILABLE** 且消息可读，
 *       不能变成 500「服务器内部错误」——那会让运维完全不知道问题在哪。
 *       其余功能（材料元数据登记、核销、付款）必须照常工作。
 */
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const PORT = 8809;
const BASE = `http://127.0.0.1:${PORT}`;
const DB = path.join(__dirname, "..", "data", "test9.db");
let proc;
let admin;

const JPEG = Buffer.from(
  "/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==",
  "base64"
);

function clean() {
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
  clean();
  proc = spawn(process.execPath, ["--experimental-sqlite", "server/index.js"], {
    cwd: path.join(__dirname, ".."),
    // ERP_STORAGE=unavailable 模拟 Cloudflare 未绑 R2 的状态
    env: { ...process.env, ERP_PORT: String(PORT), ERP_DB: DB, ERP_STORAGE: "unavailable" },
    stdio: ["ignore", "pipe", "pipe"]
  });
  proc.stderr.on("data", (d) => {
    const s = d.toString();
    if (!s.includes("ExperimentalWarning") && !s.includes("trace-warnings")) process.stderr.write("[srv] " + s);
  });
  await waitHealth();

  const r = await fetch(`${BASE}/api/auth/login`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "admin", password: "123456" })
  });
  admin = r.headers.get("set-cookie").split(";")[0];
});
after(() => { if (proc) proc.kill("SIGTERM"); });

test("能力探测报告存储不可用", async () => {
  const r = await client(admin)("GET", "/api/uploads/capability");
  assert.equal(r.status, 200);
  assert.equal(r.data.enabled, false);
  assert.equal(r.data.backend, "unavailable");
});

test("上传返回 503 STORAGE_UNAVAILABLE，而不是 500", async () => {
  const r = await fetch(`${BASE}/api/uploads`, {
    method: "POST",
    headers: { "Content-Type": "image/jpeg", "x-file-name": "x.jpg", cookie: admin },
    body: JPEG
  });
  const data = await r.json();
  assert.equal(r.status, 503, `应为 503，实际 ${r.status}：${JSON.stringify(data)}`);
  assert.equal(data.error.code, "STORAGE_UNAVAILABLE");
  assert.match(data.error.message, /存储/);
});

test("存储不可用不影响材料元数据登记", async () => {
  const c = client(admin);
  const list = await c("GET", "/api/projects");
  const p = list.data.rows.find((x) => x.status !== "已归档");
  const r = await c("POST", `/api/projects/${p.id}/materials`, { kind: "议程", name: "无附件登记.pdf" });
  assert.equal(r.status, 200, JSON.stringify(r.data));
});

test("存储不可用不影响核销 / 付款等核心链路", async () => {
  const c = client(admin);
  const d = await c("GET", "/api/dashboard");
  assert.equal(d.status, 200);
  const pays = await c("GET", "/api/payments?page=1&size=5");
  assert.equal(pays.status, 200);
  assert.equal(pays.data.paged, true);
});
