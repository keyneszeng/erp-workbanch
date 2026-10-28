"use strict";
/**
 * Downloaded archive dossier: real API, all 5 roles and PDF merge/attachment.
 * Run: node --experimental-sqlite --test test/archive-pdf.test.js
 */
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const { PDFDocument } = require("pdf-lib");
const fs = require("node:fs");
const path = require("node:path");

const PORT = 8898;
const BASE = "http://127.0.0.1:" + PORT;
const DB = path.join(__dirname, "..", "data", "test-archive-pdf.db");
let proc;
let users = {};

async function waitReady() {
  for (let i = 0; i < 170; i++) {
    try { if ((await fetch(BASE + "/api/health")).ok) return; } catch {}
    await new Promise(r => setTimeout(r, 200));
  }
  throw Error("Archive PDF API test server did not start");
}
async function login(username) {
  const res = await fetch(BASE + "/api/auth/login", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password: "123456" })
  });
  assert.equal(res.status, 200, "login " + username);
  return (res.headers.get("set-cookie") || "").split(";")[0];
}
async function get(username, pid) {
  return fetch(BASE + "/api/projects/" + pid + "/archive-pdf", {
    headers: username ? { Cookie: users[username] } : {}
  });
}
before(async () => {
  for (const f of [DB, DB + "-wal", DB + "-shm"]) {
    if (fs.existsSync(f)) fs.renameSync(f, f + ".old");
  }
  proc = spawn(process.execPath, ["--experimental-sqlite", "server/index.js"], {
    cwd: path.join(__dirname, ".."),
    env: { ...process.env, ERP_PORT: String(PORT), ERP_DB: DB },
    stdio: ["ignore", "pipe", "pipe"]
  });
  proc.stderr.on("data", d => {
    if (!d.toString().includes("ExperimentalWarning")) process.stderr.write("[archive-pdf-test] " + d);
  });
  await waitReady();
  for (const user of ["admin", "assoc", "exec", "finance", "guest", "sunqian"]) {
    users[user] = await login(user);
  }
});
after(() => { if (proc) proc.kill("SIGTERM"); });

test("archived own-association project generates downloadable multipage Chinese PDF", async () => {
  const res = await get("assoc", "MP-2026-015");
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type"), /^application\/pdf/);
  assert.match(res.headers.get("content-disposition"), /attachment/i);
  assert.match(res.headers.get("content-disposition"), /MP-2026-015/);
  assert.equal(res.headers.get("cache-control"), "no-store");
  const bytes = Buffer.from(await res.arrayBuffer());
  assert.equal(bytes.toString("ascii", 0, 8), "%PDF-1.4");
  assert.ok(bytes.length > 1500);
  const doc = await PDFDocument.load(bytes);
  assert.ok(doc.getPageCount() >= 2);
  const title = "核销资料封存卷宗";
  const expected = Buffer.from(title, "utf16le");
  const be = Buffer.from(expected);
  for (let i = 0; i < be.length; i += 2) [be[i], be[i + 1]] = [be[i + 1], be[i]];
  assert.ok(bytes.toString("latin1").includes(be.toString("hex").toUpperCase()),
    "Chinese dossier heading must be present as selectable Unicode text");
});

test("super administrator can download an archived project in another association", async () => {
  const res = await get("admin", "MP-2026-007");
  assert.equal(res.status, 200);
  const doc = await PDFDocument.load(await res.arrayBuffer());
  assert.ok(doc.getPageCount() > 0);
});

test("another association manager can access only their own association", async () => {
  assert.equal((await get("sunqian", "MP-2026-007")).status, 200);
  assert.equal((await get("sunqian", "MP-2026-015")).status, 403);
  assert.equal((await get("assoc", "MP-2026-007")).status, 403);
});

test("finance, meeting executor, and guest cannot access an archived dossier", async () => {
  for (const role of ["finance", "exec", "guest"]) {
    const res = await get(role, "MP-2026-015");
    assert.equal(res.status, 403, role + " unexpectedly downloaded PDF");
    const payload = await res.json();
    assert.equal(payload.error.code, "FORBIDDEN");
  }
});

test("not-archived meetings cannot download PDF (even as admin)", async () => {
  for (const role of ["admin", "assoc"]) {
    const res = await get(role, "MP-2026-001");
    assert.equal(res.status, 409);
    const body = await res.json();
    assert.equal(body.error.code, "ARCHIVE_REQUIRED");
  }
});

test("missing project and unauthenticated requests are rejected", async () => {
  assert.equal((await get("admin", "MP-2026-999999")).status, 404);
  assert.equal((await get(null, "MP-2026-015")).status, 401);
});

test("PDF original pages are appended, with source preserved as embedded file", async () => {
  const { createReportPdf, buildArchivePdf } = require("../server/lib/archive-pdf");
  const original = await PDFDocument.create();
  original.addPage([300, 300]);
  const sourceBytes = Buffer.from(await original.save());
  const snapshot = {
    project: { id: "MP-TEST", name: "核销档案测试", assoc: "华东医学会",
      status: "已归档", date: "2026-10-28", days: 1, budget: 100, people: 20, form: "线下" },
    verifySteps: [{ step_no: 1, name: "预算核销", result: "通过", checked_by: "财务" }],
    materials: [{ kind: "合同", name: "合同PDF", file_key: "sample.pdf", file_name: "签署合同.pdf" }],
    contracts: [], payments: [], approvals: [], exceptions: [], auditLogs: [], demandItems: []
  };
  const out = await buildArchivePdf(snapshot, { name: "stub", get: async key =>
    key === "sample.pdf" ? { buffer: sourceBytes } : null });
  const result = await PDFDocument.load(out);
  const report = await PDFDocument.load(createReportPdf([{ text: "中文核销测试", kind: "title" }], "资料下载"));
  assert.ok(result.getPageCount() > report.getPageCount());
  assert.ok(out.toString("latin1").includes("/EmbeddedFiles"), "original PDF should be embedded");
});

test("missing file storage does not pretend originals were included", async () => {
  const { buildArchivePdf } = require("../server/lib/archive-pdf");
  const snapshot = {
    project: { id: "MP-TEST-2", name: "缺失附件标识", status: "已归档" },
    materials: [{ kind: "发票", name: "发票A", file_key: "lost.pdf", file_name: "发票原件.pdf" }],
    verifySteps: [], contracts: [], payments: [], approvals: [], exceptions: [], auditLogs: [], demandItems: []
  };
  const file = await buildArchivePdf(snapshot, {
    name: "unavailable",
    get: async () => { const e = Error("R2 not configured"); e.code = "STORAGE_UNAVAILABLE"; throw e; }
  });
  const text = file.toString("latin1");
  const str = "文件存储未配置";
  const le = Buffer.from(str, "utf16le"); const be = Buffer.from(le);
  for (let i = 0; i < be.length; i += 2) [be[i], be[i + 1]] = [be[i + 1], be[i]];
  assert.ok(text.includes(be.toString("hex").toUpperCase()), "missing original must be disclosed in PDF");
});
