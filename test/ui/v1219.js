/**
 * V1.2.19 UI 定点验证：材料排在核销前面 + 核销未开启时的提示
 * 运行：node test/ui/v1219.js
 *
 * 老板 2026-10-28：「必须完成 材料 8 项录入，才能开启 核销功能。
 *                   所以项目详情页里 材料 应该在 核销 前面。」
 *
 * 验的是「顺序」和「提示」这两件界面上的事：
 *   1. 页签顺序：材料在核销之前；
 *   2. 材料不齐时，核销页签给横幅、判定按钮不出现；
 *   3. 横幅上的「去登记材料 →」能切到材料页签；
 *   4. 概览的流程门禁里，材料那一行也在核销之前。
 */
const { chromium } = require("playwright");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..", "..");
const PORT = Number(process.env.ERP_PORT || 8838);
const BASE = process.env.ERP_BASE || `http://127.0.0.1:${PORT}`;
const SELF_HOSTED = !process.env.ERP_BASE;
const DB = path.join(ROOT, "data", "ui-v1219.db");
const UP = path.join(ROOT, "data", "ui-v1219-uploads");

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
let cookie = "";
async function apiLogin() {
  const r = await fetch(`${BASE}/api/auth/login`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "admin", password: "123456" })
  });
  if (r.status !== 200) throw new Error("登录失败");
  return r.headers.get("set-cookie").split(";")[0];
}
async function api(method, url, body) {
  const opt = { method, headers: { cookie } };
  if (body !== undefined) { opt.body = JSON.stringify(body); opt.headers["Content-Type"] = "application/json"; }
  const r = await fetch(BASE + url, opt);
  const t = await r.text();
  let d; try { d = JSON.parse(t); } catch { d = t; }
  return { status: r.status, data: d };
}

const PID = "MP-2026-003"; // 待核销，种子里材料 8/8

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
  cookie = await apiLogin();

  const browser = await chromium.launch({ channel: "chrome", headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errs = [];
  page.on("pageerror", (e) => errs.push(`[pageerror] ${e.message}`));
  page.on("console", (m) => {
    const t = m.text();
    if (m.type() === "error" && !/Failed to load resource/.test(t)) errs.push(t);
  });

  console.log("\n[1] 登录 → 项目详情");
  await page.goto(BASE, { waitUntil: "networkidle" });
  await page.waitForTimeout(700);
  await page.fill('input[name="username"]', "admin");
  await page.fill('input[name="password"]', "123456");
  await page.click("#lbtn");
  await page.waitForSelector("#pwdBtn", { timeout: 30000 });
  await page.goto(`${BASE}/#/projects/${PID}`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("[data-tab]", { timeout: 30000 });
  await page.waitForTimeout(1500);

  const tabs = await page.$$eval("[data-tab]", (els) => els.map((e) => e.dataset.tab));
  check("页签顺序：材料在核销前面",
    tabs.indexOf("materials") >= 0 && tabs.indexOf("verify") >= 0 && tabs.indexOf("materials") < tabs.indexOf("verify"),
    tabs.join(" > "));

  console.log("\n[2] 材料齐备时：核销页签正常");
  await page.click('[data-tab="verify"]');
  await page.waitForTimeout(1200);
  const okBody = (await page.textContent("#tabbody")) || "";
  check("没有「核销未开启」横幅", !/核销未开启/.test(okBody), okBody.replace(/\s+/g, " ").slice(0, 120));
  check("有判定按钮", (await page.locator("#tabbody [data-judge]").count()) > 0);

  console.log("\n[3] 删掉一类材料 → 核销未开启");
  const d = await api("GET", `/api/projects/${PID}`);
  const target = d.data.materials.find((m) => m.kind === "签到表");
  const del = await api("DELETE", `/api/materials/${target.id}`);
  check("删材料成功（模拟材料不全）", del.status === 200, JSON.stringify(del.data));

  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForSelector("[data-tab]", { timeout: 30000 });
  await page.waitForTimeout(1500);
  await page.click('[data-tab="verify"]');
  await page.waitForTimeout(1200);
  const badBody = (await page.textContent("#tabbody")) || "";
  check("核销页签给出「核销未开启」", /核销未开启/.test(badBody), badBody.replace(/\s+/g, " ").slice(0, 140));
  check("横幅里点出缺失的类别", /签到表/.test(badBody));
  check("判定按钮全部消失", (await page.locator("#tabbody [data-judge]").count()) === 0);

  console.log("\n[4] 横幅上的「去登记材料」能切到材料页签");
  await page.click('[data-goto-tab="materials"]');
  await page.waitForTimeout(1200);
  const matBody = (await page.textContent("#tabbody")) || "";
  check("切到了材料页签", /归档材料/.test(matBody), matBody.replace(/\s+/g, " ").slice(0, 120));
  check("材料页签标出「核销前置未满足」", /核销前置未满足/.test(matBody));

  // 补回来，页面恢复
  await api("POST", `/api/projects/${PID}/materials`, { kind: "签到表", name: "签到表-补.pdf" });
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForSelector("[data-tab]", { timeout: 30000 });
  await page.waitForTimeout(1500);
  await page.click('[data-tab="materials"]');
  await page.waitForTimeout(1200);
  const backBody = (await page.textContent("#tabbody")) || "";
  check("补齐后标出「已满足核销前置」", /已满足核销前置/.test(backBody), backBody.replace(/\s+/g, " ").slice(0, 120));

  console.log("\n[5] 概览：材料那一行排在核销之前");
  await page.click('[data-tab="overview"]');
  await page.waitForTimeout(1200);
  const ov = (await page.textContent("#tabbody")) || "";
  const iMat = ov.indexOf("材料（核销前置）");
  const iVer = ov.indexOf("核销：");
  check("概览里有「材料（核销前置）」一行", iMat >= 0, ov.replace(/\s+/g, " ").slice(0, 200));
  check("材料行在核销行之前", iMat >= 0 && iVer > iMat, `材料@${iMat} 核销@${iVer}`);

  await page.screenshot({ path: "/tmp/ui-v1219.png", fullPage: true });

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
