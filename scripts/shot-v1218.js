/**
 * 一次性截图：付款与结算单的收款方 / 银行账号（V1.2.18）
 */
const { chromium } = require("playwright");
const path = require("node:path");
const OUT = path.join(__dirname, "..", "docs", "v1.2.18");
(async () => {
  const b = await chromium.launch({ channel: "chrome", headless: true });
  const p = await b.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
  await p.goto("https://erp.aibuild.work", { waitUntil: "networkidle", timeout: 60000 });
  await p.waitForTimeout(1200);
  await p.fill('input[name="username"]', "finance");
  await p.fill('input[name="password"]', "123456");
  await p.click("#lbtn");
  await p.waitForSelector("#pwdBtn", { timeout: 40000 });
  await p.click('button[data-go="finance"]');
  await p.waitForSelector(".panel .panel-h", { timeout: 30000 });
  await p.waitForTimeout(1800);
  await p.screenshot({ path: path.join(OUT, "01-付款与结算-收款账户列.png"), fullPage: true });

  await p.click("#newPay");
  await p.waitForSelector("#modal.open");
  await p.fill('#modal input[name="payee"]', "北京国际会议中心");
  await p.fill('#modal input[name="payee_bank"]', "中国银行北京朝阳支行");
  await p.fill('#modal input[name="payee_account"]', "3210 1234 5678 9012");
  await p.fill('#modal input[name="amount"]', "84000");
  await p.waitForTimeout(400);
  await p.screenshot({ path: path.join(OUT, "02-付款申请-开户行与账号.png"), fullPage: true });
  await b.close();
  console.log("done");
})().catch((e) => { console.error(e); process.exit(1); });
