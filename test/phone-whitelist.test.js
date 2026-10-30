"use strict";
/** 生产手机号白名单 + SMS 改密 + 权限 + 会话端到端测试 */
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "erp-mobile-auth-"));
const file = path.join(dir, "erp.db");
const PORT = 9500 + (process.pid % 400);
const BASE = "http://127.0.0.1:" + PORT;
const ROOT = "13800138000";
const STAFF = "13900139000";
let proc;
async function call(method, uri, body, cookie = "") {
  const r = await fetch(BASE + uri, { method, headers: { "Content-Type": "application/json", cookie },
    body: body ? JSON.stringify(body) : undefined });
  const data = await r.json();
  return { status: r.status, data, cookie: (r.headers.get("set-cookie") || "").split(";")[0] };
}
const login = (phone, password) => call("POST", "/api/auth/login", { username: phone, password });
before(async () => {
  proc = spawn(process.execPath, ["--experimental-sqlite", "server/index.js"], {
    cwd: path.resolve(__dirname, ".."), stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, NODE_ENV: "test", ERP_SMS_PROVIDER: "test", ERP_SMS_TEST_MODE: "1",
      ERP_DEMO_MODE: "0", ERP_DB_BACKEND: "", ERP_DB: file, ERP_PORT: String(PORT),
      ERP_BOOTSTRAP_ADMIN_PHONE: ROOT, ERP_SESSION_FALLBACK: "0" }
  });
  let logs = "";
  proc.stderr.on("data", b => { logs += b.toString(); });
  const start = Date.now();
  while (Date.now() - start < 16000) {
    if (proc.exitCode !== null) throw new Error("服务器启动失败：" + logs.slice(0, 1500));
    try { if ((await call("GET", "/api/health")).status === 200) return; } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error("生产服务器启动超时：" + logs.slice(0, 1500));
});
after(() => {
  if (proc) proc.kill("SIGTERM");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("生产：手机号唯一、首次强制改密、短信验证、只有总管理员可管理白名单", async () => {
  assert.equal((await login("admin", "123456")).status, 401, "不得继续用 admin 用户名登录");
  assert.equal((await login("13700000000", "123456")).status, 401, "未列入白名单者不能登录");
  const root = await login(ROOT, "123456");
  assert.equal(root.status, 200, JSON.stringify(root.data));
  assert.equal(root.data.user.mustChangePassword, true);
  const oldCookie = root.cookie;
  assert.equal((await call("GET", "/api/dashboard", null, oldCookie)).status, 403, "未改密不得进入业务");
  assert.equal((await call("POST", "/api/users", { phone: STAFF, name: "测试", role: "user" }, oldCookie)).status, 403, "未改密不得管理白名单");
  assert.equal((await call("POST", "/api/auth/password", { oldPassword: "123456", newPassword: "StrongAdmin9876" }, oldCookie)).status, 400, "无短信不得改密");
  const sent = await call("POST", "/api/auth/sms/send", {}, oldCookie);
  assert.equal(sent.status, 200, JSON.stringify(sent.data));
  assert.ok(!JSON.stringify(sent.data).includes("654321"), "短信验证码绝不返回给客户端");
  assert.equal((await call("POST", "/api/auth/sms/send", {}, oldCookie)).status, 429, "发送间隔 60 秒");
  assert.equal((await call("POST", "/api/auth/password",
    { oldPassword: "123456", newPassword: "StrongAdmin9876", smsCode: "000000" }, oldCookie)).status, 400);
  const change = await call("POST", "/api/auth/password",
    { oldPassword: "123456", newPassword: "StrongAdmin9876", smsCode: "654321" }, oldCookie);
  assert.equal(change.status, 200, JSON.stringify(change.data));
  assert.equal((await call("GET", "/api/auth/me", null, oldCookie)).data.user, null, "旧会话被吊销");
  const freshCookie = change.cookie;
  assert.equal((await call("GET", "/api/auth/me", null, freshCookie)).data.user.mustChangePassword, false);
  assert.equal((await call("POST", "/api/auth/password", { oldPassword: "StrongAdmin9876", newPassword: "AnotherStrong2026", smsCode: "654321" }, freshCookie)).status, 400, "已使用的验证码不可再次用来改密");
  assert.equal((await login(ROOT, "123456")).status, 401, "初始密码不可再次使用");
  assert.equal((await login(ROOT, "StrongAdmin9876")).status, 200);

  assert.equal((await call("POST", "/api/users", { phone: ROOT, name: "重复", role: "user" }, freshCookie)).status, 409);
  assert.equal((await call("POST", "/api/users", { phone: STAFF, name: "越级", role: "admin" }, freshCookie)).status, 400);
  assert.equal((await call("PATCH", "/api/users/1", { phone: STAFF }, freshCookie)).status, 400, "总管理员身份不可篡改");
  const created = await call("POST", "/api/users", { phone: STAFF, name: "白名单员工", role: "user" }, freshCookie);
  assert.equal(created.status, 200, JSON.stringify(created.data));
  assert.equal((await login(STAFF, "123456")).status, 200);
  const staffLogin = await login(STAFF, "123456");
  assert.equal((await call("POST", "/api/users", { phone: "13700137000", name: "越权", role: "user" }, staffLogin.cookie)).status, 403);
  const staffSms = await call("POST", "/api/auth/sms/send", {}, staffLogin.cookie);
  assert.equal(staffSms.status, 200, JSON.stringify(staffSms.data));
  const staffChanged = await call("POST", "/api/auth/password",
    { oldPassword: "123456", newPassword: "StaffStrong2026", smsCode: "654321" }, staffLogin.cookie);
  assert.equal(staffChanged.status, 200, JSON.stringify(staffChanged.data));
  const disabled = await call("PATCH", "/api/users/" + created.data.user.id, { active: 0 }, freshCookie);
  assert.equal(disabled.status, 200, JSON.stringify(disabled.data));
  assert.equal((await login(STAFF, "StaffStrong2026")).status, 401, "停用白名单必须禁止登录");
  assert.equal((await call("GET", "/api/dashboard", null, staffChanged.cookie)).status, 401, "停用后旧会话立即失效");
});
