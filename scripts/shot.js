/**
 * 通用截图脚本 —— 替代原来每版一个的 shot-v12xx.js。
 *
 * 原来每做一个版本就复制一份「登录 → 打开某个页面 → 截整页」的脚本，
 * 到 V1.2.20 已经堆了 6 个几乎一样的文件，改一次等待策略要改 6 遍。
 * 这里参数化：页面路径、登录账号、点哪些按钮、输出到哪，都在命令行给。
 *
 * 用法：
 *   # 线上，截项目详情
 *   node scripts/shot.js --path "#/projects/MP-2026-017" --out docs/v1.2.20/01-页签顺序.png
 *
 *   # 点开某个页签再截（--click 可重复）
 *   node scripts/shot.js --path "#/projects/MP-2026-003" --click '[data-tab="verify"]' \
 *     --out docs/v1.2.20/02-核销页签.png
 *
 *   # 本地起服务（种子数据，不碰线上）
 *   node scripts/shot.js --local --path "#/projects/MP-2026-017" --out /tmp/a.png
 *
 *   # 换账号 / 多等一会儿 / 只截可视区
 *   node scripts/shot.js --user finance --wait 3000 --viewport --out /tmp/b.png
 *
 * 参数：
 *   --path      hash 路由，如 "#/projects/MP-2026-017"（默认首页）
 *   --out       输出 png 路径（必填，相对仓库根目录）
 *   --user      登录账号，默认 admin（密码统一 123456）
 *   --click     点击选择器，可重复；按顺序执行，每次点完等 --step 毫秒
 *   --wait      打开页面后额外等待毫秒，默认 1800
 *   --step      每次点击后的等待，默认 800
 *   --viewport  只截可视区（默认整页 fullPage）
 *   --local     本地起服务（端口 8792，种子数据），不访问线上
 *   --base      指定站点地址（默认 https://erp.aibuild.work）
 *
 * 注意：**一律用 domcontentloaded**。线上响应 2~3 秒且存在长连接，
 * `networkidle` 经常等不到，V1.2.20 截图时连挂三次就是因为它。
 */
const { chromium } = require("playwright");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");

function arg(name, def = "") {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) return def;
  const next = process.argv[i + 1];
  return next && !next.startsWith("--") ? next : "true";
}
function argAll(name) {
  const out = [];
  process.argv.forEach((a, i) => {
    if (a === `--${name}` && process.argv[i + 1] && !process.argv[i + 1].startsWith("--")) {
      out.push(process.argv[i + 1]);
    }
  });
  return out;
}

const LOCAL = process.argv.includes("--local");
const PORT = 8792;
const BASE = arg("base", LOCAL ? `http://127.0.0.1:${PORT}` : "https://erp.aibuild.work");
const HASH = arg("path", "");
const OUT = arg("out");
const USER = arg("user", "admin");
const CLICKS = argAll("click");
const WAIT = Number(arg("wait", 1800));
const STEP = Number(arg("step", 800));
const FULL = !process.argv.includes("--viewport");

if (!OUT) {
  console.error("缺 --out（输出 png 路径）");
  process.exit(1);
}

(async () => {
  let proc = null;
  if (LOCAL) {
    const dir = "/tmp/shot-local";
    fs.rmSync(dir, { recursive: true, force: true });
    proc = spawn(process.execPath, ["--experimental-sqlite", "server/index.js"], {
      cwd: ROOT,
      env: { ...process.env, ERP_PORT: String(PORT), ERP_DB: path.join(dir, "erp.db"), ERP_UPLOAD_DIR: path.join(dir, "up") },
      stdio: "ignore"
    });
    for (let i = 0; i < 100; i++) {
      try { const r = await fetch(`${BASE}/api/health`); if (r.ok) break; } catch {}
      await new Promise((r) => setTimeout(r, 200));
    }
  }

  const browser = await chromium.launch({ channel: "chrome", headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });

  await page.goto(BASE, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForSelector('input[name="username"]', { timeout: 40000 });
  await page.fill('input[name="username"]', USER);
  await page.fill('input[name="password"]', "123456");
  await page.click("#lbtn");
  await page.waitForSelector("#pwdBtn", { timeout: 40000 });

  if (HASH) {
    await page.goto(`${BASE}/${HASH}`, { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForTimeout(WAIT);
  } else {
    await page.waitForTimeout(WAIT);
  }

  for (const sel of CLICKS) {
    await page.click(sel, { timeout: 20000 });
    await page.waitForTimeout(STEP);
  }

  const outPath = path.isAbsolute(OUT) ? OUT : path.join(ROOT, OUT);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  await page.screenshot({ path: outPath, fullPage: FULL });
  await browser.close();
  if (proc) proc.kill("SIGTERM");
  console.log("已保存：" + outPath);
})().catch((e) => {
  console.error("截图失败：" + e.message);
  process.exit(1);
});
