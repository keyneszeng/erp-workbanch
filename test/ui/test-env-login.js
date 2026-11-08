"use strict";
// 端到端验证：云服务器测试环境能否在没有真实短信的情况下走完首次登录。
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "erp-testenv-"));
const port = 12994;
const root = "http://127.0.0.1:" + port;
const phone = "13800138000";
const code = "654321";
let proc, log = "";

function req(method, url, data, cookie = "") {
  return fetch(root + url, {
    method,
    headers: { "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}) },
    body: data === undefined ? undefined : JSON.stringify(data)
  }).then(async r => ({
    status: r.status,
    body: await r.json().catch(() => null),
    cookie: (r.headers.get("set-cookie") || "").split(";")[0]
  }));
}
const ok = (label, cond, extra = "") => {
  console.log((cond ? "  PASS  " : "  FAIL  ") + label + (extra ? "  " + extra : ""));
  if (!cond) process.exitCode = 1;
};

(async () => {
  proc = spawn(process.execPath, ["--experimental-sqlite", "server/index.js"], {
    cwd: path.resolve(__dirname, "..", ".."),
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      NODE_ENV: "production",
      ERP_DEPLOY_TARGET: "aliyun-ecs-test",
      ERP_DEMO_MODE: "0",
      ERP_PRODUCTION_DOMAIN: "",
      ERP_BOOTSTRAP_ADMIN_PHONE: phone,
      ERP_DB: path.join(dir, "erp.db"),
      ERP_UPLOAD_DIR: path.join(dir, "uploads"),
      ERP_PORT: String(port),
      ERP_HOST: "127.0.0.1",
      ERP_TRUST_PROXY: "1",
      ERP_SESSION_FALLBACK: "0",
      ERP_SECRET: "TestEnvOnly-HighEntropy-Secret-2026-ABCDEFGH",
      ERP_SMS_PROVIDER: "console",
      ERP_TEST_FIXED_SMS_CODE: code
    }
  });
  proc.stdout.on("data", b => (log += String(b)));
  proc.stderr.on("data", b => (log += String(b)));

  for (let i = 0; i < 600; i++) {
    if (proc.exitCode !== null) { console.log("服务启动失败：\n" + log); process.exit(1); }
    try { if ((await req("GET", "/api/health")).status === 200) break; } catch {}
    await new Promise(r => setTimeout(r, 100));
  }

  const health = await req("GET", "/api/health");
  ok("健康检查可用", health.status === 200);
  ok("健康检查标识为测试环境", health.body.env === "test", "env=" + health.body.env);

  const login = await req("POST", "/api/auth/login", { username: phone, password: "123456" });
  ok("初始密码可登录", login.status === 200, JSON.stringify(login.body).slice(0, 80));
  ok("首次登录被要求改密", login.body?.user?.mustChangePassword === true);

  const send = await req("POST", "/api/auth/sms/send", {}, login.cookie);
  ok("验证码发送接口放行（console 通道）", send.status === 200, JSON.stringify(send.body).slice(0, 80));
  ok("验证码不通过接口返回", !JSON.stringify(send.body).includes(code));

  const change = await req("POST", "/api/auth/password",
    { oldPassword: "123456", newPassword: "TestEnv2026Strong", smsCode: code }, login.cookie);
  ok("固定验证码可完成改密", change.status === 200, JSON.stringify(change.body).slice(0, 100));

  const me = await req("GET", "/api/auth/me", undefined, change.cookie);
  ok("改密后进入业务态", me.status === 200 && me.body?.user?.mustChangePassword === false);

  const bad = await req("POST", "/api/auth/login", { username: phone, password: "123456" });
  ok("旧密码已失效", bad.status !== 200);

  ok("日志中出现 console 验证码记录", log.includes("[SMS-CONSOLE]"));

  proc.kill("SIGTERM");
  fs.rmSync(dir, { recursive: true, force: true });
  console.log(process.exitCode ? "\n结果：存在失败项" : "\n结果：测试环境登录链路全部通过");
})();
