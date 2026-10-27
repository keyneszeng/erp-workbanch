/**
 * V1.2.12 线上验证：变更双人复核 + 合同两步签署（**只读**，不改生产数据）
 * 运行：node test/ui/cf-change.js
 *
 * 线上数据不碰，只验三件事在真实环境里成立：
 *   1. 变更记录面板 / 未落账 banner / 落账人列 都在
 *   2. 「执行落账」按钮的三种显隐与灰态说明（我批的 / 我提交的 / 可点）
 *   3. 合同两步流转的按钮按角色分权（协会「确认签署」、执行「待协会确认」）
 */
const { chromium } = require("playwright");

const BASE = process.env.ERP_BASE || "https://erp.aibuild.work";
const PID = "MP-2026-001";          // 筹备中，且有一张「已通过未落账」的变更单
const PENDING_CONTRACT = "HT-2026-009"; // 种子里的「待签署」合同

let pass = 0, fail = 0;
const check = (name, ok, extra = "") => {
  if (ok) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}  ${extra}`); }
};

async function openAs(browser, username) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  const errs = [];
  page.on("pageerror", (e) => errs.push(`[pageerror] ${e.message}`));
  page.on("console", (m) => {
    const t = m.text();
    if (m.type() === "error" && !/Failed to load resource/.test(t)) errs.push(t);
  });
  await page.goto(BASE, { waitUntil: "networkidle", timeout: 60000 });
  await page.waitForTimeout(1500);
  for (let i = 0; i < 4; i++) {
    await page.fill('input[name="username"]', username);
    await page.fill('input[name="password"]', "123456");
    if ((await page.inputValue('input[name="username"]')) === username) break;
    await page.waitForTimeout(400);
  }
  await page.click("#lbtn");
  await page.waitForTimeout(3000);
  page.__errs = errs;
  return { ctx, page, errs };
}

(async () => {
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  const allErrs = [];
  const ctxs = [];
  const sess = async (u) => { const s = await openAs(browser, u); ctxs.push(s.ctx); allErrs.push(...s.errs); return s; };

  console.log("\n[1] 协会管理员：变更记录面板 + 自己批的单子不能落账");
  const assoc = await sess("assoc");
  await assoc.page.goto(`${BASE}/#/projects/${PID}`, { waitUntil: "networkidle" });
  await assoc.page.waitForTimeout(2500);
  const assocTxt = (await assoc.page.textContent("#content")) || "";
  check("有「变更记录」面板", /变更记录/.test(assocTxt));
  check("表头有「落账人」列", /落账人/.test(assocTxt));
  check("顶部提示有已批未落账", /尚未落账/.test(assocTxt));

  const assocBtn = assoc.page.locator("[data-exec]").first();
  check("落账按钮存在（说明有已批未落账的单）", (await assocBtn.count()) > 0);
  check("审批人看到的按钮是灰的", await assocBtn.isDisabled().catch(() => false));
  const assocTip = (await assocBtn.getAttribute("title")) || "";
  check("灰态写明「这张单是你审批的」", /你审批的/.test(assocTip), assocTip);

  console.log("\n[2] 会务执行：第三人视角，按钮可点");
  const exec = await sess("exec");
  await exec.page.goto(`${BASE}/#/projects/${PID}`, { waitUntil: "networkidle" });
  await exec.page.waitForTimeout(2500);
  const execBtn = exec.page.locator("[data-exec]").first();
  check("执行看到的按钮可点", (await execBtn.count()) > 0 && !(await execBtn.isDisabled().catch(() => true)));
  const execTip = (await execBtn.getAttribute("title")) || "";
  check("可点态 title 是「执行落账」", /执行落账/.test(execTip), execTip);

  console.log("\n[3] 总管理员：不是提交人也不是审批人，也可点");
  const admin = await sess("admin");
  await admin.page.goto(`${BASE}/#/projects/${PID}`, { waitUntil: "networkidle" });
  await admin.page.waitForTimeout(2500);
  const adminBtn = admin.page.locator("[data-exec]").first();
  check("总管理员看到的按钮可点", (await adminBtn.count()) > 0 && !(await adminBtn.isDisabled().catch(() => true)));

  console.log("\n[4] 审批中心：已批未落账的变更单有「待落账 →」");
  await admin.page.goto(`${BASE}/#/approvals`, { waitUntil: "networkidle" });
  await admin.page.waitForTimeout(2000);
  await admin.page.click('[data-v="all"]');
  await admin.page.waitForTimeout(1500);
  const pendingLink = admin.page.locator('a.link[data-go^="projects/"]', { hasText: "待落账" }).first();
  check("有「待落账 →」链接", (await pendingLink.count()) > 0);

  console.log("\n[5] 工作台待办：变更落账只推给第二个人");
  await admin.page.goto(`${BASE}/#/dashboard`, { waitUntil: "networkidle" });
  await admin.page.waitForTimeout(2500);
  const adminDash = (await admin.page.textContent("#content")) || "";
  check("总管理员待办里有「变更已批准，待落账」", /变更已批准，待落账/.test(adminDash));
  await assoc.page.goto(`${BASE}/#/dashboard`, { waitUntil: "networkidle" });
  await assoc.page.waitForTimeout(2500);
  const assocDash = (await assoc.page.textContent("#content")) || "";
  check("审批人（王敏）待办里没有这条（自己批的不推给自己）", !/变更已批准，待落账/.test(assocDash));

  console.log("\n[6] 合同两步流转：按钮按角色分权");
  await assoc.page.goto(`${BASE}/#/contracts`, { waitUntil: "networkidle" });
  await assoc.page.waitForTimeout(2500);
  const assocCt = assoc.page.locator(`tr:has-text("${PENDING_CONTRACT}")`).first();
  check("协会管理员在「待签署」合同上看到「确认签署」",
    (await assocCt.locator('[data-caction="sign"]').count()) > 0);
  await exec.page.goto(`${BASE}/#/contracts`, { waitUntil: "networkidle" });
  await exec.page.waitForTimeout(2500);
  const execCt = (await exec.page.locator(`tr:has-text("${PENDING_CONTRACT}")`).first().textContent()) || "";
  check("会务执行同一条显示「待协会确认」（不能自己落章）", /待协会确认/.test(execCt),
    execCt.replace(/\s+/g, " ").slice(0, 120));

  console.log("\n[7] 录入合同：状态下拉没有「已签署」");
  await exec.page.click("#newC");
  await exec.page.waitForTimeout(800);
  const opts = await exec.page.$$eval('#modal [name="status"] option', (els) => els.map((o) => o.value));
  check("只能选草稿 / 待签署", JSON.stringify(opts) === JSON.stringify(["草稿", "待签署"]), JSON.stringify(opts));
  await exec.page.click('#modal [data-x="0"]');
  await exec.page.waitForTimeout(500);

  console.log("\n[8] 零 JS 报错");
  const realErrs = allErrs.filter((e) => !/Failed to load resource/.test(e));
  check("全程无 pageerror", realErrs.length === 0, realErrs.slice(0, 3).join(" | "));

  await Promise.all(ctxs.map((c) => c.close().catch(() => {})));
  await browser.close();
  console.log(`\n${fail === 0 ? "ALL PASS" : "FAILED"}  ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error("CF CHANGE FAILED:", e.message); process.exit(1); });
