"use strict";
/**
 * Cloudflare post-deployment smoke: verify real archived PDF download + RBAC
 * without creating or resetting any business data.
 */
const assert = require("node:assert/strict");
const { PDFDocument } = require("pdf-lib");
const BASE = process.env.ERP_BASE || "https://erp.aibuild.work";

async function login(username) {
  const r = await fetch(BASE + "/api/auth/login", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password: "123456" })
  });
  assert.equal(r.status, 200, username + " demo login");
  return (r.headers.get("set-cookie") || "").split(";")[0];
}
async function request(cookie, endpoint) {
  return fetch(BASE + endpoint, { headers: { Cookie: cookie } });
}
(async () => {
  const cookies = {};
  for (const name of ["admin", "assoc", "finance", "guest"]) cookies[name] = await login(name);
  const list = await request(cookies.admin, "/api/projects?size=200");
  assert.equal(list.status, 200);
  const rows = (await list.json()).rows;
  const archivedOwn = rows.find(p => p.status === "已归档" && p.assoc === "华东医学会");
  const notArchived = rows.find(p => p.status !== "已归档" && p.assoc === "华东医学会");
  assert.ok(archivedOwn && notArchived, "expected seeded demo projects");
  const endpoint = "/api/projects/" + encodeURIComponent(archivedOwn.id) + "/archive-pdf";
  for (const role of ["admin", "assoc"]) {
    const response = await request(cookies[role], endpoint);
    assert.equal(response.status, 200, role + " download");
    assert.match(response.headers.get("content-type") || "", /^application\/pdf/);
    assert.match(response.headers.get("content-disposition") || "", /attachment/);
    assert.equal(response.headers.get("cache-control"), "no-store");
    const bytes = new Uint8Array(await response.arrayBuffer());
    assert.ok(bytes.length > 1200 && Buffer.from(bytes).toString("ascii",0,5) === "%PDF-");
    const pdf = await PDFDocument.load(bytes);
    assert.ok(pdf.getPageCount() >= 1);
    console.log("PASS archive PDF", role, archivedOwn.id, bytes.length, "bytes", pdf.getPageCount(), "pages");
  }
  for (const role of ["finance", "guest"]) {
    const response = await request(cookies[role], endpoint);
    assert.equal(response.status, 403, role + " must be denied");
    console.log("PASS archive PDF denied", role);
  }
  const unfinished = await request(cookies.admin,
    "/api/projects/" + encodeURIComponent(notArchived.id) + "/archive-pdf");
  assert.equal(unfinished.status, 409);
  console.log("PASS unfinished project blocked");
  for (const url of ["/assets/js/pages/projects.js", "/assets/js/pages/project.js", "/assets/js/pages/archive.js"]) {
    const r = await fetch(BASE + url);
    assert.equal(r.status, 200);
    assert.ok((await r.text()).includes("资料下载"), url + " UI lacks download button");
    console.log("PASS UI asset contains PDF action", url);
  }
  console.log("ARCHIVE_PDF_LIVE_PASS");
})().catch(err => { console.error("ARCHIVE_PDF_LIVE_FAIL", err.message); process.exitCode = 1; });
