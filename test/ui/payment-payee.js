/**
 * 付款申请「选中收款方就带出账号」UI 定点验证
 * 运行：node test/ui/payment-payee.js
 *
 * 老板 2026-11-02：「付款申请表里收款方选择了企业，还是叫填入银行账号」。
 *
 * 根因：核销里已核验的账号只写进了 input 的 placeholder，输入框本身是空的，
 * 财务看到空框就以为必须自己再填一遍。
 *
 * 本用例验三件事：
 *   1. 选中带账号的收款方 → 账号框里真的有值（尾号），而且是只读；
 *   2. 切到没有账号的收款方 → 账号框被清空并恢复可编辑，不留上一个人的尾号；
 *   3. 提交时不会把「尾号 XXXX」当成账号发给服务端（否则会被判非法账号）。
 */
const { chromium } = require("playwright");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..", "..");
const PORT = Number(process.env.ERP_PORT || 8839);
const BASE = process.env.ERP_BASE || `http://127.0.0.1:${PORT}`;
const SELF_HOSTED = !process.env.ERP_BASE;
const DB = path.join(ROOT, "data", "ui-payment-payee.db");
const UP = path.join(ROOT, "data", "ui-payment-payee-uploads");

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
    body: JSON.stringify({ username: "admin", password: "123456" })
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

/** 造一个「已核销 + 两份合同（一份带账号、一份不带）」的项目，付款表单才有东西可选 */
async function seedPayableProject() {
  const mk = await api("POST", "/api/projects", {
    name: `付款收款方带出-${Date.now()}`, assoc: "华东医学会", form: "线下",
    date: "2027-11-11", budget: 60000, people: 30, owner: "王敏", agenda: "09:00 开幕"
  });
  if (mk.status !== 200) throw new Error("建项目失败 " + JSON.stringify(mk.data));
  const pid = mk.data.project.id;
  for (const action of ["submit", "approve", "prep", "exec"]) {
    const r = await api("POST", `/api/projects/${pid}/transition`, { action });
    if (r.status !== 200) throw new Error(action + " 失败 " + JSON.stringify(r.data));
  }
  // 带账号的合同
  const withAcct = await api("POST", "/api/contracts", {
    pid, name: "场地租赁合同", vendor: "广州会展中心", amount: 3175, category: "场地餐饮",
    status: "已签署", sign_date: "2026-10-01",
    payee_bank: "中国银行股份有限公司广州中信广场支行", payee_account: "6222023602078445731"
  });
  // 不带账号的合同
  const noAcct = await api("POST", "/api/contracts", {
    pid, name: "物料制作合同", vendor: "某某广告公司", amount: 1200, category: "物料搭建",
    status: "已签署", sign_date: "2026-10-01"
  });
  if (withAcct.status !== 200 || noAcct.status !== 200)
    throw new Error("建合同失败 " + JSON.stringify(withAcct.data) + JSON.stringify(noAcct.data));

  // 材料 8 类齐备（演示模式只认类别，不要求原件）
  for (const kind of ["立项文件", "合同", "议程", "课件", "签到表", "劳务表", "发票", "现场照片"]) {
    const r = await api("POST", `/api/projects/${pid}/materials`, { kind, name: `${kind}-原件` });
    if (r.status !== 200) throw new Error("材料 " + kind + " 失败 " + JSON.stringify(r.data));
  }
  const rv = await api("POST", `/api/projects/${pid}/transition`, { action: "request_verify" });
  if (rv.status !== 200) throw new Error("提交核销失败 " + JSON.stringify(rv.data));
  for (let no = 1; no <= 6; no++) {
    const r = await api("POST", `/api/projects/${pid}/verify/steps/${no}`, { result: "通过" });
    if (r.status !== 200) throw new Error("第 " + no + " 步失败 " + JSON.stringify(r.data));
  }
  const vp = await api("POST", `/api/projects/${pid}/transition`, { action: "verify_pass" });
  if (vp.status !== 200) throw new Error("核销通过失败 " + JSON.stringify(vp.data));
  return pid;
}

(async () => {
  if (SELF_HOSTED) {
    clean();
    proc = spawn(process.execPath, ["--experimental-sqlite", "server/index.js"], {
      cwd: ROOT,
      env: { ...process.env, ERP_PORT: String(PORT), ERP_DB: DB, ERP_UPLOAD_DIR: UP, ERP_DEMO_MODE: "1",
        // 合同里的收款账号是加密存的，没有密钥连用例都造不出来
        ERP_FINANCIAL_DATA_KEY: "a".repeat(64) },
      stdio: ["ignore", "pipe", "pipe"]
    });
    proc.stderr.on("data", (d) => {
      const s = d.toString();
      if (!s.includes("ExperimentalWarning") && !s.includes("trace-warnings")) process.stderr.write("[srv] " + s);
    });
    await waitHealth();
  }
  cookie = await apiLogin();
  const pid = await seedPayableProject();

  const browser = await chromium.launch({ channel: "chrome", headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errs = [];
  page.on("pageerror", (e) => errs.push(`[pageerror] ${e.message}`));
  page.on("console", (m) => {
    const t = m.text();
    if (m.type() === "error" && !/Failed to load resource/.test(t)) errs.push(t);
  });

  console.log("\n[1] 登录 → 财务结算");
  await page.goto(BASE, { waitUntil: "networkidle" });
  await page.waitForTimeout(700);
  await page.fill('input[name="username"]', "admin");
  await page.fill('input[name="password"]', "123456");
  await page.click("#lbtn");
  await page.waitForSelector("#pwdBtn", { timeout: 30000 });
  await page.goto(`${BASE}/#/finance`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#newPay", { timeout: 30000 });
  await page.waitForTimeout(800);

  console.log("[2] 打开付款申请，等项目下拉载入");
  await page.click("#newPay");
  await page.waitForSelector('select[name="payee_option_id"]', { timeout: 20000 });
  await page.waitForFunction(() => {
    const s = document.querySelector('select[name="payee_option_id"]');
    return s && s.options.length > 1 && !/载入中/.test(s.options[0].textContent);
  }, { timeout: 20000 });
  // 选到刚造的那个项目
  await page.selectOption('select[name="pid"]', pid);
  await page.waitForTimeout(1200);

  const options = await page.$$eval('select[name="payee_option_id"] option', (els) =>
    els.map((e) => ({ v: e.value, t: e.textContent })));
  const withAcctOpt = options.find((o) => /广州会展中心/.test(o.t));
  const noAcctOpt = options.find((o) => /某某广告公司/.test(o.t));
  check("下拉里有带账号的收款方", !!withAcctOpt, JSON.stringify(options.map(o => o.t)));
  check("下拉里有不带账号的收款方", !!noAcctOpt, JSON.stringify(options.map(o => o.t)));

  console.log("\n[3] 选中带账号的企业：账号框应自动填入并只读");
  await page.selectOption('select[name="payee_option_id"]', withAcctOpt.v);
  await page.waitForTimeout(400);
  const filled = await page.$eval('input[name="payee_account"]', (el) => ({
    value: el.value, readOnly: el.readOnly, auto: el.dataset.auto || "", ph: el.placeholder
  }));
  check("账号框已自动填入尾号", /尾号\s*\d{4}/.test(filled.value), JSON.stringify(filled));
  check("账号框为只读，防止误改", filled.readOnly === true, JSON.stringify(filled));
  check("标记为自动带入（提交时不发送该值）", filled.auto === "1", JSON.stringify(filled));
  const bankVal = await page.$eval('input[name="payee_bank"]', (el) => el.value);
  check("开户行已自动填入", /中国银行/.test(bankVal), bankVal);
  const amountVal = await page.$eval('input[name="amount"]', (el) => el.value);
  check("付款金额已自动填入", Number(amountVal) === 3175, amountVal);

  console.log("\n[4] 切到没有账号的企业：账号框清空并恢复可编辑");
  await page.selectOption('select[name="payee_option_id"]', noAcctOpt.v);
  await page.waitForTimeout(400);
  const cleared = await page.$eval('input[name="payee_account"]', (el) => ({
    value: el.value, readOnly: el.readOnly, auto: el.dataset.auto || ""
  }));
  check("账号框已清空（不留上一个人的尾号）", cleared.value === "", JSON.stringify(cleared));
  check("账号框恢复可编辑", cleared.readOnly === false, JSON.stringify(cleared));
  check("自动标记已移除", cleared.auto === "", JSON.stringify(cleared));
  const bankCleared = await page.$eval('input[name="payee_bank"]', (el) => el.value);
  check("开户行也被清空（不留上一家的开户行）", bankCleared === "", bankCleared);
  const tip = await page.$eval("[data-payee-tip]", (el) => el.textContent.trim());
  check("提示告诉人该怎么办", /没有登记收款账号/.test(tip), tip);

  console.log("\n[5] 提交带账号那家：不能把「尾号 XXXX」当账号发给服务端");
  await page.selectOption('select[name="payee_option_id"]', withAcctOpt.v);
  await page.waitForTimeout(300);
  let sentBody = null;
  page.on("request", (req) => {
    if (req.method() === "POST" && req.url().endsWith("/api/payments")) {
      try { sentBody = JSON.parse(req.postData() || "{}"); } catch { sentBody = {}; }
    }
  });
  await page.click('#modal [data-x="1"]');
  await page.waitForTimeout(1500);
  check("提交请求里没有 payee_account 字段", !!sentBody && !("payee_account" in sentBody),
    JSON.stringify(sentBody));

  // 只看请求还不够：服务端必须真的用解密出来的账号把付款单建起来
  const pays = await api("GET", `/api/payments?pid=${pid}`);
  const created = (pays.data.rows || []).find((y) => y.payee === "广州会展中心");
  check("付款单已生成，账号由服务端解密带入", !!created && Number(created.amount) === 3175,
    JSON.stringify(pays.data.rows || pays.data));

  check("页面无 JS 报错", errs.length === 0, errs.join(" | "));
  await browser.close();
  if (proc) proc.kill("SIGTERM");
  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error("用例执行失败：", e.message);
  if (proc) proc.kill("SIGTERM");
  process.exit(1);
});
