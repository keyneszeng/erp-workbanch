/**
 * 一次性截图：guest 视角的工作台与侧栏 —— 对应报告 BUG-01（在管 3 场）与 UX-01（命名一致）。
 */
const { chromium } = require("playwright");
const path = require("node:path");
const OUT = path.join(__dirname, "..", "docs", "v1.2.17");
(async () => {
  const b = await chromium.launch({ channel: "chrome", headless: true });
  const p = await b.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
  await p.goto("https://erp.aibuild.work", { waitUntil: "networkidle", timeout: 60000 });
  await p.waitForTimeout(1200);
  await p.fill('input[name="username"]', "guest");
  await p.fill('input[name="password"]', "123456");
  await p.click("#lbtn");
  await p.waitForSelector("#pwdBtn", { timeout: 40000 });
  await p.waitForTimeout(2500);
  await p.screenshot({ path: path.join(OUT, "01-嘉宾工作台-在管3场.png"), fullPage: true });

  await p.click('button[data-go="projects"]');
  await p.waitForTimeout(2200);
  await p.screenshot({ path: path.join(OUT, "02-嘉宾项目列表-3场.png"), fullPage: true });
  await b.close();
  console.log("done");
})().catch((e) => { console.error(e); process.exit(1); });
