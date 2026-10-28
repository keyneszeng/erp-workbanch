/**
 * V1.2.15 UI 定点验证：审批中心点「通过」不再报「不存在」
 * 运行：node test/ui/v1215.js
 *
 * 老板 2026-10-28 报的：总管理员 → 审批中心 → 待审批两条，点「通过」都提示「不存在了」，
 * 可单子还挂在列表里。这里就在页面上把这两条真点一遍，确认能批掉、能消失。
 *
 * 脚本自带服务（设 ERP_BASE 可指向已有服务）。
 */
const { chromium } = require("playwright");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..", "..");
const PORT = Number(process.env.ERP_PORT || 8835);
const BASE = process.env.ERP_BASE || `http://127.0.0.1:${PORT}`;
const SELF_HOSTED = !process.env.ERP_BASE;
const DB = path.join(ROOT, "data", "ui-v1215.db");
const UP = path.join(ROOT, "data", "ui-v1215-uploads");

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
  // toast 3 秒自动消失，先攒起来
  await page.addInitScript(() => {
    window.__toasts = [];
    const hook = () => {
      const box = document.getElementById("toast");
      if (!box) return setTimeout(hook, 50);
      new MutationObserver((ms) => {
        for (const m of ms) for (const n of m.addedNodes) {
          if (n.textContent) window.__toasts.push(n.textContent);
        }
      }).observe(box, { childList: true });
    };
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", hook);
    else hook();
  });
  const toasts = () => page.evaluate(() => window.__toasts || []);

  console.log("\n[1] 总管理员登录 → 审批中心");
  await page.goto(BASE, { waitUntil: "networkidle" });
  await page.waitForTimeout(700);
  await page.fill('input[name="username"]', "admin");
  await page.fill('input[name="password"]', "123456");
  await page.click("#lbtn");
  await page.waitForTimeout(2200);
  await page.goto(`${BASE}/#/approvals`, { waitUntil: "networkidle" });
  await page.waitForTimeout(1800);
  check("进了审批中心", /审批中心/.test((await page.textContent("#content")) || ""));

  const rowText = (await page.textContent("#content")) || "";
  check("待审批里有例外单 AP-2026-013", /AP-2026-013/.test(rowText));
  check("待审批里有付款单 AP-2026-012", /AP-2026-012/.test(rowText));

  /** 点某一行的「通过」→ 填意见 → 确认 */
  const approve = async (id, comment) => {
    const btn = page.locator(`tr[data-row="${id}"] [data-ok="${id}"]`);
    check(`${id} 有「通过」按钮`, (await btn.count()) > 0);
    await btn.click();
    await page.waitForTimeout(700);
    const box = await page.$("#modal textarea");
    check(`${id} 弹出审批意见框`, !!box);
    if (box) await page.fill("#modal textarea", comment);
    await page.click('#modal [data-x="1"]');
    await page.waitForTimeout(1800);
  };

  console.log("\n[2] 例外单审批：点通过");
  await approve("AP-2026-013", "同意补录议程");
  const t1 = await toasts();
  check("提示「例外单已通过」", t1.some((t) => /EX-2026-018[\s\S]{0,8}已通过/.test(t)), JSON.stringify(t1).slice(0, 160));
  check("没有「不存在」的报错", !t1.some((t) => /不存在/.test(t)), JSON.stringify(t1).slice(0, 160));
  check("这一行从待审批消失", (await page.locator('tr[data-row="AP-2026-013"]').count()) === 0);

  console.log("\n[3] 付款审批：点通过");
  await approve("AP-2026-012", "");
  const t2 = await toasts();
  check("提示「付款单已审批」", t2.some((t) => /PY-\d{4}-\d+[\s\S]{0,8}已审批/.test(t)), JSON.stringify(t2).slice(0, 160));
  check("没有「不存在」的报错", !t2.some((t) => /不存在/.test(t)), JSON.stringify(t2).slice(0, 160));
  check("这一行从待审批消失", (await page.locator('tr[data-row="AP-2026-012"]').count()) === 0);

  console.log("\n[4] 全部审批里两条都是「已通过」，且记了审批人");
  await page.click('[data-v="all"]');
  await page.waitForTimeout(1500);
  const all = (await page.textContent("#content")) || "";
  const row13 = (await page.textContent('tr[data-row="AP-2026-013"]')) || "";
  const row12 = (await page.textContent('tr[data-row="AP-2026-012"]')) || "";
  check("AP-2026-013 状态已通过", /已通过/.test(row13), row13.replace(/\s+/g, " ").slice(0, 100));
  check("AP-2026-012 状态已通过", /已通过/.test(row12), row12.replace(/\s+/g, " ").slice(0, 100));
  check("审批人已记录（不再是空）", /李静|王敏|陈静|张伟/.test(row13 + row12), (row13 + row12).replace(/\s+/g, " ").slice(0, 120));
  check("全部审批里不再有待审批的这两条", !/待审批[\s\S]{0,10}AP-2026-01[23]/.test(all));

  console.log("\n[5] 连带结果：例外单批了，第 4 步应解例外");
  await page.goto(`${BASE}/#/projects/MP-2026-003`, { waitUntil: "networkidle" });
  await page.waitForTimeout(1800);
  await page.click('[data-tab="verify"]');
  await page.waitForTimeout(1200);
  const vbody = (await page.textContent("#tabbody")) || "";
  check("第 4 步显示「已解例外」", /已解例外/.test(vbody), vbody.replace(/\s+/g, " ").slice(0, 160));

  await page.screenshot({ path: "/tmp/ui-v1215.png", fullPage: true });

  console.log("\n[6] 慢网络竞态：工作台晚回来，不能盖住已经切走的页面");
  // 线上真实场景：登录后工作台大盘要拉一堆数据，老板等不及点「审批中心」，
  // 审批中心已经渲染完，工作台那批慢请求才回来 —— 老代码会把 #content 整个写成工作台，
  // 于是「顶栏写着审批中心、内容是工作台」。这里把 /api/dashboard 拖 4 秒复现。
  await page.route("**/api/dashboard", async (route) => {
    await new Promise((r) => setTimeout(r, 4000));
    await route.continue();
  });
  await page.click('button[data-go="dashboard"]');
  await page.waitForTimeout(250);
  await page.click('button[data-go="approvals"]');
  await page.waitForTimeout(1500);
  check("切到审批中心后立即渲染出来", (await page.locator("#body").count()) > 0);
  // 等慢请求回来
  await page.waitForTimeout(4500);
  const afterSlow = (await page.textContent("#content")) || "";
  check("工作台慢请求回来后仍是审批中心", /审批中心/.test(afterSlow) && !/我的待办/.test(afterSlow),
    afterSlow.replace(/\s+/g, " ").slice(0, 120));
  check("顶栏与内容一致（都是审批中心）", /审批中心/.test((await page.textContent("#top")) || ""));
  check("审批列表还在（没被清空）", (await page.locator("#content tbody tr").count()) > 0);
  await page.unroute("**/api/dashboard");

  console.log("\n[7] 控制台");
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
