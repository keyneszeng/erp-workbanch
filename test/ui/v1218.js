/**
 * V1.2.18 UI 定点验证：付款 / 结算单的「收款方 + 银行账号」
 * 运行：node test/ui/v1218.js
 *
 * 老板 2026-10-28：「生成结算单 付款 两个功能板块缺少了 收款方和银行账号 信息」。
 * 这里在页面上把这四件事走一遍：
 *   1. 付款申请弹窗能填开户行与账号，缺了拦得住；
 *   2. 付款列表里能看到「开户行 · 账号」，老单据显示「未登记收款账户」并能补录；
 *   3. 结算单列表有「收款方 / 收款账户」；
 *   4. 项目详情概览的结算单卡片带上收款方。
 *
 * 脚本自带服务（设 ERP_BASE 可指向已有服务）。
 */
const { chromium } = require("playwright");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..", "..");
const PORT = Number(process.env.ERP_PORT || 8837);
const BASE = process.env.ERP_BASE || `http://127.0.0.1:${PORT}`;
const SELF_HOSTED = !process.env.ERP_BASE;
const DB = path.join(ROOT, "data", "ui-v1218.db");
const UP = path.join(ROOT, "data", "ui-v1218-uploads");

const BANK = "中国银行北京朝阳支行";
const ACCT = "3210123456789012";

let pass = 0, fail = 0;
const check = (name, ok, extra = "") => {
  if (ok) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}  ${extra}`); }
};

function clean() {
  for (const f of [DB, DB + "-wal", DB + "-shm"]) if (fs.existsSync(f)) fs.unlinkSync(f);
  if (fs.existsSync(UP)) fs.rmSync(UP, { recursive: true, force: true });
}
async function waitHealth(timeout = 30000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    try { const r = await fetch(`${BASE}/api/health`); if (r.ok) return; } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("服务启动超时");
}

let proc = null;
let cookie = "";
async function apiLogin() {
  const r = await fetch(`${BASE}/api/auth/login`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "finance", password: "123456" })
  });
  if (r.status !== 200) throw new Error("登录失败");
  return r.headers.get("set-cookie").split(";")[0];
}
async function api(method, url, body) {
  const opt = { method, headers: { cookie } };
  if (body !== undefined) { opt.body = JSON.stringify(body); opt.headers["Content-Type"] = "application/json"; }
  const r = await fetch(BASE + url, opt);
  const t = await r.text();
  let d; try { d = JSON.parse(t); } catch { d = t; }
  return { status: r.status, data: d };
}

/** 造一条「没有收款账户」的付款单，模拟历史数据（账号是这一版才加的字段） */
async function makeLegacyPayment() {
  const r = await api("POST", "/api/payments", {
    pid: "MP-2026-008", type: "个人报销", payee: "周涛", amount: 888,
    payee_bank: BANK, payee_account: ACCT
  });
  if (r.status !== 200) throw new Error("造付款单失败：" + JSON.stringify(r.data));
  const id = r.data.payment.id;
  const { DatabaseSync } = require("node:sqlite");
  const conn = new DatabaseSync(DB);
  conn.prepare("UPDATE payments SET payee_bank = NULL, payee_account = NULL WHERE id = ?").run(id);
  conn.close();
  return id;
}

(async () => {
  if (SELF_HOSTED) {
    clean();
    proc = spawn(process.execPath, ["--experimental-sqlite", "server/index.js"], {
      cwd: ROOT,
      env: { ...process.env, ERP_PORT: String(PORT), ERP_DB: DB, ERP_UPLOAD_DIR: UP },
      stdio: ["ignore", "pipe", "pipe"]
    });
    proc.stderr.on("data", (d) => {
      const s = d.toString();
      if (!s.includes("ExperimentalWarning") && !s.includes("trace-warnings")) process.stderr.write("[srv] " + s);
    });
    await waitHealth();
  }
  cookie = await apiLogin();
  const legacyId = await makeLegacyPayment();

  const browser = await chromium.launch({ channel: "chrome", headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errs = [];
  page.on("pageerror", (e) => errs.push(`[pageerror] ${e.message}`));
  page.on("console", (m) => {
    const t = m.text();
    if (m.type() === "error" && !/Failed to load resource/.test(t)) errs.push(t);
  });

  console.log("\n[1] 财务登录 → 付款与结算");
  await page.goto(BASE, { waitUntil: "networkidle" });
  await page.waitForTimeout(700);
  await page.fill('input[name="username"]', "finance");
  await page.fill('input[name="password"]', "123456");
  await page.click("#lbtn");
  await page.waitForSelector("#pwdBtn", { timeout: 30000 });
  await page.click('button[data-go="finance"]');
  await page.waitForSelector(".panel .panel-h", { timeout: 30000 });
  await page.waitForTimeout(1500);

  const heads = await page.$$eval(".panel th", (els) => els.map((e) => e.textContent.trim()));
  check("付款表头有「收款方」", heads.includes("收款方"), JSON.stringify(heads));
  check("结算表头有「收款方 / 收款账户」", heads.includes("收款方 / 收款账户"), JSON.stringify(heads));

  // 按标题找面板，别用 nth-of-type —— .panel 不是唯一元素，索引很容易落空
  const panels = await page.$$eval("#content .panel", (els) => els.map((e) => e.innerText));
  const payBody = panels.find((t) => t.includes("付款记录")) || "";
  check("付款列表显示开户行", /银行|支行|分行/.test(payBody), payBody.replace(/\s+/g, " ").slice(0, 120));
  check("付款列表显示账号", /\d{10,}/.test(payBody), payBody.replace(/\s+/g, " ").slice(0, 120));

  const stBody = panels.find((t) => t.includes("结算单") && t.includes("收入")) || "";
  check("结算单显示收款方（华东医学会）", /华东医学会/.test(stBody), stBody.replace(/\s+/g, " ").slice(0, 120));
  check("结算单显示账号", /\d{10,}/.test(stBody), stBody.replace(/\s+/g, " ").slice(0, 120));

  console.log("\n[2] 付款申请：开户行与账号是必填");
  await page.click("#newPay");
  await page.waitForSelector("#modal.open");
  check("弹窗有「开户行」字段", (await page.locator('#modal input[name="payee_bank"]').count()) === 1);
  check("弹窗有「银行账号」字段", (await page.locator('#modal input[name="payee_account"]').count()) === 1);

  // 只填收款方和金额，账号留空 → 应被拦
  await page.fill('#modal input[name="payee"]', "测试会展公司");
  await page.fill('#modal input[name="amount"]', "1200");
  await page.click('#modal [data-x="1"]');
  await page.waitForTimeout(600);
  check("缺开户行/账号时弹窗不关闭", (await page.locator("#modal.open").count()) === 1);

  await page.fill('#modal input[name="payee_bank"]', BANK);
  await page.fill('#modal input[name="payee_account"]', ACCT);
  await page.click('#modal [data-x="1"]');
  await page.waitForTimeout(1800);
  const afterSubmit = (await page.textContent("#content")) || "";
  check("填全后提交成功（列表出现新收款方）", /测试会展公司/.test(afterSubmit),
    afterSubmit.replace(/\s+/g, " ").slice(0, 160));
  check("新单显示开户行与账号", /中国银行北京朝阳支行/.test(afterSubmit));

  console.log("\n[3] 老单据：显示「未登记收款账户」并能补录");
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForTimeout(1800);
  const legacyRow = (await page.textContent(`tr[data-row="${legacyId}"]`).catch(() => "")) || "";
  check("老单据标注「未登记收款账户」", /未登记收款账户/.test(legacyRow),
    legacyRow.replace(/\s+/g, " ").slice(0, 120));
  const acctBtn = page.locator(`tr[data-row="${legacyId}"] [data-acct="${legacyId}"]`);
  check("老单据有「登记账户」入口", (await acctBtn.count()) === 1);
  if (await acctBtn.count()) {
    await acctBtn.click();
    await page.waitForSelector("#modal.open");
    await page.fill('#modal input[name="payee_bank"]', BANK);
    await page.fill('#modal input[name="payee_account"]', ACCT);
    await page.click('#modal [data-x="1"]');
    await page.waitForTimeout(1800);
    const fixed = (await page.textContent(`tr[data-row="${legacyId}"]`).catch(() => "")) || "";
    check("补录后显示开户行与账号", /中国银行北京朝阳支行/.test(fixed) && /3210123456789012/.test(fixed),
      fixed.replace(/\s+/g, " ").slice(0, 140));
  }

  console.log("\n[4] 项目详情概览：结算单卡片带收款方");
  await page.goto(`${BASE}/#/projects/MP-2026-006`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#tabbody", { timeout: 30000 });
  await page.waitForTimeout(1800);
  const ov = (await page.textContent("#tabbody")) || "";
  check("概览显示结算单收款方", /收款方[\s\S]{0,20}华东医学会/.test(ov), ov.replace(/\s+/g, " ").slice(0, 200));
  check("概览显示收款账号", /3210987654321098/.test(ov), ov.replace(/\s+/g, " ").slice(0, 200));

  await page.screenshot({ path: "/tmp/ui-v1218.png", fullPage: true });

  console.log("\n[5] 控制台");
  check("无 JS 报错", errs.length === 0, errs.slice(0, 3).join(" | "));

  await browser.close();
  if (proc) proc.kill("SIGTERM");
  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error("脚本异常：", e);
  if (proc) proc.kill("SIGTERM");
  process.exit(2);
});
