const { chromium } = require("playwright");
const path = require("node:path");
const OUT = path.join(__dirname, "..", "docs", "v1.2.16");
(async () => {
  const b = await chromium.launch({ channel: "chrome", headless: true });
  const p = await b.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
  await p.goto("https://erp.aibuild.work", { waitUntil: "networkidle", timeout: 60000 });
  await p.waitForTimeout(1200);
  await p.fill('input[name="username"]', "admin");
  await p.fill('input[name="password"]', "123456");
  await p.click("#lbtn");
  await p.waitForSelector("#pwdBtn", { timeout: 40000 });
  await p.click('button[data-go="demand"]');
  await p.waitForSelector(".panel .panel-h", { timeout: 30000 });
  await p.waitForTimeout(1200);
  await p.screenshot({ path: path.join(OUT, "01-会务需求列表-只列筹备执行中.png"), fullPage: true });

  await p.goto("https://erp.aibuild.work/#/projects/MP-2026-001", { waitUntil: "domcontentloaded", timeout: 60000 });
  await p.waitForSelector('[data-tab="demand"]', { timeout: 30000 });
  await p.click('[data-tab="demand"]');
  await p.waitForTimeout(1600);
  await p.screenshot({ path: path.join(OUT, "02-项目详情-会务需求页签.png"), fullPage: true });
  await b.close();
  console.log("done");
})().catch((e) => { console.error(e); process.exit(1); });
