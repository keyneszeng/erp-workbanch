"use strict";
/**
 * QA-20261028: permissions and decision validation regression tests.
 * Run: node --experimental-sqlite --test test/qa-rbac-regression.test.js
 */
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const PORT = 8873;
const BASE = `http://127.0.0.1:${PORT}`;
const DB = path.join(__dirname, "..", "data", "qa-rbac-8873.db");
let proc;
let admin, assoc, finance, guest;

async function waitReady() {
  for (let i = 0; i < 160; i++) {
    try {
      const r = await fetch(BASE + "/api/health");
      if (r.ok) return;
    } catch {}
    await new Promise((done) => setTimeout(done, 200));
  }
  throw new Error("QA test server did not start");
}

async function login(username) {
  const r = await fetch(BASE + "/api/auth/login", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password: "123456" })
  });
  assert.equal(r.status, 200, username + " login");
  return r.headers.get("set-cookie").split(";")[0];
}

function client(cookie) {
  return async (method, endpoint, body) => {
    const response = await fetch(BASE + endpoint, {
      method, headers: { cookie, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    return { status: response.status, body: await response.json() };
  };
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
  proc.stderr.on("data", (d) => {
    const s = d.toString();
    if (!s.includes("ExperimentalWarning")) process.stderr.write("[qa-srv] " + s);
  });
  await waitReady();
  admin = client(await login("admin"));
  assoc = client(await login("assoc"));
  finance = client(await login("finance"));
  guest = client(await login("guest"));
});
after(() => { if (proc) proc.kill("SIGTERM"); });

test("guest project list excludes financial and contact fields", async () => {
  const r = await guest("GET", "/api/projects?page=1&size=50");
  assert.equal(r.status, 200);
  assert.ok(r.body.rows.length > 0);
  for (const p of r.body.rows) {
    for (const k of ["budget", "paid_amt", "phone", "created_by", "owner_id"]) {
      assert.equal(Object.hasOwn(p, k), false, "participant list leaked " + k);
    }
  }
  assert.equal(r.body.summary, null);
});

test("guest project detail contains only the public meeting overview", async () => {
  const r = await guest("GET", "/api/projects/MP-2026-005");
  assert.equal(r.status, 200);
  assert.equal(r.body.visibility, "participant");
  assert.deepEqual(r.body.actions, []);
  for (const k of ["approvals", "payments", "contracts", "guests", "members", "timeline", "settlement", "verification", "paidTotal"]) {
    assert.equal(Object.hasOwn(r.body, k), false, "guest detail leaked " + k);
  }
  for (const k of ["phone", "budget", "created_by", "owner_id"]) {
    assert.equal(Object.hasOwn(r.body.project, k), false, "guest project leaked " + k);
  }
  const internal = await admin("GET", "/api/projects/MP-2026-005");
  assert.equal(internal.status, 200);
  assert.ok(Array.isArray(internal.body.contracts));
});

test("guest dashboard redacts budget, paid amounts, and activity logs", async () => {
  const r = await guest("GET", "/api/dashboard");
  assert.equal(r.status, 200);
  assert.equal(r.body.budget, null);
  assert.equal(r.body.paid, null);
  assert.deepEqual(r.body.recent, []);
  for (const row of r.body.statusRows) assert.equal(Object.hasOwn(row, "budget"), false);
  for (const p of r.body.upcoming) assert.equal(Object.hasOwn(p, "budget"), false);
});

test("association manager cannot create a project under another association", async () => {
  const r = await assoc("POST", "/api/projects", {
    name: "跨协会越权QA", assoc: "肿瘤分会", form: "线下",
    date: "2027-09-20", budget: 1234, owner: "王敏", agenda: "QA测试议程安排"
  });
  assert.equal(r.status, 403);
  assert.equal(r.body.error.code, "FORBIDDEN");
});

test("association manager cannot change project association", async () => {
  const r = await assoc("PATCH", "/api/projects/MP-2026-001", { assoc: "肿瘤分会" });
  assert.equal(r.status, 403);
  const detail = await assoc("GET", "/api/projects/MP-2026-001");
  assert.equal(detail.body.project.assoc, "华东医学会");
});

test("payment approval must contain an explicit boolean decision", async () => {
  const list = await finance("GET", "/api/payments?status=待审批");
  assert.equal(list.status, 200);
  assert.ok(list.body.rows.length > 0, "demo fixtures should contain pending payments");
  const id = list.body.rows[0].id;
  for (const body of [{}, { approve: "true" }, { approve: 1 }]) {
    const r = await finance("POST", "/api/payments/" + id + "/approve", body);
    assert.equal(r.status, 400);
  }
  const afterCheck = await finance("GET", "/api/payments?status=待审批");
  assert.ok(afterCheck.body.rows.some((p) => p.id === id), "invalid decision must not mutate payment");
});

test("unified approval API rejects ambiguous decisions", async () => {
  const list = await admin("GET", "/api/approvals?status=待审批");
  assert.equal(list.status, 200);
  assert.ok(list.body.rows.length > 0);
  const id = list.body.rows[0].id;
  for (const body of [{}, { approve: "false" }, { approve: null }]) {
    const r = await admin("POST", "/api/approvals/" + id + "/decide", body);
    assert.equal(r.status, 400);
  }
  const afterCheck = await admin("GET", "/api/approvals?status=待审批");
  assert.ok(afterCheck.body.rows.some((p) => p.id === id), "invalid decision must not mutate approval");
});

test("guest cannot bypass tabs via verification, audit, or demand export API", async () => {
  for (const url of [
    "/api/projects/MP-2026-005/verify",
    "/api/projects/MP-2026-005/timeline",
    "/api/demand/MP-2026-005/export"
  ]) {
    const r = await guest("GET", url);
    assert.equal(r.status, 403, url + " must be forbidden");
  }
});

test("pending files are owner-scoped, and upload cannot claim a foreign project", async () => {
  const rawCookie = await login("assoc");
  const otherCookie = await login("sunqian");
  const pdf = Buffer.from("%PDF-1.4\\n1 0 obj <<>> endobj\\n%%EOF\\n");
  const upload = async (cookie, pid) => fetch(BASE + "/api/uploads?pid=" + pid, {
    method: "POST",
    headers: { cookie, "Content-Type": "application/pdf", "x-file-name": "qa.pdf" },
    body: pdf
  });
  const denied = await upload(rawCookie, "MP-2026-007");
  assert.equal(denied.status, 403);
  const ok = await upload(rawCookie, "MP-2026-001");
  assert.equal(ok.status, 200);
  const doc = await ok.json();
  const byOwner = await fetch(BASE + doc.url, { headers: { cookie: rawCookie } });
  assert.equal(byOwner.status, 200);
  const byOther = await fetch(BASE + doc.url, { headers: { cookie: otherCookie } });
  assert.equal(byOther.status, 403);
});
