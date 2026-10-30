"use strict";
/**
 * V1.2.23 回归：全角色回归测试提出的 4 项
 * 运行：node --experimental-sqlite --test test/v1223.test.js
 *
 * 对应缺陷：
 *   NEW-01 付款字段校验先于业务门禁 → 未核销/已结算项目应先返回 409 门禁结论
 *   NEW-02 邀请函渠道未就绪时按钮仍可点 → 接口下发 channels，前端据此置灰
 *   SEC-03 静态资源缺安全响应头 → web/_headers 声明六个头
 *   FLOW-01 核销通过后财务看不到项目 → verify_pass 自动授权财务成员（正向验证）
 *
 * 这些用例的价值在于「锁住顺序」：门禁必须先于字段校验，
 * 否则下次有人调整校验顺序时，用户又会先看到「开户行必填」而不是「不能付款」。
 */
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { fillMaterials } = require("./helpers/materials");

const PORT = 8833;
const BASE = `http://127.0.0.1:${PORT}`;
const DB = path.join(__dirname, "..", "data", "test33.db");
const UP = path.join(__dirname, "..", "data", "test33-uploads");
let proc;
let admin, finance, exec;

const BANK = "中国银行北京朝阳支行";
const ACCT = "3210 1234 5678 9012";

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
    return { status: r.status, data, headers: r.headers };
  };
}

/** 建项目并推进到指定阶段；materials=true 时补齐 8 类材料（核销前置） */
async function makeProject(name, target, { materials = false } = {}) {
  const c = admin;
  const mk = await c("POST", "/api/projects", {
    name: `${name}-${Date.now()}`, assoc: "华东医学会", form: "线下",
    date: "2027-12-12", budget: 50000, people: 30, owner: "王敏", agenda: "09:00 开幕"
  });
  assert.equal(mk.status, 200, JSON.stringify(mk.data));
  const pid = mk.data.project.id;
  const chain = ["submit", "approve", "prep", "exec", "request_verify"];
  const idx = chain.indexOf(target);
  const steps = idx >= 0 ? chain.slice(0, idx + 1) : [];
  for (const action of steps) {
    // V1.2.19：材料 8 类齐备才能「开启核销」，所以必须在 request_verify 之前补齐
    if (action === "request_verify" && materials) await fillMaterials(c, pid);
    const r = await c("POST", `/api/projects/${pid}/transition`, { action });
    assert.equal(r.status, 200, `${action} 失败：${JSON.stringify(r.data)}`);
  }
  return pid;
}

/** 走到「已核销」——需要材料 8/8 + 6 步判定 */
async function verifiedProject(name) {
  const pid = await makeProject(name, "request_verify", { materials: true });
  for (let no = 1; no <= 6; no++) {
    const r = await admin("POST", `/api/projects/${pid}/verify/steps/${no}`, { result: "通过" });
    assert.equal(r.status, 200, `第 ${no} 步失败：${JSON.stringify(r.data)}`);
  }
  const pass = await admin("POST", `/api/projects/${pid}/transition`, { action: "verify_pass" });
  assert.equal(pass.status, 200, JSON.stringify(pass.data));
  return pid;
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
  admin = client(await login("admin"));
  finance = client(await login("finance"));
  exec = client(await login("exec"));
});

after(() => { if (proc) proc.kill("SIGTERM"); });

/* ---------------- NEW-01 门禁先于字段校验 ---------------- */

test("NEW-01 未核销项目付款：先给 VERIFY_GATE，而不是「开户行必填」", async () => {
  const pid = await makeProject("门禁顺序-执行中", "exec");
  // 故意不填 payee_bank / payee_account：若字段校验在前，会得到 400
  const r = await admin("POST", "/api/payments", {
    pid, type: "学会公付", payee: "北京国际会议中心", amount: 1000
  });
  assert.equal(r.status, 409, `应 409，实际 ${r.status}：${JSON.stringify(r.data)}`);
  assert.equal(r.data.error.code, "VERIFY_GATE");
  assert.match(r.data.error.message, /必须先完成 6 步核销/);
});

test("NEW-01 已结算项目付款：先给 SETTLED，而不是「开户行必填」", async () => {
  const pid = await verifiedProject("门禁顺序-已结算");
  const settle = await finance("POST", `/api/projects/${pid}/transition`, {
    action: "settle", payee: "王敏", payee_bank: BANK, payee_account: ACCT
  });
  assert.equal(settle.status, 200, JSON.stringify(settle.data));

  const r = await admin("POST", "/api/payments", {
    pid, type: "学会公付", payee: "北京国际会议中心", amount: 1000
  });
  assert.equal(r.status, 409, `应 409，实际 ${r.status}：${JSON.stringify(r.data)}`);
  assert.equal(r.data.error.code, "SETTLED");
});

test("NEW-01 已核销项目付款：门禁放行后才校验字段", async () => {
  const pid = await verifiedProject("门禁顺序-已核销");
  const noBank = await admin("POST", "/api/payments", {
    pid, type: "学会公付", payee: "北京国际会议中心", amount: 1000
  });
  assert.equal(noBank.status, 400, `门禁放行后应回到字段校验，实际 ${noBank.status}`);
  assert.match(noBank.data.error.message, /开户行/);

  const ok = await admin("POST", "/api/payments", {
    pid, type: "学会公付", payee: "北京国际会议中心", amount: 1000,
    payee_bank: BANK, payee_account: ACCT
  });
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
});

/* ---------------- NEW-02 邀请函渠道就绪 ---------------- */

test("NEW-02 邀请函列表下发 channels，未配置时为 false", async () => {
  const pid = await makeProject("邀请函渠道", "approve");
  const r = await admin("GET", `/api/projects/${pid}/prep/invitations`);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.ok(r.data.channels, "响应必须带 channels");
  assert.equal(typeof r.data.channels.email, "boolean");
  assert.equal(typeof r.data.channels.wechat, "boolean");
  // 测试环境没有邮件凭证与小程序配置，两个渠道都应为 false
  assert.equal(r.data.channels.email, false);
  assert.equal(r.data.channels.wechat, false);
});

test("NEW-02 渠道未就绪时发送仍被后端拒绝（前端置灰不是唯一防线）", async () => {
  const pid = await makeProject("邀请函发送", "approve");
  const mk = await admin("POST", `/api/projects/${pid}/prep/invitations`, {
    type: "guest", recipient_name: "测试嘉宾", recipient_email: "qa@example.com",
    recipient_title: "主任医师", guest_role: "讲者", topic: "测试课题"
  });
  assert.equal(mk.status, 200, JSON.stringify(mk.data));
  const id = mk.data.invitation.id;

  const mail = await admin("POST", `/api/projects/${pid}/prep/invitations/${id}/email`, {});
  assert.equal(mail.status, 503);
  assert.equal(mail.data.error.code, "MAIL_NOT_CONFIGURED");

  const wx = await admin("POST", `/api/projects/${pid}/prep/invitations/${id}/wechat-share`, {});
  assert.equal(wx.status, 409);
  assert.equal(wx.data.error.code, "WECHAT_DISABLED");
});

/* ---------------- FLOW-01 核销通过自动授权财务 ---------------- */

test("FLOW-01 核销通过后，财务无需手动加成员即可结算", async () => {
  const pid = await verifiedProject("财务自动授权");

  // 核销通过前 finance 看不到（数据范围=授权项目），通过后应被自动加入
  const view = await finance("GET", `/api/projects/${pid}`);
  assert.equal(view.status, 200, `核销通过后财务应可见，实际 ${view.status}：${JSON.stringify(view.data)}`);

  const settle = await finance("POST", `/api/projects/${pid}/transition`, {
    action: "settle", payee: "王敏", payee_bank: BANK, payee_account: ACCT
  });
  assert.equal(settle.status, 200, `财务应能生成结算单，实际 ${settle.status}：${JSON.stringify(settle.data)}`);
  assert.match(settle.data.message, /结算单/);
});

test("FLOW-01 自动授权会写审计，可追溯", async () => {
  const pid = await verifiedProject("财务授权审计");
  const audit = await admin("GET", `/api/audit?q=${encodeURIComponent(pid)}&size=200`);
  assert.equal(audit.status, 200);
  const rows = audit.data.rows || [];
  const hit = rows.find((x) => x.action === "自动授权财务");
  assert.ok(hit, `应存在「自动授权财务」审计记录，实际：${rows.map((x) => x.action).join(",")}`);
  assert.match(hit.detail, /加入项目成员/);
});

/* ---------------- SEC-03 静态资源安全头 ---------------- */

test("SEC-03 web/_headers 声明了六项安全响应头", async () => {
  const file = path.join(__dirname, "..", "web", "_headers");
  assert.ok(fs.existsSync(file), "web/_headers 必须存在（静态资源由 Assets 直出，不经过 Worker）");
  const text = fs.readFileSync(file, "utf8");
  for (const h of [
    "Strict-Transport-Security",
    "X-Content-Type-Options",
    "X-Frame-Options",
    "Referrer-Policy",
    "Permissions-Policy",
    "Content-Security-Policy-Report-Only"
  ]) {
    assert.match(text, new RegExp(h), `_headers 缺少 ${h}`);
  }
  assert.match(text, /SAMEORIGIN/, "X-Frame-Options 应为 SAMEORIGIN（合同 PDF 用同源 iframe）");
  assert.match(text, /static\.cloudflareinsights\.com/, "CSP 应放行 Cloudflare Analytics beacon，否则转强制后会拦掉统计");
});

test("SEC-03 API 响应仍带全部安全头（未被本次改动破坏）", async () => {
  const r = await admin("GET", "/api/meta");
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("x-content-type-options"), "nosniff");
  assert.equal(r.headers.get("x-frame-options"), "SAMEORIGIN");
  assert.ok(r.headers.get("strict-transport-security"));
  assert.ok(r.headers.get("content-security-policy-report-only"));
});
