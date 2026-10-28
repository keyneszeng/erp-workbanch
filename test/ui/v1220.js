/**
 * V1.2.20 UI 定点验证：付款页签排在核销后面
 * 运行：node test/ui/v1220.js
 *
 * 老板 2026-10-28：「修正：付款 在 核销 后面」。
 *
 * 这条顺序和门禁是一回事：核销通过（已核销）是付款的唯一前置门。
 * 页签把付款排在核销前面，人会先点付款、被拦、再回头找核销。
 *
 * 验四件事：
 *   1. 页签顺序：材料 < 核销 < 付款（三段硬顺序）；
 *   2. 待核销项目：付款页签的申请按钮禁用（顺序与门禁一致）；
 *   3. 已核销项目：付款可用；
 *   4. 概览流程门禁里，材料 → 核销 → 付款 → 结算 的先后也一致。
 */
const { chromium } = require("playwright");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..", "..");
const PORT = Number(process.env.ERP_PORT || 8839);
const BASE = process.env.ERP_BASE || `http://127.0.0.1:${PORT}`;
const SELF_HOSTED = !process.env.ERP_BASE;
const DB = path.join(ROOT, "data", "ui-v1220.db");
const UP = path.join(ROOT, "data", "ui-v1220-uploads");

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

  const openProject = async (pid) => {
    await page.evaluate(() => {
      const m = document.getElementById("modal");
      if (m) { m.classList.remove("open"); m.innerHTML = ""; }
    });
    await page.goto(`${BASE}/#/projects/${pid}`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("[data-tab]", { timeout: 30000 });
    await page.waitForTimeout(1600);
  };

  console.log("\n[1] 登录 → 待核销项目（MP-2026-003）");
  await page.goto(BASE, { waitUntil: "networkidle" });
  await page.waitForTimeout(700);
  await page.fill('input[name="username"]', "admin");
  await page.fill('input[name="password"]', "123456");
  await page.click("#lbtn");
  await page.waitForSelector("#pwdBtn", { timeout: 30000 });
  await openProject("MP-2026-003");

  const tabs = await page.$$eval("[data-tab]", (els) => els.map((e) => e.dataset.tab));
  const iMat = tabs.indexOf("materials");
  const iVer = tabs.indexOf("verify");
  const iPay = tabs.indexOf("payments");
  check("三个页签都在", iMat >= 0 && iVer >= 0 && iPay >= 0, tabs.join(" > "));
  check("材料在核销之前", iMat < iVer, `材料@${iMat} 核销@${iVer}`);
  check("核销在付款之前", iVer < iPay, `核销@${iVer} 付款@${iPay}`);
  console.log(`      顺序：${tabs.join(" → ")}`);

  console.log("\n[2] 待核销：付款页签的申请按钮是禁用的");
  await page.click('[data-tab="payments"]');
  await page.waitForTimeout(1200);
  const payBody = (await page.textContent("#tabbody")) || "";
  check("付款页签给出核销门禁提示", /核销|门禁/.test(payBody), payBody.replace(/\s+/g, " ").slice(0, 120));
  const addBtn = page.locator("#addPay");
  if (await addBtn.count()) {
    check("付款申请按钮 disabled", await addBtn.isDisabled());
  } else {
    check("没有付款申请按钮（无 payment:create 权限时也不该有）", true);
  }

  console.log("\n[3] 概览流程门禁：材料 → 核销 → 付款 → 结算");
  await page.click('[data-tab="overview"]');
  await page.waitForTimeout(1200);
  const ov = (await page.textContent("#tabbody")) || "";
  const iMat2 = ov.indexOf("材料（核销前置）");
  const iVer2 = ov.indexOf("核销：");
  const iPay2 = ov.indexOf("付款：");
  const iSet2 = ov.indexOf("结算：");
  check("四行都在", iMat2 >= 0 && iVer2 >= 0 && iPay2 >= 0 && iSet2 >= 0,
    `材料@${iMat2} 核销@${iVer2} 付款@${iPay2} 结算@${iSet2}`);
  check("材料在核销前", iMat2 < iVer2);
  check("核销在付款前", iVer2 < iPay2);
  check("付款在结算前", iPay2 < iSet2);

  console.log("\n[4] 已核销项目（MP-2026-017）：付款页签可用");
  await openProject("MP-2026-017");
  await page.click('[data-tab="payments"]');
  await page.waitForTimeout(1200);
  const addBtn2 = page.locator("#addPay");
  check("已核销项目有付款申请入口", (await addBtn2.count()) === 1);
  if (await addBtn2.count()) check("且按钮可用", !(await addBtn2.isDisabled()));

  await page.screenshot({ path: "/tmp/ui-v1220.png", fullPage: true });

  console.log("\n[5] 控制台");
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
