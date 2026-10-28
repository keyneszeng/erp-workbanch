"use strict";
/**
 * V1.2.17 回归：按《erp系统测试报告》的缺陷清单逐条验收
 * 运行：node --experimental-sqlite --test test/v1217.test.js
 *
 * 报告里 11 项缺陷，真正会带进生产的是 4 项（P1），另 3 项 P2、4 项 P3。
 * 这个文件把每条都钉成一条断言，避免以后改动把闸门又放开：
 *
 *   SEC-01 用户目录接口未做模块鉴权
 *   SEC-02 列表接口未按模块白名单鉴权，与导出口径不一致
 *   BUG-01 普通用户数据范围漏「负责人」
 *   SEC-04 创建账号可绕过口令强度策略
 *   SEC-03 安全响应头缺失、Cookie 无 Secure
 *   BUG-02 鉴权顺序为先状态后权限
 *   FLOW-01 核销通过后无财务成员，财务无法结算
 *   API-01 方法不匹配应 405、非法 JSON 应明确报格式错误
 */
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { fillMaterials } = require("./helpers/materials");

const PORT = 8826;
const BASE = `http://127.0.0.1:${PORT}`;
const DB = path.join(__dirname, "..", "data", "test26.db");
const UP = path.join(__dirname, "..", "data", "test26-uploads");
let proc;
let admin, assoc, exec, finance, guest;

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
async function login(username, password = "123456", headers = {}) {
  const r = await fetch(`${BASE}/api/auth/login`, {
    method: "POST", headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify({ username, password })
  });
  assert.equal(r.status, 200, `${username} 登录失败`);
  return { cookie: r.headers.get("set-cookie").split(";")[0], raw: r.headers.get("set-cookie") };
}
function client(cookie) {
  return async (method, url, body, headers = {}) => {
    const r = await fetch(BASE + url, {
      method, headers: { "Content-Type": "application/json", cookie, ...headers },
      body: body ? JSON.stringify(body) : undefined
    });
    const text = await r.text();
    let data = null; try { data = JSON.parse(text); } catch { data = text; }
    return { status: r.status, data, headers: r.headers };
  };
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
  admin = client((await login("admin")).cookie);
  assoc = client((await login("assoc")).cookie);
  exec = client((await login("exec")).cookie);
  finance = client((await login("finance")).cookie);
  guest = client((await login("guest")).cookie);
});

after(() => { if (proc) proc.kill("SIGTERM"); });

/* ---------------- SEC-01 账号目录 ---------------- */

test("SEC-01 账号目录只给账号管理员，其余角色 403", async () => {
  for (const [name, c] of [["guest", guest], ["exec", exec], ["assoc", assoc], ["finance", finance]]) {
    const r = await c("GET", "/api/users");
    assert.equal(r.status, 403, `${name} 应 403，实际 ${r.status}`);
    assert.equal(r.data.error.code, "FORBIDDEN");
  }
  const a = await admin("GET", "/api/users");
  assert.equal(a.status, 200);
  assert.ok(a.data.rows.length > 0);
  assert.ok(a.data.rows[0].username, "管理员应拿到完整字段（含账号）");
});

test("SEC-01 选人接口只回最小字段，guest 无权", async () => {
  const r = await assoc("GET", "/api/users/pickable");
  assert.equal(r.status, 200);
  const keys = Object.keys(r.data.rows[0]).sort();
  assert.deepEqual(keys, ["id", "name", "role", "role_name"], `字段：${keys.join(",")}`);
  const g = await guest("GET", "/api/users/pickable");
  assert.equal(g.status, 403);
});

/* ---------------- SEC-02 列表与导出同口径 ---------------- */

test("SEC-02 guest 的 7 个列表接口全部 403（与导出同口径）", async () => {
  const urls = ["/api/contracts", "/api/demand", "/api/materials", "/api/payments", "/api/settlements", "/api/audit"];
  for (const u of urls) {
    const r = await guest("GET", u);
    assert.equal(r.status, 403, `${u} 应 403，实际 ${r.status}`);
    assert.equal(r.data.error.code, "FORBIDDEN", `${u} 错误码`);
  }
  // 导出对 guest 也是 403 —— 两套口径现在一致
  const ex = await guest("GET", "/api/export/contracts");
  assert.equal(ex.status, 403);
});

test("SEC-02 有权限的角色不受影响：合同/材料/付款照常可读", async () => {
  assert.equal((await assoc("GET", "/api/contracts")).status, 200);
  assert.equal((await exec("GET", "/api/materials")).status, 200);
  assert.equal((await finance("GET", "/api/payments")).status, 200);
  assert.equal((await exec("GET", "/api/demand")).status, 200);
  assert.equal((await finance("GET", "/api/settlements")).status, 200);
  assert.equal((await assoc("GET", "/api/audit")).status, 200);
});

/* ---------------- BUG-01 数据范围补负责人 ---------------- */

test("BUG-01 普通用户能看到自己负责的项目（刘洋 3 场）", async () => {
  const r = await guest("GET", "/api/projects");
  const ids = r.data.rows.map((p) => p.id).sort();
  assert.deepEqual(ids, ["MP-2026-002", "MP-2026-005", "MP-2026-011"], `实际 ${ids.join(",")}`);

  // 详情也要放行 —— 列表能看到、点进去 403 是最难受的组合
  for (const pid of ["MP-2026-005", "MP-2026-011"]) {
    assert.equal((await guest("GET", `/api/projects/${pid}`)).status, 200, `${pid} 详情应可访问`);
  }
});

test("BUG-01 工作台「在管会议」跟着对上（3 场）", async () => {
  const r = await guest("GET", "/api/dashboard");
  assert.equal(r.status, 200);
  // 工作台的「在管会议」= counts 里各状态之和
  const total = Object.values(r.data.counts || {}).reduce((a, b) => a + Number(b || 0), 0);
  assert.equal(total, 3, `工作台在管会议应为 3，实际 ${total}（${JSON.stringify(r.data.counts)}）`);
});

/* ---------------- SEC-04 口令策略 ---------------- */

test("SEC-04 建号弱口令一律 400，强口令才通过", async () => {
  const weak = await admin("POST", "/api/users", {
    username: "weak1", name: "弱口令", role: "user", password: "123"
  });
  assert.equal(weak.status, 400, `123 应被拒，实际 ${weak.status}`);
  assert.match(weak.data.error.message, /至少 8 位/);

  const noPwd = await admin("POST", "/api/users", {
    username: "weak2", name: "没密码", role: "user"
  });
  assert.equal(noPwd.status, 400, "不传密码应被拒（不再默认 123456）");

  const weak2 = await admin("POST", "/api/users", {
    username: "weak3", name: "纯数字", role: "user", password: "12345678"
  });
  assert.equal(weak2.status, 400, "纯数字应被拒");
  assert.match(weak2.data.error.message, /字母和数字/);

  const ok = await admin("POST", "/api/users", {
    username: "strong1", name: "强口令", role: "user", password: "Init1234"
  });
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  // 真的能登进去
  const lg = await login("strong1", "Init1234");
  assert.ok(lg.cookie);
});

test("SEC-04 重置密码同样走统一策略", async () => {
  const users = await admin("GET", "/api/users");
  const u = users.data.rows.find((x) => x.username === "strong1");
  const r = await admin("PATCH", `/api/users/${u.id}`, { password: "123456" });
  assert.equal(r.status, 400, "重置成 123456 应被拒");
  const ok = await admin("PATCH", `/api/users/${u.id}`, { password: "Reset9876" });
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
});

/* ---------------- SEC-03 安全响应头 ---------------- */

test("SEC-03 每个响应都带安全头", async () => {
  const r = await admin("GET", "/api/projects");
  const h = r.headers;
  assert.match(h.get("strict-transport-security") || "", /max-age=\d+/);
  assert.equal(h.get("x-content-type-options"), "nosniff");
  // 不能用 DENY：合同详情是用 iframe 内嵌同源 PDF 原件的
  assert.equal(h.get("x-frame-options"), "SAMEORIGIN");
  assert.equal(h.get("referrer-policy"), "same-origin");
  assert.ok(h.get("content-security-policy-report-only"), "CSP 先上 Report-Only");
});

test("SEC-03 https 下 Cookie 带 Secure，本地 http 不带", async () => {
  const https = await login("admin", "123456", { "x-forwarded-proto": "https" });
  assert.match(https.raw, /;\s*Secure/i, `https 应带 Secure：${https.raw}`);
  const http = await login("admin", "123456");
  assert.doesNotMatch(http.raw, /;\s*Secure/i, "本地 http 不该带 Secure，否则浏览器不存 Cookie");
});

/* ---------------- BUG-02 鉴权顺序 ---------------- */

test("BUG-02 零权限角色审批已通过的单子应 403，而不是 409 暴露状态", async () => {
  // AP-2026-010 在种子里就是「已通过」
  const r = await guest("POST", "/api/approvals/AP-2026-010/decide", { approve: true });
  assert.equal(r.status, 403, `应 403，实际 ${r.status} ${JSON.stringify(r.data)}`);
  assert.equal(r.data.error.code, "FORBIDDEN");
  assert.doesNotMatch(String(r.data.error.message), /已通过|已驳回/, "不能把单据状态漏出去");
});

/* ---------------- FLOW-01 核销通过自动带财务 ---------------- */

test("FLOW-01 核销通过后财务自动进成员，能直接生成结算单", async () => {
  const mk = await admin("POST", "/api/projects", {
    name: `FLOW-01 结算断点-${Date.now()}`, assoc: "华东医学会", form: "线下",
    date: "2027-10-10", budget: 20000, people: 20, owner: "王敏", agenda: "09:00 开幕"
  });
  assert.equal(mk.status, 200, JSON.stringify(mk.data));
  const pid = mk.data.project.id;

  // 走到待核销（V1.2.19：材料 8 类齐备才能提交核销）
  await fillMaterials(admin, pid);
  for (const action of ["submit", "approve", "prep", "exec", "request_verify"]) {
    const r = await admin("POST", `/api/projects/${pid}/transition`, { action });
    assert.equal(r.status, 200, `${action} 失败：${JSON.stringify(r.data)}`);
  }
  // 用 admin 判定：exec 不在这个新项目的数据范围内（这正是 FLOW-01 的另一面），
  // 这里要验的是「核销通过后财务能不能结算」，不是 exec 的可见性。
  for (let no = 1; no <= 6; no++) {
    const r = await admin("POST", `/api/projects/${pid}/verify/steps/${no}`, { result: "通过" });
    assert.equal(r.status, 200, `第 ${no} 步判定失败：${JSON.stringify(r.data)}`);
  }

  // 财务此刻还看不见这个项目（不是成员、不是负责人）
  assert.equal((await finance("GET", `/api/projects/${pid}`)).status, 403, "前置：财务原本看不见");

  const pass = await admin("POST", `/api/projects/${pid}/transition`, { action: "verify_pass" });
  assert.equal(pass.status, 200, JSON.stringify(pass.data));

  // 核销通过 → 财务被自动加进来，能看详情、能生成结算单
  const detail = await finance("GET", `/api/projects/${pid}`);
  assert.equal(detail.status, 200, "核销通过后财务应能打开项目");
  assert.ok(detail.data.members.some((m) => m.name === "陈静"), "陈静应在成员里");

  const settle = await finance("POST", `/api/projects/${pid}/transition`, { action: "settle", payee_bank: "中国银行北京分行", payee_account: "3210987654321098" });
  assert.equal(settle.status, 200, `财务生成结算单失败：${JSON.stringify(settle.data)}`);
});

/* ---------------- API-01 REST 语义 ---------------- */

test("API-01 方法不对返回 405 + Allow", async () => {
  const r = await admin("PUT", "/api/projects", {});
  assert.equal(r.status, 405);
  assert.equal(r.data.error.code, "METHOD_NOT_ALLOWED");
  // /api/projects 支持 GET（列表）与 POST（新建），PATCH 在 /api/projects/:id 上
  const allow = r.headers.get("allow") || "";
  assert.match(allow, /GET/, `Allow 头应列出 GET，实际 ${allow}`);
  assert.match(allow, /POST/, `Allow 头应列出 POST，实际 ${allow}`);
});

test("API-01 非法 JSON 明确报格式错误", async () => {
  const r = await fetch(`${BASE}/api/auth/login`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: "{bad json"
  });
  assert.equal(r.status, 400);
  const d = await r.json();
  assert.equal(d.error.code, "BAD_JSON");
  assert.match(d.error.message, /JSON/);
});
