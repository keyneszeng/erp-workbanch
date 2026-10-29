"use strict";
/** Office 文件（DOCX/PPTX/XLSX）端到端回归。数据库、端口与其它测试隔离。 */
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { detectOoxml, MIME } = require("../server/lib/ooxml");

function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) {
    c ^= b;
    for (let i = 0; i < 8; i++) c = (c >>> 1) ^ ((c & 1) ? 0xedb88320 : 0);
  }
  return (c ^ 0xffffffff) >>> 0;
}
function zip(entries) {
  const locals = [], centers = [];
  let offset = 0, cdSize = 0;
  for (const [name, content = "<xml/>"] of entries) {
    const n = Buffer.from(name), b = Buffer.from(content);
    const crc = crc32(b);
    const head = Buffer.alloc(30);
    head.writeUInt32LE(0x04034b50, 0);
    head.writeUInt16LE(20, 4);
    head.writeUInt32LE(crc, 14);
    head.writeUInt32LE(b.length, 18);
    head.writeUInt32LE(b.length, 22);
    head.writeUInt16LE(n.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(b.length, 20);
    central.writeUInt32LE(b.length, 24);
    central.writeUInt16LE(n.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(head, n, b);
    centers.push(central, n);
    offset += head.length + n.length + b.length;
    cdSize += central.length + n.length;
  }
  const tail = Buffer.alloc(22);
  tail.writeUInt32LE(0x06054b50, 0);
  tail.writeUInt16LE(entries.length, 8);
  tail.writeUInt16LE(entries.length, 10);
  tail.writeUInt32LE(cdSize, 12);
  tail.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, ...centers, tail]);
}
function packageFor(entry) {
  return zip([["[Content_Types].xml"], ["_rels/.rels"], [entry]]);
}
const DOC = packageFor("word/document.xml");
const PPT = packageFor("ppt/presentation.xml");
const XLS = packageFor("xl/workbook.xml");

test("OOXML 结构：DOCX/PPTX/XLSX 正确区分", () => {
  assert.equal(detectOoxml(DOC), MIME.docx);
  assert.equal(detectOoxml(PPT), MIME.pptx);
  assert.equal(detectOoxml(XLS), MIME.xlsx);
});
test("拦截普通 ZIP、伪造包头、类型冲突和宏附件", () => {
  assert.equal(detectOoxml(zip([["readme.txt"]])), null);
  assert.equal(detectOoxml(Buffer.from("PK\\x03\\x04 fake")), null);
  assert.equal(detectOoxml(zip([["[Content_Types].xml"], ["_rels/.rels"], ["word/document.xml"], ["ppt/presentation.xml"]])), null);
  assert.equal(detectOoxml(zip([["[Content_Types].xml"], ["_rels/.rels"], ["word/document.xml"], ["word/vbaProject.bin"]])), null);
});

const PORT = 8878;
const BASE = "http://127.0.0.1:" + PORT;
const DB = path.join(__dirname, "..", "data", "test-office.db");
const DIR = path.join(__dirname, "..", "data", "test-office-uploads");
let proc, exec, guest;
async function api(method, route, cookie, data) {
  const res = await fetch(BASE + route, {
    method, headers: { cookie, ...(data === undefined ? {} : { "content-type": "application/json" }) },
    body: data === undefined ? undefined : JSON.stringify(data)
  });
  const txt = await res.text();
  let body;
  try { body = JSON.parse(txt); } catch { body = txt; }
  return { status: res.status, body };
}
async function login(user) {
  const r = await fetch(BASE + "/api/auth/login", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: user, password: "123456" })
  });
  assert.equal(r.status, 200);
  return r.headers.get("set-cookie").split(";")[0];
}
async function upload(buf, fileName, cookie) {
  const res = await fetch(BASE + "/api/uploads", {
    method: "POST", headers: { cookie, "content-type": "application/octet-stream",
      "x-file-name": encodeURIComponent(fileName) }, body: buf
  });
  return { status: res.status, body: await res.json() };
}
before(async () => {
  for (const x of [DB, DB + "-wal", DB + "-shm"]) if (fs.existsSync(x)) fs.unlinkSync(x);
  fs.rmSync(DIR, { recursive: true, force: true });
  proc = spawn(process.execPath, ["--experimental-sqlite", "server/index.js"], {
    cwd: path.join(__dirname, ".."),
    env: { ...process.env, ERP_PORT: String(PORT), ERP_DB: DB, ERP_UPLOAD_DIR: DIR },
    stdio: ["ignore", "pipe", "pipe"]
  });
  proc.stderr.on("data", d => {
    const msg = String(d);
    if (!msg.includes("ExperimentalWarning")) process.stderr.write("[office test] " + msg);
  });
  for (let i = 0; i < 180; i++) {
    try {
      const r = await fetch(BASE + "/api/health");
      if (r.ok) break;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 200));
    if (i === 179) throw Error("Office test server startup timed out");
  }
  exec = await login("exec");
  guest = await login("guest");
});
after(() => {
  if (proc) proc.kill("SIGTERM");
  fs.rmSync(DIR, { recursive: true, force: true });
  for (const x of [DB, DB + "-wal", DB + "-shm"]) {
    try { fs.unlinkSync(x); } catch {}
  }
});

for (const [extension, bytes, mime] of [
  ["docx", DOC, MIME.docx],
  ["pptx", PPT, MIME.pptx],
  ["xlsx", XLS, MIME.xlsx]
]) {
  test("真实 HTTP：" + extension + " 上传→材料归属→下载完整回环", async () => {
    const list = await api("GET", "/api/projects", exec);
    const p = list.body.rows.find(x => x.status !== "已归档");
    assert.ok(p, "exec must have an active meeting");
    const uploaded = await upload(bytes, "会务材料." + extension, exec);
    assert.equal(uploaded.status, 200, JSON.stringify(uploaded.body));
    assert.match(uploaded.body.key, new RegExp("\\." + extension + "$"));
    assert.equal(uploaded.body.mime, mime);
    const kind = extension === "xlsx" ? "劳务收集表" : extension === "pptx" ? "课件" : "串场";
    const add = await api("POST", "/api/projects/" + p.id + "/materials", exec, {
      kind, name: "资料-" + extension, file_key: uploaded.body.key,
      file_mime: mime, file_name: uploaded.body.name, file_size: bytes.length
    });
    assert.equal(add.status, 200, JSON.stringify(add.body));
    const dl = await fetch(BASE + "/api/uploads/" + uploaded.body.key, { headers: { cookie: exec } });
    assert.equal(dl.status, 200);
    assert.equal(dl.headers.get("content-type"), mime);
    assert.deepEqual(Buffer.from(await dl.arrayBuffer()), bytes);
    const deny = await api("GET", "/api/uploads/" + uploaded.body.key, guest);
    assert.equal(deny.status, 403, "guest cannot access internal business material");
  });
}
test("真实 HTTP：普通 ZIP、伪 PPTX、错扩展名拒绝", async () => {
  const generic = await upload(zip([["foo.txt"]]), "普通.zip", exec);
  assert.equal(generic.status, 400);
  const fake = await upload(Buffer.from("PK\\x03\\x04 fake ppt"), "课件.pptx", exec);
  assert.equal(fake.status, 400);
  const wrong = await upload(PPT, "材料.docx", exec);
  assert.equal(wrong.status, 400);
});

test("讲者照片必须是真实图片附件，不能仅登记文字或关联 Office 文件", async () => {
  const p = (await api("GET", "/api/projects", exec)).body.rows.find(x => x.status !== "已归档");
  const empty = await api("POST", "/api/projects/" + p.id + "/materials", exec, {
    kind: "讲者照片", name: "张教授"
  });
  assert.equal(empty.status, 400);
  const up = await upload(DOC, "讲者.docx", exec);
  assert.equal(up.status, 200);
  const wrong = await api("POST", "/api/projects/" + p.id + "/materials", exec, {
    kind: "讲者照片", name: "张教授", file_key: up.body.key,
    file_name: up.body.name, file_mime: up.body.mime, file_size: up.body.size
  });
  assert.equal(wrong.status, 400);
});
