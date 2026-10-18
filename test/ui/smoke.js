let chromium;
try { ({ chromium } = require("playwright")); }
catch { ({ chromium } = require("/Users/mac/node_modules/playwright")); }
const BASE = process.env.ERP_BASE || `http://127.0.0.1:${process.env.ERP_PORT || 8787}`;

const PAGES = [
  ["dashboard", "#/dashboard"],
  ["flow", "#/flow"],
  ["projects", "#/projects"],
  ["project-detail", "#/projects/MP-2026-003"],
  ["approvals", "#/approvals"],
  ["verify-list", "#/verify"],
  ["verify-one", "#/verify/MP-2026-003"],
  ["finance", "#/finance"],
  ["contracts", "#/contracts"],
  ["materials", "#/materials"],
  ["archive", "#/archive"],
  ["audit", "#/audit"],
  ["users", "#/users"]
];

(async () => {
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on("console", (m) => { if (m.type() === "error") errors.push("CONSOLE: " + m.text()); });
  page.on("pageerror", (e) => errors.push("PAGEERROR: " + e.message));

  await page.goto(BASE, { waitUntil: "networkidle" });
  await page.waitForSelector("#lform", { timeout: 10000 });
  await page.fill('input[name="username"]', "admin");
  await page.fill('input[name="password"]', "123456");
  await page.click("#lbtn");
  await page.waitForSelector(".layout:not([hidden])", { timeout: 10000 });
  await page.waitForTimeout(600);
  console.log("LOGIN OK, title:", await page.title());

  for (const [name, hash] of PAGES) {
    await page.evaluate((h) => { location.hash = h; }, hash);
    await page.waitForTimeout(900);
    const info = await page.evaluate(() => {
      const c = document.getElementById("content");
      const bad = c.querySelector(".alert-r");
      return { len: c.innerHTML.length, text: (c.innerText || "").slice(0, 60).replace(/\n/g, " "), err: bad ? bad.innerText.slice(0, 120) : "" };
    });
    console.log(`${name.padEnd(16)} len=${String(info.len).padStart(6)} err=${info.err ? "YES " + info.err : "no"} | ${info.text}`);
    await page.screenshot({ path: `/tmp/erp-${name}.png`, fullPage: false });
  }

  console.log("\nERRORS:", errors.length);
  errors.slice(0, 20).forEach((e) => console.log(" -", e));
  await browser.close();
})();
