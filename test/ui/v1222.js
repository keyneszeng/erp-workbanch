/**
 * V1.2.22 UI 定点：系统配置页的「重置为出厂数据」入口
 * 运行：node test/ui/v1222.js
 *
 * 老板问「删除出厂数据的权限在哪里」，接着要一个界面入口。
 * 这个入口的风险不在于「能不能点」，而在于「会不会被顺手点掉」，所以验的是三道闸：
 *   1. 只有总管理员看得见（其他人连这个页面都进不去）；
 *   2. 弹窗先把**将要删除的数量**摆出来，不是只说「确定吗」；
 *   3. 必须手输「重置」两个字才启用按钮 —— 输错一个字都不行。
 */
const { chromium } = require("playwright");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..", "..");
const PORT = Number(process.env.ERP_PORT || 8840);
const BASE = process.env.ERP_BASE || `http://127.0.0.1:${PORT}`;
const SELF_HOSTED = !process.env.ERP_BASE;
const DB = path.join(ROOT, "data", "ui-v1222.db");
const UP = path.join(ROOT, "data", "ui-v1222-uploads");

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

let proc = null;

async function login(page, user, pass = "123456") {
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await page.waitForSelector('input[name="username"]', { timeout: 30000 });
  await page.fill('input[name="username"]', user);
  await page.fill('input[name="password"]', pass);
  await page.click("#lbtn");
  await page.waitForSelector("#pwdBtn", { timeout: 30000 });
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
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errs = [];
  page.on("pageerror", (e) => errs.push(`[pageerror] ${e.message}`));
  page.on("console", (m) => {
    const t = m.text();
    if (m.type() === "error" && !/Failed to load resource/.test(t)) errs.push(t);
  });

  console.log("\n[1] 总管理员：系统配置页有「危险操作」区");
  await login(page, "admin");
  await page.goto(`${BASE}/#/users`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#resetAll", { timeout: 30000 });
  await page.waitForTimeout(1200);
  const body = (await page.textContent("#content")) || "";
  check("有「危险操作」面板", /危险操作/.test(body));
  check("有「重置为出厂数据」按钮", (await page.locator("#resetAll").count()) === 1);
  check("标了「不可恢复」", /不可恢复/.test(body));

  console.log("\n[2] 弹窗：先摆数量，再要求手输确认");
  await page.click("#resetAll");
  await page.waitForSelector("#modal.open");
  await page.waitForTimeout(800);
  const mbody = (await page.textContent("#modal")) || "";
  check("列出「将删除以下全部数据」", /将删除以下全部数据/.test(mbody), mbody.replace(/\s+/g, " ").slice(0, 140));
  check("显示项目数量", /项目\s*\d+/.test(mbody.replace(/\s+/g, " ")), mbody.replace(/\s+/g, " ").slice(0, 160));
  check("显示账号数量", /账号\s*\d+/.test(mbody.replace(/\s+/g, " ")));
  check("有确认输入框", (await page.locator("#resetWord").count()) === 1);

  const go = page.locator("#doReset");
  check("未输入时「确认重置」是禁用的", await go.isDisabled());

  await page.fill("#resetWord", "重置数据");
  await page.waitForTimeout(200);
  check("输入「重置数据」仍禁用（不是包含匹配）", await go.isDisabled());

  await page.fill("#resetWord", "重置");
  await page.waitForTimeout(300);
  check("输入「重置」后按钮启用", !(await go.isDisabled()));

  console.log("\n[3] 执行重置 → 数据回到出厂 → 掉线回登录页");
  await page.click("#doReset");
  await page.waitForTimeout(2600); // 重置 + toast + 1.2s 后 reload
  const afterReload = await page.locator("#lform").count().catch(() => 0);
  check("重置后回到登录页（会话已失效）", afterReload === 1);

  console.log("\n[4] 重新登录：数据确实是出厂的");
  await login(page, "admin");
  await page.goto(`${BASE}/#/projects`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1800);
  const projBody = (await page.textContent("#content")) || "";
  const nums = (projBody.match(/\d+\s*个/g) || []).join(",");
  check("项目列表回到 18 场", /18\s*个/.test(projBody) || /共\s*18/.test(projBody), nums);
  check("列表里没有「巡检」「测试」字样的残留", !/巡检|qa_|测试数据/.test(projBody));

  console.log("\n[5] 非总管理员看不到这个入口");
  const page2 = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await login(page2, "finance");
  await page2.goto(`${BASE}/#/users`, { waitUntil: "domcontentloaded" });
  await page2.waitForTimeout(1600);
  const hash = await page2.evaluate(() => location.hash);
  const fbody = (await page2.textContent("#content")) || "";
  check("财务进不去系统配置（被路由守卫弹回）", !/#\/users/.test(hash) || !/危险操作/.test(fbody),
    `hash=${hash}`);
  check("页面上没有「重置为出厂数据」", !/重置为出厂数据/.test(fbody));
  await page2.close();

  await page.screenshot({ path: "/tmp/ui-v1222.png", fullPage: true });

  console.log("\n[6] 控制台");
  check("无 JS 报错", errs.length === 0, errs.slice(0, 3).join(" | "));

  await browser.close();
  if (proc) proc.kill("SIGTERM");
  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error("脚本异常：", e);
  if (proc) proc.kill("SIGTERM");
  process.exit(2);
});
