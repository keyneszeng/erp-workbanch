/** 一次性截图：付款页签在核销后面（V1.2.20）—— 走本地服务，不依赖线上网络 */
const { chromium } = require("playwright");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const PORT = 8791;
const BASE = `http://127.0.0.1:${PORT}`;
const DB = "/tmp/shot-v1220/erp.db";
const UP = "/tmp/shot-v1220/up";
const OUT = path.join(ROOT, "docs", "v1.2.20");

(async () => {
  fs.rmSync("/tmp/shot-v1220", { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });
  const proc = spawn(process.execPath, ["--experimental-sqlite", "server/index.js"], {
    cwd: ROOT, env: { ...process.env, ERP_PORT: String(PORT), ERP_DB: DB, ERP_UPLOAD_DIR: UP }, stdio: "ignore"
  });
  for (let i = 0; i < 100; i++) {
    try { const r = await fetch(`${BASE}/api/health`); if (r.ok) break; } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }

  const b = await chromium.launch({ channel: "chrome", headless: true });
  const p = await b.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
  await p.goto(BASE, { waitUntil: "domcontentloaded" });
  await p.waitForSelector('input[name="username"]');
  await p.fill('input[name="username"]', "admin");
  await p.fill('input[name="password"]', "123456");
  await p.click("#lbtn");
  await p.waitForSelector("#pwdBtn", { timeout: 30000 });
  await p.goto(`${BASE}/#/projects/MP-2026-017`, { waitUntil: "domcontentloaded" });
  await p.waitForSelector("[data-tab]", { timeout: 30000 });
  await p.waitForTimeout(1800);
  await p.screenshot({ path: path.join(OUT, "01-页签顺序-核销在付款前.png"), fullPage: true });
  await b.close();
  proc.kill("SIGTERM");
  console.log("done");
})().catch((e) => { console.error(e.message); process.exit(1); });
