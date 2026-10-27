/**
 * V1.2.13 UI 定点验证（真实 Chrome）
 * 运行：node test/ui/v1213.js
 *
 * 验老板报的三条在**页面上**真的修好了：
 *   1. MP-2026-012 第 5 步「劳务与专家费核对」不再列出「会场租赁及餐饮」，
 *      并明说「没有劳务专家类合同，另有 N 份其它类别」；
 *   2. 提交例外单的「对应步骤」能自定义，填的事项名会显示在例外单列表里；
 *   3. 登记材料的「材料类别」能自定义，自定义类别真的进得了卷宗。
 *
 * 脚本自带服务，不依赖外部进程（设 ERP_BASE 可指向已有服务）。
 */
const { chromium } = require("playwright");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..", "..");
const PORT = Number(process.env.ERP_PORT || 8830);
const BASE = process.env.ERP_BASE || `http://127.0.0.1:${PORT}`;
const SELF_HOSTED = !process.env.ERP_BASE;
const DB = path.join(ROOT, "data", "ui-v1213.db");
const UP = path.join(ROOT, "data", "ui-v1213-uploads");

const PID = "MP-2026-012";   // 执行中，只有一份「会场租赁及餐饮」合同 —— 就是老板报的那条
const EX_PID = "MP-2026-004"; // 待核销，例外单只能在这个阶段提
const EX_LABEL = "专家临时换人";
const MAT_KIND = "会议纪要";

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

async function openAs(browser, username) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  const errs = [];
  page.on("pageerror", (e) => errs.push(`[pageerror] ${e.message}`));
  page.on("console", (m) => {
    const t = m.text();
    if (m.type() === "error" && !/Failed to load resource/.test(t)) errs.push(t);
  });
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
  await page.goto(BASE, { waitUntil: "networkidle" });
  await page.waitForTimeout(700);
  for (let i = 0; i < 3; i++) {
    await page.fill('input[name="username"]', username);
    await page.fill('input[name="password"]', "123456");
    if ((await page.inputValue('input[name="username"]')) === username) break;
    await page.waitForTimeout(300);
  }
  await page.click("#lbtn");
  await page.waitForTimeout(2200);
  return { ctx, page, errs };
}

/** 打开项目详情并切到某个页签 */
async function openTab(page, pid, tab) {
  // 上一步的弹窗若还开着（提交失败时不会自动关），会挡住页签点击。
  // 这里先手动清掉，别让「上一个用例失败」变成「下一个用例超时」。
  await page.evaluate(() => {
    const m = document.getElementById("modal");
    if (m) { m.classList.remove("open"); m.innerHTML = ""; }
  });
  await page.goto(`${BASE}/#/projects/${pid}`, { waitUntil: "networkidle" });
  await page.waitForTimeout(1600);
  await page.click(`[data-tab="${tab}"]`);
  await page.waitForTimeout(900);
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
  const allErrs = [];
  const closeAll = [];
  const sess = async (u) => { const s = await openAs(browser, u); closeAll.push(s.ctx); allErrs.push(...s.errs); return s; };

  /* ========== 一、第 5 步不再混进场地合同 ========== */
  console.log("\n[1] MP-2026-012 第 5 步「劳务与专家费核对」");
  const exec1 = await sess("exec");
  await openTab(exec1.page, PID, "verify");
  check("核销页签有 6 步", (await exec1.page.locator(".vstep").count()) === 6);

  await exec1.page.click('[data-detail="5"]');
  await exec1.page.waitForTimeout(900);
  const d5 = (await exec1.page.textContent("#modal .mb")) || "";
  const d5Title = (await exec1.page.textContent("#modal .mh")) || "";
  check("第 5 步标题是「劳务与专家费核对」", /劳务与专家费核对/.test(d5Title), d5Title);
  check("不再列出「会场租赁及餐饮」", !/会场租赁及餐饮/.test(d5), d5.slice(0, 200));
  check("说明没有劳务专家类合同", /没有「劳务专家」类合同/.test(d5), d5.slice(0, 240));
  check("说明另有其它类别合同归第 6 步", /另有 1 份其它类别合同/.test(d5), d5.slice(0, 240));
  await exec1.page.click('#modal [data-x="0"]');
  await exec1.page.waitForTimeout(400);

  /* ========== 二、合同台账显示类别 ========== */
  console.log("\n[2] 合同页签的类别标签");
  await openTab(exec1.page, PID, "contracts");
  const catTxt = (await exec1.page.textContent("#tabbody .cat")) || "";
  check("合同名称后面有类别标签", catTxt.includes("场地餐饮"), catTxt);

  /* ========== 三、材料类别可自定义 ========== */
  console.log("\n[3] 登记材料：自定义类别");
  await openTab(exec1.page, PID, "materials");
  await exec1.page.click("#addMat");
  await exec1.page.waitForTimeout(700);
  const kindOpts = await exec1.page.$$eval('#modal [name="kind"] option', (os) => os.map((o) => o.value));
  check("类别下拉有「自定义填入」", kindOpts.includes("__custom__"), JSON.stringify(kindOpts));
  check("自定义文本框默认隐藏", !(await exec1.page.isVisible('#modal [name="kind__custom"]')));

  await exec1.page.selectOption('#modal [name="kind"]', "__custom__");
  await exec1.page.waitForTimeout(400);
  check("选中后文本框出现", await exec1.page.isVisible('#modal [name="kind__custom"]'));

  await exec1.page.fill('#modal [name="kind__custom"]', MAT_KIND);
  await exec1.page.fill('#modal [name="name"]', `${MAT_KIND}-UI验证.pdf`);
  await exec1.page.click('#modal [data-x="1"]');
  await exec1.page.waitForTimeout(2000);
  const t3 = await exec1.page.evaluate(() => window.__toasts || []);
  check("自定义类别登记成功", t3.some((t) => new RegExp(`${MAT_KIND} 已登记`).test(t)), JSON.stringify(t3).slice(0, 200));

  await openTab(exec1.page, PID, "materials");
  const matBody = (await exec1.page.textContent("#tabbody")) || "";
  check("材料列表出现自定义类别", matBody.includes(MAT_KIND), matBody.slice(0, 200));

  /* ========== 四、例外单步骤可自定义 ========== */
  console.log("\n[4] 提交例外单：自定义对应步骤");
  const admin = await sess("admin");
  await openTab(admin.page, EX_PID, "verify");
  check("有「提交例外单」按钮", !!(await admin.page.$("#addEx")));

  await admin.page.click("#addEx");
  await admin.page.waitForTimeout(700);
  const stepOpts = await admin.page.$$eval('#modal [name="step_no"] option', (os) => os.map((o) => o.value));
  check("步骤下拉有 6 步 + 自定义", stepOpts.length === 7 && stepOpts.includes("__custom__"), JSON.stringify(stepOpts));
  check("自定义事项文本框默认隐藏", !(await admin.page.isVisible('#modal [name="step_no__custom"]')));

  await admin.page.selectOption('#modal [name="step_no"]', "__custom__");
  await admin.page.waitForTimeout(400);
  check("选中后事项文本框出现", await admin.page.isVisible('#modal [name="step_no__custom"]'));

  // 不填事项直接提交：必须被拦，且不产生例外单
  await admin.page.fill('#modal [name="reason"]', "原定讲者临时替换为同科室副主任");
  await admin.page.click('#modal [data-x="1"]');
  await admin.page.waitForTimeout(900);
  const t4a = await admin.page.evaluate(() => window.__toasts || []);
  check("不填事项被拦下", t4a.some((t) => /请填写标红的必填项/.test(t)), JSON.stringify(t4a).slice(0, 200));
  check("弹窗没关，还在填", !!(await admin.page.$('#modal [name="step_no__custom"]')));

  await admin.page.fill('#modal [name="step_no__custom"]', EX_LABEL);
  await admin.page.click('#modal [data-x="1"]');
  await admin.page.waitForTimeout(2200);
  const t4 = await admin.page.evaluate(() => window.__toasts || []);
  check("自定义例外单提交成功", t4.some((t) => /例外单 EX-.* 已提交/.test(t)), JSON.stringify(t4).slice(0, 200));

  await openTab(admin.page, EX_PID, "verify");
  const exBody = (await admin.page.textContent("#tabbody")) || "";
  check("例外单列表显示事项名", exBody.includes(EX_LABEL), exBody.slice(0, 300));
  check("不显示「第 0 步」", !/第 0 步/.test(exBody));

  /* ========== 五、零 JS 报错 ========== */
  console.log("\n[5] 页面错误");
  check("无 JS 报错", allErrs.length === 0, allErrs.slice(0, 3).join(" | "));

  for (const c of closeAll) await c.close();
  await browser.close();
  if (proc) { proc.kill("SIGTERM"); proc = null; }

  console.log(`\n=== ${pass} 通过 / ${fail} 失败 ===`);
  process.exit(fail ? 1 : 0);
})().catch(async (e) => {
  console.error("脚本异常：", e);
  if (proc) proc.kill("SIGTERM");
  process.exit(1);
});
