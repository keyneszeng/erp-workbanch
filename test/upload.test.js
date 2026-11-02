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
    // 落库上限压到 20 MB、压缩前上限压到 30 MB，方便用 31 MB 的样本验证
    // 「超上限直接拒」，否则要造 200 MB 的请求体才能测到这条分支。
    env: { ...process.env, ERP_PORT: String(PORT), ERP_DB: DB, ERP_UPLOAD_DIR: UP,
      ERP_MAX_FILE_MB: "20", ERP_MAX_UPLOAD_MB: "30" },
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
  assert.equal(r.data.maxBytes, 20 * 1024 * 1024);
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

test("超过落库上限（20 MB）且压不动时被拒绝", async () => {
  const big = Buffer.concat([JPEG, Buffer.alloc(20 * 1024 * 1024)]);
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

test("材料软删保留附件与历史证据", async () => {
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
  assert.equal(gone.status, 200, "软删历史材料必须保留原件，不得销毁证据");
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

/* ---------------- 在线预览（核销「查看原件」走这里） ---------------- */

test("图片原件预览直接返回图片本身，不触发下载", async () => {
  const up = await upload(exec, JPEG, { name: "preview-photo.jpg" });
  assert.equal(up.status, 200, JSON.stringify(up.data));
  const r = await fetch(`${BASE}/api/uploads/${up.data.key}/preview`, { headers: { cookie: exec } });
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("content-type"), "image/jpeg");
  assert.match(r.headers.get("content-disposition") || "", /^inline/, "预览必须是 inline，不能变成附件下载");
  const buf = Buffer.from(await r.arrayBuffer());
  assert.ok(buf.equals(JPEG), "预览返回的必须就是原图字节");
});

test("PDF 原件预览渲染成 PNG；缺少 poppler 时明确报错而不是悄悄下载", async () => {
  const { PDFDocument, StandardFonts, rgb } = require("pdf-lib");
  const doc = await PDFDocument.create();
  const page = doc.addPage([420, 300]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  page.drawText("Final Agenda 2027", { x: 40, y: 220, font, size: 18, color: rgb(0, 0, 0) });
  const pdf = Buffer.from(await doc.save());

  const up = await upload(exec, pdf, { mime: "application/pdf", name: "agenda.pdf" });
  assert.equal(up.status, 200, JSON.stringify(up.data));

  const r = await fetch(`${BASE}/api/uploads/${up.data.key}/preview?page=1`, { headers: { cookie: exec } });
  if (r.status === 503) {
    // 本机没装 poppler 时走这条：必须给出可读错误码，前端据此提供下载入口
    const body = await r.json();
    assert.equal(body.error.code, "PREVIEW_UNAVAILABLE");
    return;
  }
  assert.equal(r.status, 200, `实际 ${r.status}`);
  assert.equal(r.headers.get("content-type"), "image/png");
  assert.equal(r.headers.get("x-preview-pages"), "1");
  const png = Buffer.from(await r.arrayBuffer());
  assert.equal(png.subarray(1, 4).toString("ascii"), "PNG", "返回的应是 PNG 图片");
});

test("预览与下载共用同一套权限：无关角色不能看", async () => {
  const up = await upload(exec, JPEG, { name: "preview-perm.jpg" });
  assert.equal(up.status, 200, JSON.stringify(up.data));
  const r = await fetch(`${BASE}/api/uploads/${up.data.key}/preview`, { headers: { cookie: guest } });
  assert.equal(r.status, 403, "未关联单据的附件只允许上传者本人或总管理员预览");
});

test("预览接口同样校验 key 合法性", async () => {
  const r = await fetch(`${BASE}/api/uploads/not-a-key/preview`, { headers: { cookie: admin } });
  assert.equal(r.status, 400);
});

test("LibreOffice 缺失时，Office 转换给出明确错误码而不是静默失败", async () => {
  // 用空 PATH 起一个子进程，模拟「服务器没装 LibreOffice」的机器。
  // 断言的是失败形态：必须能识别为 SOFFICE_MISSING，前端据此提示下载。
  const { spawnSync } = require("node:child_process");
  const probe = spawnSync(process.execPath, ["-e", `
    const { hasLibreOffice, toPdf } = require("./server/lib/office-preview");
    (async () => {
      const has = await hasLibreOffice();
      console.log("available=" + has);
      try { await toPdf(Buffer.from("not-a-real-docx"), "docx", "probe"); console.log("code=CONVERTED"); }
      catch (e) { console.log("code=" + e.code); }
    })();
  `], {
    cwd: path.join(__dirname, ".."),
    encoding: "utf8",
    env: { ...process.env, PATH: "/nonexistent" },
    timeout: 30000
  });
  const out = String(probe.stdout || "");
  assert.match(out, /available=false/, "空 PATH 下不应探测到 LibreOffice：" + out + String(probe.stderr || ""));
  assert.match(out, /code=SOFFICE_MISSING/, "缺少 LibreOffice 时必须报 SOFFICE_MISSING：" + out);
});

/* ---------------- 超大附件自动压缩 ---------------- */

test("超过压缩前上限（30 MB）直接拒绝，并说明上限是压缩前", async () => {
  const big = Buffer.concat([JPEG, Buffer.alloc(31 * 1024 * 1024)]);
  const r = await upload(exec, big);
  assert.equal(r.status, 413, JSON.stringify(r.data));
  assert.match(r.data.error.message, /压缩前/);
});

test("压缩模块：小文件不需要压、Office 压不了、损坏文件不抛 500", async () => {
  const { shrinkToLimit } = require("../server/lib/shrink");
  const limit = 20 * 1024 * 1024;

  // 未超限：不动它
  const small = await shrinkToLimit(JPEG, "image/jpeg", limit);
  assert.equal(small.ok, false);
  assert.equal(small.reason, "not-needed");

  // 旧版 .ppt 是 CFB 二进制，没有安全的改写手段，明确返回 unsupported
  const legacy = await shrinkToLimit(Buffer.alloc(limit + 1), "application/vnd.ms-powerpoint", limit);
  assert.equal(legacy.ok, false);
  assert.equal(legacy.reason, "unsupported");

  // pptx 会走「解包重压图片」，但这里喂的是垃圾字节：只能失败，不能抛异常
  const pptx = await shrinkToLimit(Buffer.alloc(limit + 1), "application/vnd.openxmlformats-officedocument.presentationml.presentation", limit);
  assert.equal(pptx.ok, false);
  assert.ok(["tool-missing", "failed", "still-large", "unsupported"].includes(pptx.reason), pptx.reason);

  // 损坏的 PDF：要么工具没装，要么压失败，但绝不能抛异常（否则上传会变成 500）
  const broken = await shrinkToLimit(Buffer.alloc(limit + 1, 0x41), "application/pdf", limit);
  assert.equal(broken.ok, false);
  assert.ok(["tool-missing", "failed", "still-large"].includes(broken.reason), broken.reason);
});
