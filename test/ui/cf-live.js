"use strict";
/**
 * Cloudflare 线上 UI 冒烟：真实浏览器跑一遍关键路径
 * 用法：node test/ui/cf-live.js
 */
const { chromium } = require("playwright");

const BASE = process.env.ERP_BASE || "https://erp.aibuild.work";
const shots = [];

async function main() {
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  page.on("pageerror", (e) => errors.push("pageerror: " + e.message));

  const results = [];
  const check = (name, cond, extra = "") => {
    results.push({ name, ok: !!cond, extra });
    console.log(`  ${cond ? "✓" : "✗"} ${name}${extra ? "  " + extra : ""}`);
  };

  // 1. 首页
  await page.goto(BASE, { waitUntil: "networkidle", timeout: 60000 });
  const title = await page.title();
  check("首页加载", title.length > 0, title);
  await page.screenshot({ path: "/tmp/cf-01-login.png" });
  shots.push("/tmp/cf-01-login.png");

  // 2. 登录
  // ⚠️ 线上网络慢时 boot() 里的 /api/auth/me 可能晚于填表返回，把登录页重新渲染一遍清空输入。
  //    所以先等表单稳定，填完再确认值确实进去了，不行就重填一次。
  const inputs = await page.$$("input");
  check("登录表单存在", inputs.length >= 2, `${inputs.length} 个输入框`);
  await page.waitForTimeout(800);
  for (let i = 0; i < 3; i++) {
    await page.fill('input[name="username"]', "admin");
    await page.fill('input[name="password"]', "123456");
    const u = await page.inputValue('input[name="username"]');
    const p = await page.inputValue('input[name="password"]');
    if (u === "admin" && p === "123456") break;
    await page.waitForTimeout(500);
  }
  await page.click("#lbtn");
  await page.waitForTimeout(3000);

  const bodyText = await page.textContent("body");
  check("登录后进入系统", !/请输入账号与密码|账号或密码错误/.test(bodyText), "");
  check("出现工作台内容", /项目|会议|待办|统计/.test(bodyText));
  await page.screenshot({ path: "/tmp/cf-02-dashboard.png", fullPage: false });
  shots.push("/tmp/cf-02-dashboard.png");

  // 3. 导航到会务需求
  const navClicked = await page.evaluate(() => {
    const els = [...document.querySelectorAll("a,button,li,div")];
    const t = els.find((e) => e.textContent?.trim() === "会务需求");
    if (t) { t.click(); return true; }
    return false;
  });
  check("点击「会务需求」", navClicked);
  await page.waitForTimeout(2000);
  const demandText = await page.textContent("body");
  check("需求列表渲染", /需求|确认|项目/.test(demandText));
  await page.screenshot({ path: "/tmp/cf-03-demand-list.png" });
  shots.push("/tmp/cf-03-demand-list.png");

  // 4. 打开第一张需求单（点「去填写」）
  const opened = await page.evaluate(() => {
    const els = [...document.querySelectorAll("button,a,span")];
    const b = els.find((e) => (e.textContent || "").trim() === "去填写");
    if (b) { b.click(); return true; }
    return false;
  });
  check("点击「去填写」", opened);
  await page.waitForTimeout(2500);
  const sheetText = await page.textContent("body");
  const groups = ["设计", "制作", "现场执行", "其他"].filter((g) => sheetText.includes(g));
  const sampleItems = ["串场", "议程A4单张", "控台", "代购酒水", "车队服务"].filter((i) => sheetText.includes(i));
  check("四个分组齐全", groups.length === 4, groups.join("/"));
  check("模板条目渲染", sampleItems.length >= 4, sampleItems.join("/"));
  await page.screenshot({ path: "/tmp/cf-04-demand-sheet.png", fullPage: true });
  shots.push("/tmp/cf-04-demand-sheet.png");

  // 5. 刷新后仍在（SPA 路由 + Assets fallback）
  const url = page.url();
  await page.reload({ waitUntil: "networkidle", timeout: 60000 });
  await page.waitForTimeout(1500);
  const afterReload = await page.textContent("body");
  check("直接刷新子路由不 404", /设计|需求/.test(afterReload), url.replace(BASE, ""));

  check("无控制台报错", errors.length === 0, errors.slice(0, 3).join(" | "));

  await browser.close();

  const failed = results.filter((r) => !r.ok);
  console.log(`\n通过 ${results.length - failed.length}/${results.length}`);
  if (failed.length) {
    failed.forEach((f) => console.log("  ✗ " + f.name + " " + f.extra));
    process.exit(1);
  }
}

main().catch((e) => { console.error("UI 冒烟异常：", e.message); process.exit(2); });
