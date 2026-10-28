/**
 * 一次性截图：材料排在核销前面 + 核销未开启的横幅（V1.2.19）
 */
const { chromium } = require("playwright");
const path = require("node:path");
const OUT = path.join(__dirname, "..", "docs", "v1.2.19");
(async () => {
  const b = await chromium.launch({ channel: "chrome", headless: true });
  const p = await b.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
  await p.goto("https://erp.aibuild.work", { waitUntil: "networkidle", timeout: 60000 });
  await p.waitForTimeout(1200);
  await p.fill('input[name="username"]', "admin");
  await p.fill('input[name="password"]', "123456");
  await p.click("#lbtn");
  await p.waitForSelector("#pwdBtn", { timeout: 40000 });
  await p.goto("https://erp.aibuild.work/#/projects/MP-2026-017", { waitUntil: "domcontentloaded", timeout: 60000 });
  await p.waitForSelector("[data-tab]", { timeout: 30000 });
  await p.waitForTimeout(1800);
  await p.screenshot({ path: path.join(OUT, "01-页签顺序-材料在核销前.png"), fullPage: true });

  await p.click('[data-tab="verify"]');
  await p.waitForTimeout(1500);
  await p.screenshot({ path: path.join(OUT, "02-核销未开启-材料缺8类.png"), fullPage: true });
  await b.close();
  console.log("done");
})().catch((e) => { console.error(e); process.exit(1); });
