"use strict";
/**
 * 文件上传 / 下载回归
 * 运行：node --test test/upload.test.js
 */
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const PORT = 8808;
const BASE = `http://127.0.0.1:${PORT}`;
const DB = path.join(__dirname, "..", "data", "test8.db");
const UP = path.join(__dirname, "..", "data", "test8-uploads");
let proc;
let admin, exec, guest;

// 1×1 像素的合法 JPEG，用来验证文件头嗅探与二进制完整性
const JPEG = Buffer.from(
  "/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==",
  "base64"
);

function clean() {
  for (const f of [DB, DB + "-wal", DB + "-shm"]) if (fs.existsSync(f)) fs.unlinkSync(f);
  if (fs.existsSync(UP)) fs.rmSync(UP, { recursive: true, force: true });
}
async function waitHealth(timeout = 15000) {
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
  assert.equal(r.status, 200, `${username} 登录失败`);
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
async function upload(cookie, buf, { mime = "image/jpeg", name = "photo.jpg" } = {}) {
  const r = await fetch(`${BASE}/api/uploads`, {
    method: "POST",
    headers: {
      "Content-Type": mime,
      "x-file-name": encodeURIComponent(name),
      ...(cookie ? { cookie } : {})
    },
    body: buf
  });
  const text = await r.text();
  let data = null; try { data = JSON.parse(text); } catch { data = text; }
  return { status: r.status, data };
}

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
  exec = await login("exec");
  guest = await login("guest");
});
after(() => {
  if (proc) proc.kill("SIGTERM");
  if (fs.existsSync(UP)) fs.rmSync(UP, { recursive: true, force: true });
});

test("上传能力探测：本地磁盘后端可用", async () => {
  const r = await client(admin)("GET", "/api/uploads/capability");
  assert.equal(r.status, 200);
  assert.equal(r.data.enabled, true);
  assert.equal(r.data.backend, "fs");
  assert.equal(r.data.maxBytes, 8 * 1024 * 1024);
});

test("未登录不能上传", async () => {
  const r = await upload(null, JPEG);
  assert.equal(r.status, 401);
});

test("guest 无上传权限", async () => {
  const r = await upload(guest, JPEG);
  assert.equal(r.status, 403);
});

test("exec 上传 JPEG 成功，返回 key 与大小", async () => {
  const r = await upload(exec, JPEG, { name: "现场照片-01.jpg" });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.match(r.data.key, /^[a-f0-9]{32}\.jpg$/);
  assert.equal(r.data.size, JPEG.length);
  assert.equal(r.data.mime, "image/jpeg");
  assert.equal(r.data.name, "现场照片-01.jpg");
  assert.equal(r.data.url, `/api/uploads/${r.data.key}`);
});

test("伪造扩展名被文件头嗅探拦下", async () => {
  // 一段纯文本，声明成 image/jpeg
  const fake = Buffer.from("#!/bin/sh\necho hacked\n", "utf8");
  const r = await upload(exec, fake, { mime: "image/jpeg", name: "evil.jpg" });
  assert.equal(r.status, 400);
  assert.match(r.data.error.message, /无法识别文件类型/);
});

test("超过 8 MB 被拒绝", async () => {
  const big = Buffer.concat([JPEG, Buffer.alloc(8 * 1024 * 1024)]);
  const r = await upload(exec, big);
  assert.equal(r.status, 413);
});

test("空文件被拒绝", async () => {
  const r = await upload(exec, Buffer.alloc(0));
  assert.equal(r.status, 400);
});

test("下载自己上传的文件，字节完全一致", async () => {
  const up = await upload(exec, JPEG, { name: "byte-check.jpg" });
  const r = await fetch(`${BASE}${up.data.url}`, { headers: { cookie: exec } });
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("content-type"), "image/jpeg");
  assert.equal(r.headers.get("x-content-type-options"), "nosniff");
  const buf = Buffer.from(await r.arrayBuffer());
  assert.equal(buf.length, JPEG.length);
  assert.ok(buf.equals(JPEG), "下载内容必须与上传字节完全一致");
});

test("非法 key 返回 400，不存在的 key 返回 404", async () => {
  const bad = await client(admin)("GET", "/api/uploads/..%2F..%2Fetc%2Fpasswd");
  assert.ok([400, 404].includes(bad.status), `实际 ${bad.status}`);

  const missing = await client(admin)("GET", "/api/uploads/" + "a".repeat(32) + ".jpg");
  assert.equal(missing.status, 404);
});

test("材料登记带附件，删除材料时附件一并删除", async () => {
  const c = client(exec);
  const list = await c("GET", "/api/projects");
  const p = list.data.rows.find((x) => x.status !== "已归档");
  assert.ok(p, "需要有可写项目");

  const up = await upload(exec, JPEG, { name: "归档照片.jpg" });
  const add = await c("POST", `/api/projects/${p.id}/materials`, {
    kind: "现场照片", name: "归档照片.jpg",
    file_key: up.data.key, file_name: "归档照片.jpg", file_size: up.data.size, file_mime: "image/jpeg"
  });
  assert.equal(add.status, 200, JSON.stringify(add.data));

  const all = await c("GET", "/api/materials");
  const row = all.data.rows.find((m) => m.file_key === up.data.key);
  assert.ok(row, "材料行应写入 file_key");
  assert.equal(row.file_size, JPEG.length);
  assert.equal(row.file_mime, "image/jpeg");

  // 关联后仍可下载
  const dl = await fetch(`${BASE}/api/uploads/${up.data.key}`, { headers: { cookie: exec } });
  assert.equal(dl.status, 200);

  const del = await c("DELETE", `/api/materials/${row.id}`);
  assert.equal(del.status, 200);

  const gone = await fetch(`${BASE}/api/uploads/${up.data.key}`, { headers: { cookie: exec } });
  assert.equal(gone.status, 404, "删除材料后附件文件应同时删除");
});

test("非法 file_key 被拒绝", async () => {
  const c = client(exec);
  const list = await c("GET", "/api/projects");
  const p = list.data.rows.find((x) => x.status !== "已归档");
  const r = await c("POST", `/api/projects/${p.id}/materials`, {
    kind: "现场照片", name: "x.jpg", file_key: "../../etc/passwd"
  });
  assert.equal(r.status, 400);
  assert.match(r.data.error.message, /附件标识不合法/);
});
