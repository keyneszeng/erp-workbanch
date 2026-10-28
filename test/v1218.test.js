"use strict";
/**
 * V1.2.18 回归：付款 / 结算单的「收款方 + 银行账号」
 * 运行：node --experimental-sqlite --test test/v1218.test.js
 *
 * 老板 2026-10-28：「生成结算单 付款 两个功能板块缺少了 收款方和银行账号 信息」。
 *
 * 验的是「能填、能存、能看、能导出」，以及三条硬约束：
 *   1. 新单必须填账户（否则财务拿着单子没法打款）；
 *   2. 老单没有账户时**付不出去**（PAYEE_ACCOUNT_MISSING），补录后才能付；
 *   3. 已付款的单子不许再改账户（钱已经出去了，改账号等于改凭证）。
 */
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const PORT = 8827;
const BASE = `http://127.0.0.1:${PORT}`;
const DB = path.join(__dirname, "..", "data", "test27.db");
const UP = path.join(__dirname, "..", "data", "test27-uploads");
let proc;
let admin, exec, finance;

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
    return { status: r.status, data };
  };
}

/** 造一个「已核销」项目 —— 只有这个状态能付款 */
async function verifiedProject(name) {
  const c = admin;
  const mk = await c("POST", "/api/projects", {
    name: `${name}-${Date.now()}`, assoc: "华东医学会", form: "线下",
    date: "2027-11-11", budget: 50000, people: 30, owner: "王敏", agenda: "09:00 开幕"
  });
  assert.equal(mk.status, 200, JSON.stringify(mk.data));
  const pid = mk.data.project.id;
  for (const action of ["submit", "approve", "prep", "exec", "request_verify"]) {
    const r = await c("POST", `/api/projects/${pid}/transition`, { action });
    assert.equal(r.status, 200, `${action} 失败：${JSON.stringify(r.data)}`);
  }
  for (let no = 1; no <= 6; no++) {
    const r = await c("POST", `/api/projects/${pid}/verify/steps/${no}`, { result: "通过" });
    assert.equal(r.status, 200, `第 ${no} 步失败：${JSON.stringify(r.data)}`);
  }
  const pass = await c("POST", `/api/projects/${pid}/transition`, { action: "verify_pass" });
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
  exec = client(await login("exec"));
  finance = client(await login("finance"));
});

after(() => { if (proc) proc.kill("SIGTERM"); });

/* ---------------- 付款 ---------------- */

test("付款申请：开户行与账号必填", async () => {
  const pid = await verifiedProject("付款账户必填");
  const base = { pid, type: "学会公付", payee: "北京国际会议中心", amount: 1000 };

  const noBank = await admin("POST", "/api/payments", { ...base, payee_account: ACCT });
  assert.equal(noBank.status, 400, `缺开户行应 400，实际 ${noBank.status}`);
  assert.match(noBank.data.error.message, /开户行/);

  const noAcct = await admin("POST", "/api/payments", { ...base, payee_bank: BANK });
  assert.equal(noAcct.status, 400, `缺账号应 400，实际 ${noAcct.status}`);
  assert.match(noAcct.data.error.message, /银行账号/);

  const badAcct = await admin("POST", "/api/payments", { ...base, payee_bank: BANK, payee_account: "12ab34" });
  assert.equal(badAcct.status, 400);
  assert.match(badAcct.data.error.message, /只能是数字/);

  const shortAcct = await admin("POST", "/api/payments", { ...base, payee_bank: BANK, payee_account: "12345" });
  assert.equal(shortAcct.status, 400);
  assert.match(shortAcct.data.error.message, /10~25 位/);
});

test("付款申请：填了就存下来，账号去掉空格", async () => {
  const pid = await verifiedProject("付款账户入库");
  const r = await admin("POST", "/api/payments", {
    pid, type: "学会公付", payee: "北京国际会议中心", amount: 2000,
    payee_bank: BANK, payee_account: ACCT
  });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.payment.payee_bank, BANK);
  assert.equal(r.data.payment.payee_account, "3210123456789012", "账号应去掉空格再入库");

  // 列表也要带出来
  const list = await finance("GET", `/api/payments?pid=${pid}`);
  assert.equal(list.status, 200);
  const row = list.data.rows.find((x) => x.id === r.data.payment.id);
  assert.equal(row.payee_bank, BANK);
  assert.equal(row.payee_account, "3210123456789012");
});

test("付款：没有收款账户就付不出去，补录后才能付", async () => {
  const pid = await verifiedProject("付款缺账户");
  const mk = await admin("POST", "/api/payments", {
    pid, type: "学会公付", payee: "某会展公司", amount: 3000,
    payee_bank: BANK, payee_account: ACCT
  });
  assert.equal(mk.status, 200);
  const id = mk.data.payment.id;

  // 模拟历史单据：账号是这一版才加的，老数据为空
  const db = require("node:sqlite");
  const conn = new db.DatabaseSync(DB);
  conn.prepare("UPDATE payments SET payee_bank = NULL, payee_account = NULL WHERE id = ?").run(id);
  conn.close();

  const ap = await admin("POST", `/api/payments/${id}/approve`, { approve: true });
  assert.equal(ap.status, 200, JSON.stringify(ap.data));

  const pay1 = await admin("POST", `/api/payments/${id}/pay`, {});
  assert.equal(pay1.status, 409, `缺账户应付不出去，实际 ${pay1.status}`);
  assert.equal(pay1.data.error.code, "PAYEE_ACCOUNT_MISSING");

  // 补录
  const fix = await finance("PATCH", `/api/payments/${id}/account`, { payee_bank: BANK, payee_account: ACCT });
  assert.equal(fix.status, 200, JSON.stringify(fix.data));
  assert.equal(fix.data.payment.payee_account, "3210123456789012");

  const pay2 = await admin("POST", `/api/payments/${id}/pay`, {});
  assert.equal(pay2.status, 200, JSON.stringify(pay2.data));
  assert.equal(pay2.data.payment.status, "已付款");

  // 已付款后不许再改账户
  const after = await finance("PATCH", `/api/payments/${id}/account`, { payee_bank: "别的银行", payee_account: "6222021234567890123" });
  assert.equal(after.status, 409, `已付款应拒绝改账户，实际 ${after.status}`);
  assert.equal(after.data.error.code, "PAID_LOCKED");
});

test("补录账户的权限：会务执行不行，财务可以", async () => {
  const pid = await verifiedProject("补录权限");
  const mk = await admin("POST", "/api/payments", {
    pid, type: "个人报销", payee: "周涛", amount: 500, payee_bank: BANK, payee_account: ACCT
  });
  const id = mk.data.payment.id;
  const bad = await exec("PATCH", `/api/payments/${id}/account`, { payee_bank: BANK, payee_account: "3210123456789012" });
  assert.equal(bad.status, 403, `exec 应 403，实际 ${bad.status}`);
});

/* ---------------- 结算单 ---------------- */

test("结算单：收款方默认取负责人，开户行与账号必填", async () => {
  const pid = await verifiedProject("结算账户必填");

  const noAcct = await finance("POST", `/api/projects/${pid}/transition`, { action: "settle" });
  assert.equal(noAcct.status, 400, `缺账号应 400，实际 ${noAcct.status}`);
  // 校验顺序是先开户行后账号，这里两个都认
  assert.match(noAcct.data.error.message, /收款开户行|收款账号/);

  const ok = await finance("POST", `/api/projects/${pid}/transition`, {
    action: "settle", payee_bank: BANK, payee_account: ACCT
  });
  assert.equal(ok.status, 200, JSON.stringify(ok.data));

  const list = await finance("GET", "/api/settlements");
  const st = list.data.rows.find((x) => x.pid === pid);
  assert.ok(st, "应生成结算单");
  assert.equal(st.payee, "王敏", "收款方默认取项目负责人");
  assert.equal(st.payee_bank, BANK);
  assert.equal(st.payee_account, "3210123456789012");
});

test("结算单：显式传收款方时以传入为准", async () => {
  const pid = await verifiedProject("结算指定收款方");
  const ok = await finance("POST", `/api/projects/${pid}/transition`, {
    action: "settle", payee: "华东医学会秘书处", payee_bank: BANK, payee_account: ACCT
  });
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  const list = await finance("GET", "/api/settlements");
  const st = list.data.rows.find((x) => x.pid === pid);
  assert.equal(st.payee, "华东医学会秘书处");
});

/* ---------------- 导出与种子 ---------------- */

test("导出：付款明细与结算汇总都带上收款账户列", async () => {
  const payCsv = await finance("GET", "/api/export/payments");
  assert.equal(payCsv.status, 200);
  const payHead = String(payCsv.data).split("\r\n")[0];
  assert.match(payHead, /开户行/);
  assert.match(payHead, /银行账号/);

  const stCsv = await finance("GET", "/api/export/settlements");
  assert.equal(stCsv.status, 200);
  const stHead = String(stCsv.data).split("\r\n")[0];
  assert.match(stHead, /收款方/);
  assert.match(stHead, /开户行/);
  assert.match(stHead, /银行账号/);
});

test("种子数据：演示用的付款单与结算单都有收款账户", async () => {
  const pays = await admin("GET", "/api/payments?size=100");
  const seededPay = pays.data.rows.filter((x) => /^PY-2026-0[3-4]/.test(x.id));
  assert.ok(seededPay.length > 0, "应有种子付款单");
  const emptyPay = seededPay.filter((x) => !x.payee_account || !x.payee_bank);
  assert.deepEqual(emptyPay.map((x) => x.id), [], `这些种子付款单没有账户：${emptyPay.map((x) => x.id).join(",")}`);

  const sts = await admin("GET", "/api/settlements");
  const emptySt = sts.data.rows.filter((x) => !x.payee_account || !x.payee_bank || !x.payee);
  assert.deepEqual(emptySt.map((x) => x.id), [], `这些种子结算单没有收款信息：${emptySt.map((x) => x.id).join(",")}`);
});
