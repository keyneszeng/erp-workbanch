"use strict";
/**
 * 合同原件附件回归
 * 运行：node --test test/contract-file.test.js
 *
 * 验的是「录入合同时能挂原件（PDF / 照片）」这条链路：
 *   上传拿到 key → 录入合同写入四个附件字段 → 列表能读到 → 能按项目数据范围下载。
 * OCR 不在本轮范围，附件只是先存好，后续接识别时不用改数据结构。
 */
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const PORT = 8810;
const BASE = `http://127.0.0.1:${PORT}`;
const DB = path.join(__dirname, "..", "data", "test10.db");
const UP = path.join(__dirname, "..", "data", "test10-uploads");
let proc;
let admin, assoc, exec, finance, guest;

// 最小合法 JPEG（1×1），验图片类合同原件
const JPEG = Buffer.from(
  "/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==",
  "base64"
);
// 最小合法 PDF（嗅探只看 %PDF 魔数），验 PDF 类合同原件
const PDF = Buffer.from(
  "%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n",
  "utf8"
);

function clean() {
  for (const f of [DB, DB + "-wal", DB + "-shm"]) if (fs.existsSync(f)) fs.renameSync(f, f + ".old");
  if (fs.existsSync(UP)) fs.rmSync(UP, { recursive: true, force: true });
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
async function upload(cookie, buf, { mime = "image/jpeg", name = "scan.jpg" } = {}) {
  const r = await fetch(`${BASE}/api/uploads`, {
    method: "POST",
    headers: { "Content-Type": mime, "x-file-name": encodeURIComponent(name), ...(cookie ? { cookie } : {}) },
    body: buf
  });
  const text = await r.text();
  let data = null; try { data = JSON.parse(text); } catch { data = text; }
  return { status: r.status, data };
}

/** 找一个「可写」项目：已结算/已归档的合同台账封存，录不进去 */
async function writableProject(cookie) {
  const r = await client(cookie)("GET", "/api/projects");
  const p = r.data.rows.find((x) => x.status !== "已归档" && x.status !== "已结算");
  assert.ok(p, "需要有未封存的项目");
  return p;
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
  assoc = await login("assoc");
  exec = await login("exec");
  finance = await login("finance");
  guest = await login("guest");
});
after(() => {
  if (proc) proc.kill("SIGTERM");
  if (fs.existsSync(UP)) fs.rmSync(UP, { recursive: true, force: true });
});

test("录入合同带 PDF 原件，四个附件字段全部落库", async () => {
  const p = await writableProject(exec);
  const c = client(exec);

  const up = await upload(exec, PDF, { mime: "application/pdf", name: "服务合同-盖章版.pdf" });
  assert.equal(up.status, 200, JSON.stringify(up.data));
  assert.match(up.data.key, /^[a-f0-9]{32}\.pdf$/);
  assert.equal(up.data.mime, "application/pdf");

  const add = await c("POST", "/api/contracts", {
    pid: p.id, name: "场地服务合同", vendor: "某某会展服务有限公司", amount: 128000,
    sign_date: "2026-10-20", status: "已签署",
    file_key: up.data.key, file_name: "服务合同-盖章版.pdf",
    file_size: up.data.size, file_mime: "application/pdf"
  });
  assert.equal(add.status, 200, JSON.stringify(add.data));
  assert.equal(add.data.contract.file_key, up.data.key);
  assert.equal(add.data.contract.file_name, "服务合同-盖章版.pdf");
  assert.equal(add.data.contract.file_size, PDF.length);
  assert.equal(add.data.contract.file_mime, "application/pdf");
});

test("合同清单能读到附件字段", async () => {
  const r = await client(admin)("GET", "/api/contracts");
  assert.equal(r.status, 200);
  const row = r.data.rows.find((x) => x.file_key);
  assert.ok(row, "列表应至少有一份带原件的合同");
  assert.ok(row.file_name, "文件名要一起返回，前端才有 title 可显示");
  assert.ok(row.file_mime);
});

test("合同原件可下载，字节与上传完全一致", async () => {
  const list = await client(admin)("GET", "/api/contracts");
  const row = list.data.rows.find((x) => x.file_mime === "application/pdf");
  assert.ok(row, "需要一份 PDF 合同");

  const r = await fetch(`${BASE}/api/uploads/${row.file_key}`, { headers: { cookie: exec } });
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("content-type"), "application/pdf");
  const buf = Buffer.from(await r.arrayBuffer());
  assert.ok(buf.equals(PDF), "下载内容必须与上传字节完全一致");
});

test("拍照件（JPEG）也能挂到合同上", async () => {
  const p = await writableProject(exec);
  const c = client(exec);
  const up = await upload(exec, JPEG, { name: "合同手机拍照.jpg" });
  const add = await c("POST", "/api/contracts", {
    pid: p.id, name: "补充协议", vendor: "某某广告有限公司", amount: 8600,
    file_key: up.data.key, file_name: "合同手机拍照.jpg",
    file_size: up.data.size, file_mime: "image/jpeg"
  });
  assert.equal(add.status, 200, JSON.stringify(add.data));
  assert.equal(add.data.contract.file_mime, "image/jpeg");

  const dl = await fetch(`${BASE}/api/uploads/${up.data.key}`, { headers: { cookie: exec } });
  assert.equal(dl.status, 200);
  assert.equal(dl.headers.get("content-type"), "image/jpeg");
});

test("不带原件也能正常录合同（附件是可选的）", async () => {
  const p = await writableProject(exec);
  const add = await client(exec)("POST", "/api/contracts", {
    pid: p.id, name: "无附件合同", vendor: "某某科技", amount: 1000
  });
  assert.equal(add.status, 200);
  assert.equal(add.data.contract.file_key, null);
});

test("非法 file_key 被拒绝，不会写进库", async () => {
  const p = await writableProject(exec);
  const r = await client(exec)("POST", "/api/contracts", {
    pid: p.id, name: "恶意合同", vendor: "x", amount: 100,
    file_key: "../../etc/passwd"
  });
  assert.equal(r.status, 400);
  assert.match(r.data.error.message, /附件标识不合法/);
});

test("数据范围外的用户不能下载合同原件", async () => {
  /**
   * V1.2.17 BUG-01 之后 guest 的数据范围是「成员 + 负责人 + 创建人」，
   * 拿种子里的合同去试很容易正好落在他范围内。这里干脆自己造一个
   * guest 一定看不见的项目（admin 创建、不拉他进成员），再挂一份带原件的合同。
   */
  const adminC = client(admin);
  const mk = await adminC("POST", "/api/projects", {
    name: `越权下载用例-${Date.now()}`, assoc: "华东医学会", form: "线下",
    date: "2027-09-09", budget: 1000, people: 10, owner: "王敏", agenda: "09:00 开幕"
  });
  assert.equal(mk.status, 200, JSON.stringify(mk.data));
  const pid = mk.data.project.id;

  const up = await upload(admin, JPEG, { name: "越权原件.jpg" });
  assert.equal(up.status, 200, JSON.stringify(up.data));
  const add = await adminC("POST", "/api/contracts", {
    pid, name: "越权下载合同", vendor: "某某会展", amount: 100,
    file_key: up.data.key, file_name: up.data.name, file_size: up.data.size, file_mime: up.data.mime
  });
  assert.equal(add.status, 200, JSON.stringify(add.data));

  // 前提确认：这个项目确实不在 guest 的数据范围内
  assert.equal((await client(guest)("GET", `/api/projects/${pid}`)).status, 403);

  const r = await fetch(`${BASE}/api/uploads/${up.data.key}`, { headers: { cookie: guest } });
  assert.equal(r.status, 403, "数据范围外应被拦，不能凭 key 直取");
});

test("finance 无合同录入权限，仍可上传（上传是公共入口）", async () => {
  const up = await upload(finance, JPEG, { name: "财务上传.jpg" });
  assert.equal(up.status, 200, JSON.stringify(up.data));

  // 必须用 finance 自己数据范围内的项目来测权限，否则会先被数据范围拦掉，
  // 验不到 contract:write 这一层。
  const p = await writableProject(finance);
  const r = await client(finance)("POST", "/api/contracts", {
    pid: p.id, name: "财务越权录合同", vendor: "x", amount: 100
  });
  assert.equal(r.status, 403);
  assert.match(r.data.error.message, /无合同录入权限/);
});

test("assoc 也能录合同并挂原件", async () => {
  const p = await writableProject(assoc);
  const c = client(assoc);
  const up = await upload(assoc, PDF, { mime: "application/pdf", name: "协会合同.pdf" });
  assert.equal(up.status, 200, JSON.stringify(up.data));
  const add = await c("POST", "/api/contracts", {
    pid: p.id, name: "协会侧合同", vendor: "某某酒店", amount: 50000,
    file_key: up.data.key, file_name: "协会合同.pdf", file_size: up.data.size, file_mime: "application/pdf"
  });
  assert.equal(add.status, 200, JSON.stringify(add.data));
});
