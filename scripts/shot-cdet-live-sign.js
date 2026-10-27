/**
 * 一次性截图：线上「待签署」合同在详情弹窗里直接给「确认签署」。
 * **只截图，不点确认** —— 生产数据不动。
 */
const { chromium } = require("playwright");
const path = require("node:path");

const LIVE = "https://erp.aibuild.work";
const OUT = path.join(__dirname, "..", "docs", "v1.2.14");
const CID = "HT-2026-009"; // 线上唯一一份「待签署」

(async () => {
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  await page.goto(LIVE, { waitUntil: "networkidle", timeout: 60000 });
  await page.waitForTimeout(1200);
  await page.fill('input[name="username"]', "admin");
  await page.fill('input[name="password"]', "123456");
  await page.click("#lbtn");
  await page.waitForTimeout(3000);
  await page.goto(`${LIVE}/#/contracts`, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForTimeout(2500);

  const btn = page.locator(`tr:has-text("${CID}") [data-cdet="${CID}"]`).first();
  if (!(await btn.count())) throw new Error("没找到该合同的详情按钮");
  await btn.click();
  await page.waitForTimeout(1500);
  await page.locator("#modal .mbox").screenshot({ path: path.join(OUT, "05-线上详情-待签署给确认签署.png") });

  // 只截「行内二次确认」的样子，不真的确认 —— 点开确认后立刻用取消退回
  const act = page.locator('#modal .mf .btn-p');
  if (await act.count()) {
    await act.click();
    await page.waitForTimeout(600);
    await page.locator("#modal .mbox").screenshot({ path: path.join(OUT, "06-线上详情-行内二次确认.png") });
    const back = page.locator('#modal [data-back="1"]');
    if (await back.count()) await back.click(); // 退回详情，不提交
    await page.waitForTimeout(400);
  }
  await browser.close();
  console.log("done");
})().catch((e) => { console.error("失败：", e); process.exit(1); });
