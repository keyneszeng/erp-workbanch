/**
 * 生成结算单弹窗 UI 定点验证
 * 运行：node test/ui/settle-no-payee.js
 *
 * 老板 2026-11-02：「结算单记录业务资金结算结果，只是数据看板；不需要给别人付款，
 *                   所以删掉收款方 / 开户行 / 银行账号」。
 *
 * 验四件事：
 *   1. 弹窗里没有收款方 / 开户行 / 银行账号三个输入框；
 *   2. 文案说清楚「不产生付款动作」；
 *   3. 直接确认就能生成结算单；
 *   4. 结算单列表里不再有「收款方 / 收款账户」列。
 */
const { chromium } = require("playwright");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..", "..");
const PORT = Number(process.env.ERP_PORT || 8841);
const BASE = process.env.ERP_BASE || `http://127.0.0.1:${PORT}`;
const SELF_HOSTED = !process.env.ERP_BASE;
const DB = path.join(ROOT, "data", "ui-settle.db");
const UP = path.join(ROOT, "data", "ui-settle-uploads");

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

/** 造一个「已核销」项目：8 类材料齐备 + 6 步全过 */
async function seedVerifiedProject() {
  const mk = await api("POST", "/api/projects", {
    name: `结算弹窗-${Date.now()}`, assoc: "华东医学会", form: "线下",
    date: "2027-12-12", budget: 40000, people: 20, owner: "王敏", agenda: "09:00 开幕"
  });
  if (mk.status !== 200) throw new Error("建项目失败 " + JSON.stringify(mk.data));
  const pid = mk.data.project.id;
  for (const action of ["submit", "approve", "prep", "exec"]) {
    const r = await api("POST", `/api/projects/${pid}/transition`, { action });
    if (r.status !== 200) throw new Error(action + " 失败 " + JSON.stringify(r.data));
  }
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
      env: { ...process.env, ERP_PORT: String(PORT), ERP_DB: DB, ERP_UPLOAD_DIR: UP, ERP_DEMO_MODE: "1" },
      stdio: ["ignore", "pipe", "pipe"]
    });
    proc.stderr.on("data", (d) => {
      const s = d.toString();
      if (!s.includes("ExperimentalWarning") && !s.includes("trace-warnings")) process.stderr.write("[srv] " + s);
    });
    await waitHealth();
  }
  cookie = await apiLogin();
  const pid = await seedVerifiedProject();

  const browser = await chromium.launch({ channel: "chrome", headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errs = [];
  page.on("pageerror", (e) => errs.push(`[pageerror] ${e.message}`));
  page.on("console", (m) => {
    const t = m.text();
    if (m.type() === "error" && !/Failed to load resource/.test(t)) errs.push(t);
  });

  console.log("\n[1] 登录 → 已核销项目详情");
  await page.goto(BASE, { waitUntil: "networkidle" });
  await page.waitForTimeout(700);
  await page.fill('input[name="username"]', "admin");
  await page.fill('input[name="password"]', "123456");
  await page.click("#lbtn");
  await page.waitForSelector("#pwdBtn", { timeout: 30000 });
  await page.goto(`${BASE}/#/projects/${pid}`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector('[data-act="settle"]', { timeout: 30000 });
  await page.waitForTimeout(600);

  console.log("[2] 打开「生成结算单」弹窗");
  await page.click('[data-act="settle"]');
  await page.waitForTimeout(600);
  const modalText = (await page.textContent("#modal")) || "";
  check("弹窗标题是「生成结算单」", /生成结算单/.test(modalText), modalText.slice(0, 60));
  check("文案说明不产生付款动作", /不产生任何付款动作/.test(modalText), modalText.slice(0, 200));

  const fieldCount = await page.$$eval("#modal .mb input, #modal .mb select, #modal .mb textarea", (els) => els.length);
  check("弹窗里一个输入框都没有", fieldCount === 0, `实际 ${fieldCount} 个`);
  for (const name of ["payee", "payee_bank", "payee_account"]) {
    const n = await page.$$eval(`#modal [name="${name}"]`, (els) => els.length);
    check(`没有 ${name} 输入框`, n === 0, `实际 ${n} 个`);
  }

  console.log("\n[3] 直接确认，应能生成结算单");
  await page.click('#modal [data-x="1"]');
  await page.waitForTimeout(1500);
  const st = await api("GET", `/api/projects/${pid}`);
  check("项目状态变为已结算", st.data.project.status === "已结算", st.data.project.status);
  const settle = st.data.settlement;
  check("结算单已生成", !!settle, JSON.stringify(settle));
  if (settle) {
    check("结算单不再记录收款方", settle.payee == null && settle.payee_account == null,
      JSON.stringify({ payee: settle.payee, bank: settle.payee_bank, acct: settle.payee_account }));
    check("收入/支出/结余自洽",
      Number(settle.profit) === Number(settle.income) - Number(settle.expense),
      JSON.stringify(settle));
  }

  console.log("\n[4] 财务结算页的结算单列表");
  await page.goto(`${BASE}/#/finance`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#fin-settlements", { timeout: 30000 });
  await page.waitForTimeout(900);
  const listText = (await page.textContent("#fin-settlements")) || "";
  check("列表里没有「收款方 / 收款账户」列", !/收款方|收款账户/.test(listText), listText.slice(0, 160));
  check("列表里能看到刚生成的结算单", listText.includes(settle.id), settle.id);

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
