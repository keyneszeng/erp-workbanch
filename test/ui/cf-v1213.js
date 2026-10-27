/**
 * V1.2.13 线上验证：合同类别 / 材料与例外单自定义填入（**只读**，不改生产数据）
 * 运行：node test/ui/cf-v1213.js
 *
 * 只验老板报的三条在真实环境里成立，不提交任何东西：
 *   1. MP-2026-012 第 5 步不再列出 HT-2026-008「会场租赁及餐饮」
 *   2. 合同台账 / 项目详情能看到类别标签
 *   3. 例外单与材料登记的下拉都多了「自定义填入」
 */
const { chromium } = require("playwright");

const BASE = process.env.ERP_BASE || "https://erp.aibuild.work";
const PID = "MP-2026-012"; // 老板报的那个项目：只有一份「会场租赁及餐饮」合同

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
  return { ctx, page, errs };
}

async function openTab(page, pid, tab) {
  await page.evaluate(() => {
    const m = document.getElementById("modal");
    if (m) { m.classList.remove("open"); m.innerHTML = ""; }
  });
  await page.goto(`${BASE}/#/projects/${pid}`, { waitUntil: "networkidle", timeout: 60000 });
  await page.waitForTimeout(2200);
  await page.click(`[data-tab="${tab}"]`);
  await page.waitForTimeout(1200);
}

(async () => {
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  const allErrs = [];
  const closeAll = [];
  const sess = async (u) => { const s = await openAs(browser, u); closeAll.push(s.ctx); allErrs.push(...s.errs); return s; };

  console.log("\n[1] MP-2026-012 第 5 步「劳务与专家费核对」");
  const exec1 = await sess("exec");
  await openTab(exec1.page, PID, "verify");
  await exec1.page.click('[data-detail="5"]');
  await exec1.page.waitForTimeout(1200);
  const title = (await exec1.page.textContent("#modal .mh")) || "";
  const body = (await exec1.page.textContent("#modal .mb")) || "";
  check("弹窗标题是「劳务与专家费核对」", /劳务与专家费核对/.test(title), title);
  check("不再出现「会场租赁及餐饮」", !/会场租赁及餐饮/.test(body), body.slice(0, 200));
  check("明说没有劳务专家类合同", /没有「劳务专家」类合同/.test(body), body.slice(0, 260));
  check("明说另有其它类别合同归第 6 步", /另有 \d+ 份其它类别合同/.test(body), body.slice(0, 260));
  await exec1.page.click('#modal [data-x="0"]');
  await exec1.page.waitForTimeout(500);

  console.log("\n[2] 合同类别标签");
  await openTab(exec1.page, PID, "contracts");
  const contractBody = (await exec1.page.textContent("#tabbody")) || "";
  check("项目详情合同名称后有类别标签", /场地餐饮/.test(contractBody), contractBody.slice(0, 260));

  console.log("\n[3] 例外单：对应步骤可自定义（只开弹窗，不提交）");
  // MP-2026-004 是「待核销」，只有这个阶段才有「提交例外单」按钮；admin 有提交权限
  const admin = await sess("admin");
  await openTab(admin.page, "MP-2026-004", "verify");
  const hasAddEx = !!(await admin.page.$("#addEx"));
  check("待核销项目有「提交例外单」按钮", hasAddEx);
  if (hasAddEx) {
    await admin.page.click("#addEx");
    await admin.page.waitForTimeout(900);
    const opts = await admin.page.$$eval('#modal [name="step_no"] option', (os) => os.map((o) => o.value));
    check("步骤下拉 6 步 + 自定义", opts.length === 7 && opts.includes("__custom__"), JSON.stringify(opts));
    check("自定义文本框默认隐藏", !(await admin.page.isVisible('#modal [name="step_no__custom"]')));
    await admin.page.selectOption('#modal [name="step_no"]', "__custom__");
    await admin.page.waitForTimeout(500);
    check("选中后文本框出现", await admin.page.isVisible('#modal [name="step_no__custom"]'));
    await admin.page.click('#modal [data-x="0"]');
    await admin.page.waitForTimeout(400);
  }

  console.log("\n[4] 材料登记：类别可自定义（只开弹窗，不保存）");
  await openTab(exec1.page, PID, "materials");
  const hasAddMat = !!(await exec1.page.$("#addMat"));
  // MP-2026-012 线上已归档 —— 归档后卷宗封存，本来就不该出现「登记材料」。
  // 这条顺便当成一次封存回归。
  check("已归档项目不显示「登记材料」按钮", !hasAddMat);

  // 换一个未归档项目验自定义类别（MP-2026-014 执行中，exec 是成员）
  const MAT_PID = "MP-2026-014";
  await openTab(exec1.page, MAT_PID, "materials");
  const hasAddMat2 = !!(await exec1.page.$("#addMat"));
  check("未归档项目有「登记材料」按钮", hasAddMat2);
  if (hasAddMat2) {
    await exec1.page.click("#addMat");
    await exec1.page.waitForTimeout(900);
    const kinds = await exec1.page.$$eval('#modal [name="kind"] option', (os) => os.map((o) => o.value));
    check("类别下拉 8 类 + 自定义", kinds.length === 9 && kinds.includes("__custom__"), JSON.stringify(kinds));
    check("自定义文本框默认隐藏", !(await exec1.page.isVisible('#modal [name="kind__custom"]')));
    await exec1.page.selectOption('#modal [name="kind"]', "__custom__");
    await exec1.page.waitForTimeout(500);
    check("选中后文本框出现", await exec1.page.isVisible('#modal [name="kind__custom"]'));
    await exec1.page.click('#modal [data-x="0"]');
    await exec1.page.waitForTimeout(400);
  }

  console.log("\n[5] 合同台账的类别标签");
  const assoc = await sess("assoc");
  await assoc.page.goto(`${BASE}/#/contracts`, { waitUntil: "networkidle", timeout: 60000 });
  await assoc.page.waitForTimeout(2000);
  const ledger = (await assoc.page.textContent("#content")) || "";
  const catCount = await assoc.page.locator("#content .cat").count();
  check("台账里每份合同都带类别", catCount > 0, `标签数 ${catCount}`);
  check("类别取值在五类之内", /场地餐饮|物料搭建|劳务专家|设备技术|其他/.test(ledger));

  console.log("\n[6] 页面错误");
  check("无 JS 报错", allErrs.length === 0, allErrs.slice(0, 3).join(" | "));

  for (const c of closeAll) await c.close();
  await browser.close();
  console.log(`\n=== ${pass} 通过 / ${fail} 失败 ===`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error("脚本异常：", e);
  process.exit(1);
});
