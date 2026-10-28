const { chromium } = require("playwright");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const BASE = "http://127.0.0.1:8793";
(async () => {
  for (const f of ["/tmp/erp-nav/erp.db", "/tmp/erp-nav/erp.db-wal", "/tmp/erp-nav/erp.db-shm"]) if (fs.existsSync(f)) fs.unlinkSync(f);
  fs.mkdirSync("/tmp/erp-nav", { recursive: true });
  const proc = spawn(process.execPath, ["--experimental-sqlite", "server/index.js"], {
    env: { ...process.env, ERP_PORT: "8793", ERP_DB: "/tmp/erp-nav/erp.db", ERP_UPLOAD_DIR: "/tmp/erp-nav/up" }, stdio: "ignore"
  });
  for (let i = 0; i < 100; i++) { try { const r = await fetch(BASE + "/api/health"); if (r.ok) break; } catch {} await new Promise(r => setTimeout(r, 200)); }

  const b = await chromium.launch({ channel: "chrome", headless: true });
  const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
  p.on("pageerror", (e) => console.log("[pageerror]", e.message));
  p.on("console", (m) => { if (m.type() === "error") console.log("[console]", m.text()); });
  await p.goto(BASE, { waitUntil: "networkidle" });
  await p.waitForTimeout(700);
  await p.fill('input[name="username"]', "admin");
  await p.fill('input[name="password"]', "123456");
  await p.click("#lbtn");
  await p.waitForSelector("#pwdBtn", { timeout: 20000 });

  console.log("--- 立刻点（不等工作台渲染完）---");
  await p.click('button[data-go="approvals"]');
  await p.waitForTimeout(2500);
  console.log("hash:", await p.evaluate(() => location.hash));
  console.log("有 #body:", await p.evaluate(() => !!document.getElementById("body")));
  console.log("内容开头:", (await p.textContent("#content")).replace(/\s+/g, " ").slice(0, 80));

  console.log("--- 再点一次 ---");
  await p.click('button[data-go="approvals"]');
  await p.waitForTimeout(2500);
  console.log("有 #body:", await p.evaluate(() => !!document.getElementById("body")));
  console.log("内容开头:", (await p.textContent("#content")).replace(/\s+/g, " ").slice(0, 80));

  console.log("--- 等 5 秒后再从工作台点 ---");
  await p.click('button[data-go="dashboard"]');
  await p.waitForTimeout(5000);
  await p.click('button[data-go="approvals"]');
  await p.waitForTimeout(2500);
  console.log("有 #body:", await p.evaluate(() => !!document.getElementById("body")));

  await b.close(); proc.kill("SIGTERM");
})().catch(e => { console.error("异常:", e.message); process.exit(1); });
