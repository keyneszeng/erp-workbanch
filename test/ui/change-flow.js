/**
 * 变更双人复核 + 合同两步签署 —— UI 定点验证（真实 Chrome）
 * 运行：node test/ui/change-flow.js
 *
 * 验两件事在**页面上**真的成立，而不只是接口能拦：
 *   1. 变更：exec 提交 → admin 审批 → 页面仍显示「已通过 / 待落账」，
 *      审批人和提交人看到的「执行落账」都是灰的（并写明为什么），
 *      换 assoc 点才真的把预算写进项目。
 *   2. 合同：录入只能选「草稿 / 待签署」；草稿「提交签署」→ 待签署，
 *      协会管理员「确认签署」→ 已签署且带上签署日期。
 *
 * 脚本自带服务，不依赖外部进程（设 ERP_BASE 可指向已有服务）。
 */
const { chromium } = require("playwright");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..", "..");
const PORT = Number(process.env.ERP_PORT || 8817);
const BASE = process.env.ERP_BASE || `http://127.0.0.1:${PORT}`;
const SELF_HOSTED = !process.env.ERP_BASE;
const DB = path.join(ROOT, "data", "ui-change.db");
const UP = path.join(ROOT, "data", "ui-change-uploads");

const PID = "MP-2026-001";           // 筹备中，exec / assoc 都看得见
const CHG_TITLE = "UI 验证：预算上调 6000（双人复核）";
const NEW_BUDGET = 186000;            // 原 180000 + 6000
const CT_NAME = "UI 验证合同（两步签署）";

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
function todayStr() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
// 与前端 money() 同口径：只做千分位，不带小数
function money(n) {
  return Number(n || 0).toLocaleString("zh-CN");
}

let proc = null;

/** 开一个独立上下文登录指定账号（各角色的 Cookie 互不干扰） */
async function openAs(browser, username) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  const errs = [];
  page.on("pageerror", (e) => errs.push(`[pageerror] ${e.message}`));
  page.on("console", (m) => {
    const t = m.text();
    // 401/403/404 是脚本故意触发的（例如非管理员点按钮被拦），不算页面错误
    if (m.type() === "error" && !/Failed to load resource/.test(t)) errs.push(t);
  });
  await page.addInitScript(() => {
    window.__toasts = [];
    const hook = () => {
      const box = document.getElementById("toast");
      if (!box) return setTimeout(hook, 50);
      new MutationObserver((ms) => {
        for (const m of ms) for (const n of m.addedNodes) {
          if (n.textContent) window.__toasts.push(n.textContent);
        }
      }).observe(box, { childList: true });
    };
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", hook);
    else hook();
  });
  await page.goto(BASE, { waitUntil: "networkidle" });
  await page.waitForTimeout(700);
  for (let i = 0; i < 3; i++) {
    await page.fill('input[name="username"]', username);
    await page.fill('input[name="password"]', "123456");
    if ((await page.inputValue('input[name="username"]')) === username) break;
    await page.waitForTimeout(300);
  }
  await page.click("#lbtn");
  await page.waitForTimeout(2200);
  page.__errs = errs;
  return { ctx, page, errs };
}

/** 变更记录里按标题定位那一行 */
function changeRow(page, title) {
  return page.locator(`tr:has-text("${title}")`).first();
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

  const browser = await chromium.launch({ channel: "chrome", headless: true });
  const allErrs = [];
  const closeAll = [];
  const sess = async (u) => { const s = await openAs(browser, u); closeAll.push(s.ctx); allErrs.push(...s.errs); return s; };

  /* ================= 一、变更双人复核 ================= */
  console.log("\n[1] exec 在项目详情提交变更");
  const exec1 = await sess("exec");
  await exec1.page.goto(`${BASE}/#/projects/${PID}`, { waitUntil: "networkidle" });
  await exec1.page.waitForTimeout(1600);
  check("项目详情有「提交变更」按钮", !!(await exec1.page.$("#changeBtn")));

  const panelText = (await exec1.page.textContent("#content")) || "";
  check("有「变更记录」面板", /变更记录/.test(panelText));
  check("表头有「落账人」列", /落账人/.test(panelText));
  check("顶部提示有已批未落账的变更", /尚未落账/.test(panelText));

  await exec1.page.click("#changeBtn");
  await exec1.page.waitForTimeout(600);
  await exec1.page.fill('#modal [name="title"]', CHG_TITLE);
  await exec1.page.fill('#modal [name="budget"]', String(NEW_BUDGET));
  await exec1.page.click('#modal [data-x="1"]');
  await exec1.page.waitForTimeout(2000);
  const t1 = await exec1.page.evaluate(() => window.__toasts || []);
  check("提交成功提示", t1.some((t) => /变更申请 .* 已提交/.test(t)), JSON.stringify(t1).slice(0, 160));

  console.log("\n[2] admin 在审批中心通过（审批 ≠ 生效）");
  const admin = await sess("admin");
  await admin.page.goto(`${BASE}/#/approvals`, { waitUntil: "networkidle" });
  await admin.page.waitForTimeout(1500);
  await admin.page.click('[data-v="all"]');
  await admin.page.waitForTimeout(1200);
  const adminRow = changeRow(admin.page, CHG_TITLE);
  check("审批中心能看到这张变更单", (await adminRow.count()) > 0);
  await adminRow.locator('[data-ok]').first().click();
  await admin.page.waitForTimeout(700);
  await admin.page.fill("#modal textarea", "同意变更");
  await admin.page.click('#modal [data-x="1"]');
  await admin.page.waitForTimeout(2200);
  const t2 = await admin.page.evaluate(() => window.__toasts || []);
  check("通过提示写明「待另一人执行落账」",
    t2.some((t) => /待另一人执行落账/.test(t)), JSON.stringify(t2).slice(0, 200));

  await admin.page.goto(`${BASE}/#/projects/${PID}`, { waitUntil: "networkidle" });
  await admin.page.waitForTimeout(1600);
  const adminChgRow = changeRow(admin.page, CHG_TITLE);
  const adminBtn = adminChgRow.locator("[data-exec]").first();
  check("审批人看到的落账按钮是灰的", await adminBtn.isDisabled().catch(() => false));
  const adminTip = (await adminBtn.getAttribute("title")) || "";
  check("灰按钮写明「这张单是你审批的」", /你审批的/.test(adminTip), adminTip);

  const budgetTxt = (await admin.page.textContent("#content")) || "";
  check("项目预算仍是 180,000（审批没动账）", budgetTxt.includes(money(180000)), money(180000));

  console.log("\n[3] 提交人自己也不能落账");
  const exec2 = await sess("exec");
  await exec2.page.goto(`${BASE}/#/projects/${PID}`, { waitUntil: "networkidle" });
  await exec2.page.waitForTimeout(1600);
  const execBtn = changeRow(exec2.page, CHG_TITLE).locator("[data-exec]").first();
  check("提交人看到的落账按钮是灰的", await execBtn.isDisabled().catch(() => false));
  const execTip = (await execBtn.getAttribute("title")) || "";
  check("灰按钮写明「这张单是你提交的」", /你提交的/.test(execTip), execTip);

  console.log("\n[4] 换 assoc 落账：预算才真正写回");
  const assoc = await sess("assoc");
  await assoc.page.goto(`${BASE}/#/projects/${PID}`, { waitUntil: "networkidle" });
  await assoc.page.waitForTimeout(1600);
  const assocBtn = changeRow(assoc.page, CHG_TITLE).locator("[data-exec]").first();
  check("第三人看到的落账按钮可点", !(await assocBtn.isDisabled().catch(() => true)));
  await assocBtn.click();
  await assoc.page.waitForTimeout(700);
  const cfmText = (await assoc.page.textContent("#modal")) || "";
  check("二次确认写明会改预算", /预算/.test(cfmText));
  await assoc.page.click('#modal [data-x="1"]');
  await assoc.page.waitForTimeout(2200);
  const t4 = await assoc.page.evaluate(() => window.__toasts || []);
  check("落账成功提示", t4.some((t) => /已落账/.test(t)), JSON.stringify(t4).slice(0, 160));

  await assoc.page.reload({ waitUntil: "networkidle" });
  await assoc.page.waitForTimeout(1600);
  const afterTxt = (await assoc.page.textContent("#content")) || "";
  check("预算已改为 186,000", afterTxt.includes(money(NEW_BUDGET)));
  const doneRow = (await changeRow(assoc.page, CHG_TITLE).textContent()) || "";
  check("该行状态变「已执行」", /已执行/.test(doneRow), doneRow.replace(/\s+/g, " ").slice(0, 140));
  check("该行记下落账人「王敏」", /王敏/.test(doneRow), doneRow.replace(/\s+/g, " ").slice(0, 140));
  check("落账后不再提示待落账（这条已清）",
    !/UI 验证：预算上调 6000（双人复核）[\s\S]{0,40}尚未落账/.test(afterTxt));

  /* ================= 二、合同两步签署 ================= */
  console.log("\n[5] 录入合同只能选「草稿 / 待签署」");
  await exec2.page.goto(`${BASE}/#/contracts`, { waitUntil: "networkidle" });
  await exec2.page.waitForTimeout(1600);
  await exec2.page.click("#newC");
  await exec2.page.waitForTimeout(600);
  const opts = await exec2.page.$$eval('#modal [name="status"] option', (els) => els.map((o) => o.value));
  check("状态下拉只有草稿 / 待签署", JSON.stringify(opts) === JSON.stringify(["草稿", "待签署"]), JSON.stringify(opts));

  await exec2.page.selectOption('#modal [name="pid"]', PID);
  await exec2.page.fill('#modal [name="name"]', CT_NAME);
  await exec2.page.fill('#modal [name="vendor"]', "UI 验证供应商");
  await exec2.page.fill('#modal [name="amount"]', "12000");
  await exec2.page.selectOption('#modal [name="status"]', "草稿");
  await exec2.page.click('#modal [data-x="1"]');
  await exec2.page.waitForTimeout(2500);
  check("草稿合同已保存", !(await exec2.page.$("#modal.open")));

  console.log("\n[6] 草稿 → 提交签署 → 待签署");
  const ctRow = () => exec2.page.locator(`tr:has-text("${CT_NAME}")`).first();
  check("该行初始状态是「草稿」", /草稿/.test((await ctRow().textContent()) || ""));
  await ctRow().locator('[data-cflow][data-caction="submit"]').first().click();
  await exec2.page.waitForTimeout(2200);
  const t6 = await exec2.page.evaluate(() => window.__toasts || []);
  check("提交签署成功提示", t6.some((t) => /提交签署成功/.test(t)), JSON.stringify(t6).slice(0, 160));
  await exec2.page.reload({ waitUntil: "networkidle" });
  await exec2.page.waitForTimeout(1600);
  check("状态变「待签署」", /待签署/.test((await ctRow().textContent()) || ""));
  check("执行看到「待协会确认」（不能自己落章）",
    /待协会确认/.test((await ctRow().textContent()) || ""));

  console.log("\n[7] 协会管理员确认签署 → 已签署 + 签署日期");
  await assoc.page.goto(`${BASE}/#/contracts`, { waitUntil: "networkidle" });
  await assoc.page.waitForTimeout(1600);
  const aRow = assoc.page.locator(`tr:has-text("${CT_NAME}")`).first();
  const signBtn = aRow.locator('[data-cflow][data-caction="sign"]').first();
  check("协会管理员看到「确认签署」", (await signBtn.count()) > 0);
  await signBtn.click();
  await assoc.page.waitForTimeout(700);
  // 确认签署前有一次二次确认（落章不可撤销）
  const signCfm = (await assoc.page.textContent("#modal").catch(() => "")) || "";
  check("确认签署前有二次确认", /已签署/.test(signCfm), signCfm.replace(/\s+/g, " ").slice(0, 90));
  await assoc.page.click('#modal [data-x="1"]');
  await assoc.page.waitForTimeout(2200);
  const t7 = await assoc.page.evaluate(() => window.__toasts || []);
  check("确认签署成功提示", t7.some((t) => /确认签署成功/.test(t)), JSON.stringify(t7).slice(0, 160));
  await assoc.page.reload({ waitUntil: "networkidle" });
  await assoc.page.waitForTimeout(1600);
  const signedRow = (await assoc.page.locator(`tr:has-text("${CT_NAME}")`).first().textContent()) || "";
  check("状态变「已签署」", /已签署/.test(signedRow), signedRow.replace(/\s+/g, " ").slice(0, 160));
  check("签署日期自动记为今天", signedRow.includes(todayStr()), todayStr());

  console.log("\n[8] 零 JS 报错");
  const realErrs = allErrs.filter((e) => !/Failed to load resource/.test(e));
  check("全程无 pageerror", realErrs.length === 0, realErrs.slice(0, 3).join(" | "));

  await Promise.all(closeAll.map((c) => c.close().catch(() => {})));
  await browser.close();
  if (proc) proc.kill("SIGTERM");

  console.log(`\n${fail === 0 ? "ALL PASS" : "FAILED"}  ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})().catch(async (e) => {
  console.error("UI CHANGE-FLOW FAILED:", e.message);
  if (proc) proc.kill("SIGTERM");
  process.exit(1);
});
