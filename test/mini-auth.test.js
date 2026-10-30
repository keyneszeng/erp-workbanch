"use strict";
/** WeChat mini-program production regression; fake WeChat and SMS are TEST-ONLY. */
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { spawn } = require("node:child_process");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "erp-mini-prod-"));
const DB = path.join(dir, "db.sqlite");
const port = 11700 + (process.pid % 800);
const host = "http://127.0.0.1:" + port;
const ADMIN = "13800138000";
const STAFF = "13900139000";
let child;
const bearer = token => token ? { Authorization: "Bearer " + token } : {};
async function req(method, route, payload, headers = {}) {
  const r = await fetch(host + route, { method, headers: { "Content-Type": "application/json", ...headers },
    body: payload == null ? undefined : JSON.stringify(payload) });
  return { status: r.status, body: await r.json(), cookie: (r.headers.get("set-cookie")||"").split(";")[0] };
}
before(async () => {
  child = spawn(process.execPath, ["--experimental-sqlite", "server/index.js"], {
    cwd: path.resolve(__dirname, ".."), stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, NODE_ENV: "test", ERP_DEMO_MODE: "0", ERP_DB_BACKEND: "", ERP_DB: DB,
      ERP_PORT: String(port), ERP_HOST: "127.0.0.1", ERP_BOOTSTRAP_ADMIN_PHONE: ADMIN,
      ERP_SESSION_FALLBACK: "0", ERP_SMS_PROVIDER: "test", ERP_SMS_TEST_MODE: "1",
      ERP_MINIPROGRAM_ENABLED: "1", ERP_WECHAT_TEST_MODE: "1",
      ERP_WECHAT_APP_ID: "", ERP_WECHAT_APP_SECRET: "" }
  });
  let error = "";
  child.stderr.on("data", b => error += b.toString());
  const start = Date.now();
  while (Date.now()-start < 18000) {
    if (child.exitCode !== null) throw Error("Mini test server died: "+error);
    try { if ((await req("GET","/api/health")).status === 200) return; } catch {}
    await new Promise(done => setTimeout(done, 85));
  }
  throw Error("Mini test server not ready: "+error);
});
after(() => {
  if(child)child.kill("SIGTERM");
  fs.rmSync(dir,{recursive:true,force:true});
});
test("Wechat production: verified binding, mobile bearer access, RBAC, reset and revocation", async () => {
  let root=await req("POST","/api/auth/login",{username:ADMIN,password:"123456"});
  assert.equal(root.status,200);
  let sent=await req("POST","/api/auth/sms/send",{}, {Cookie:root.cookie});
  assert.equal(sent.status,200);
  let changed=await req("POST","/api/auth/password",{oldPassword:"123456",newPassword:"AdminSafer2026",smsCode:"654321"},{Cookie:root.cookie});
  assert.equal(changed.status,200,JSON.stringify(changed.body));
  const adminCookie=changed.cookie;
  let created=await req("POST","/api/users",{phone:STAFF,name:"小程序员工",role:"user"},{Cookie:adminCookie});
  assert.equal(created.status,200,JSON.stringify(created.body));
  const staffId=created.body.user.id;
  const code="test_worker_123456";
  assert.equal((await req("POST","/api/mini/auth/login",{code})).body.error.code,"WECHAT_UNBOUND");
  assert.equal((await req("POST","/api/mini/auth/sms/send",{phone:STAFF,password:"incorrect"})).status,401);
  sent=await req("POST","/api/mini/auth/sms/send",{phone:STAFF,password:"123456"});
  assert.equal(sent.status,200,JSON.stringify(sent.body));
  assert.equal(JSON.stringify(sent.body).includes("654321"),false,"SMS must never reach the client");
  assert.equal((await req("POST","/api/mini/auth/bind",{code,phone:STAFF,password:"123456",smsCode:"654321"})).status,400,"initial password must be changed");
  assert.equal((await req("POST","/api/mini/auth/bind",{code,phone:STAFF,password:"123456",smsCode:"000000",newPassword:"NewStaff2026"})).status,400,"SMS code must match");
  let bound=await req("POST","/api/mini/auth/bind",{code,phone:STAFF,password:"123456",smsCode:"654321",newPassword:"NewStaff2026"});
  assert.equal(bound.status,200,JSON.stringify(bound.body));
  assert.ok(bound.body.accessToken);
  assert.equal(bound.body.user.mustChangePassword,false);
  assert.equal((await req("GET","/api/mini/auth/me")).status,401);
  assert.equal((await req("GET","/api/mini/auth/me",null,bearer(bound.body.accessToken))).status,200);
  assert.equal((await req("GET","/api/projects",null,bearer(bound.body.accessToken))).status,200);
  assert.equal((await req("GET","/api/approvals",null,bearer(bound.body.accessToken))).status,403,"guest cannot approve");
  assert.equal((await req("POST","/api/users",{phone:"13600136000",name:"越权",role:"user"},bearer(bound.body.accessToken))).status,403);
  assert.equal((await req("GET","/api/dashboard",null,{Cookie:adminCookie,Authorization:"Bearer broken"})).status,401,
    "bad bearer must not fall back to admin browser cookie");
  assert.equal((await req("POST","/api/mini/auth/login",{code})).status,200,"bound WeChat login can resume");
  assert.equal((await req("POST","/api/mini/auth/bind",{code:"test_other_device",phone:STAFF,password:"NewStaff2026",smsCode:"654321"})).body.error.code,"WECHAT_ALREADY_BOUND");
  assert.equal((await req("POST","/api/mini/auth/logout",{},bearer(bound.body.accessToken))).status,200);
  assert.equal((await req("GET","/api/mini/auth/me",null,bearer(bound.body.accessToken))).status,401,"logout revokes bearer");
  const again=await req("POST","/api/mini/auth/login",{code});
  assert.equal(again.status,200);
  const reset=await req("PATCH","/api/users/"+staffId,{resetPassword:true},{Cookie:adminCookie});
  assert.equal(reset.status,200,JSON.stringify(reset.body));
  assert.equal((await req("GET","/api/projects",null,bearer(again.body.accessToken))).status,401,"admin reset invalidates bearer");
  assert.equal((await req("POST","/api/mini/auth/login",{code})).body.error.code,"WECHAT_UNBOUND","admin reset removes old OpenID binding");
});
test("WeChat provider cannot be used with arbitrary test code or invalid sessions", async () => {
  assert.equal((await req("POST","/api/mini/auth/login",{code:"abc-def-ghi"})).status,401);
  assert.equal((await req("GET","/api/mini/auth/me",null,{Authorization:"Basic abc"})).status,401);
  assert.equal((await req("GET","/api/mini/auth/me",null,{Authorization:"Bearer invalid"})).status,401);
});
