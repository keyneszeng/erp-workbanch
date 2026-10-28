/**
 * V1.2.16 UI 定点验证：会务需求只在筹备 / 执行阶段，确认后归档到项目详情页
 * 运行：node test/ui/v1216.js
 *
 * 老板 2026-10-28 的修正：
 *   「会务需求 的逻辑应该是 会议项目在 筹备 和 执行 的阶段的需求，
 *     相关负责人填写后 确认 就归档到 项目详情页；
 *     所以不是 筹备期 和 执行期 的项目 不应该出现在 会务需求 会议项目 列表页面。」
 *
 * 脚本自带服务（设 ERP_BASE 可指向已有服务）。
 */
const { chromium } = require("playwright");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..", "..");
const PORT = Number(process.env.ERP_PORT || 8836);
const BASE = process.env.ERP_BASE || `http://127.0.0.1:${PORT}`;
const SELF_HOSTED = !process.env.ERP_BASE;
const DB = path.join(ROOT, "data", "ui-v1216.db");
const UP = path.join(ROOT, "data", "ui-v1216-uploads");

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

/** MP-2026-003 是「待核销」：给它造一份已归档需求单，验归档记录在项目详情页 */
async function seedArchivedDemand() {
  const p = await api("PATCH", "/api/demand/MP-2026-003", {
    items: [
      { grp: "设计", item: "串场", need: "需要", spec: "主视觉 16:9", owner: "王敏", budget: "5000" },
      { grp: "制作", item: "横幅", need: "需要", spec: "8m", owner: "李强", budget: "3000" },
      { grp: "其他", item: "代购酒水", need: "不需要", budget: "9999" }
    ]
  });
  if (p.status !== 200) throw new Error("造需求单失败：" + JSON.stringify(p.data));
  const c = await api("POST", "/api/demand/MP-2026-003/confirm");
  if (c.status !== 200) throw new Error("归档失败：" + JSON.stringify(c.data));
}

async function openTab(page, pid, tab) {
  await page.evaluate(() => {
    const m = document.getElementById("modal");
    if (m) { m.classList.remove("open"); m.innerHTML = ""; }
  });
  await page.goto(`${BASE}/#/projects/${pid}`, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForTimeout(1800);
  await page.click(`[data-tab="${tab}"]`);
  await page.waitForTimeout(1200);
  return (await page.textContent("#tabbody")) || "";
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
  cookie = await apiLogin();
  await seedArchivedDemand();

  const browser = await chromium.launch({ channel: "chrome", headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errs = [];
  page.on("pageerror", (e) => errs.push(`[pageerror] ${e.message}`));
  page.on("console", (m) => {
    const t = m.text();
    if (m.type() === "error" && !/Failed to load resource/.test(t)) errs.push(t);
  });

  console.log("\n[1] 登录 → 会务需求列表");
  await page.goto(BASE, { waitUntil: "networkidle" });
  await page.waitForTimeout(700);
  await page.fill('input[name="username"]', "admin");
  await page.fill('input[name="password"]', "123456");
  await page.click("#lbtn");
  await page.waitForSelector("#pwdBtn", { timeout: 30000 });
  await page.click('button[data-go="demand"]');
  await page.waitForSelector("#body .panel-h, .panel .panel-h", { timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(1500);

  const kpi = await page.$$eval(".kpi .t", (els) => els.map((e) => e.textContent.trim()));
  check("KPI 改成「筹备 / 执行中」", kpi.includes("筹备 / 执行中"), JSON.stringify(kpi));

  const rows = await page.$$eval(".panel tbody tr", (rs) =>
    rs.map((r) => r.textContent.replace(/\s+/g, " ").trim()));
  check("列表非空", rows.length > 0, `行数 ${rows.length}`);
  check("每行状态都是筹备中 / 执行中",
    rows.every((t) => /筹备中|执行中/.test(t)), JSON.stringify(rows.slice(0, 3)));
  check("待核销项目（京津冀论坛）不在列表", !rows.some((t) => /京津冀论坛/.test(t)));
  check("已归档项目（肿瘤精准治疗会）不在列表", !rows.some((t) => /肿瘤精准治疗会/.test(t)));
  check("待审批项目（全科医学大会）不在列表", !rows.some((t) => /全科医学大会/.test(t)));
  check("表头说明写了只列筹备 / 执行中",
    /只列「筹备中 \/ 执行中」的项目/.test((await page.textContent(".panel .panel-h")) || ""));

  console.log("\n[2] 待核销项目：归档记录在项目详情页的「会务需求」");
  const d3 = await openTab(page, "MP-2026-003", "demand");
  check("页签标题是「会务需求清单」", /会务需求清单/.test(d3), d3.replace(/\s+/g, " ").slice(0, 90));
  check("标明已归档及归档人", /已由[\s\S]{0,40}确认并归档/.test(d3), d3.replace(/\s+/g, " ").slice(0, 120));
  check("列出需要项与预算合计", /需要 2 项/.test(d3) && /¥8,000/.test(d3), d3.replace(/\s+/g, " ").slice(0, 140));
  check("逐条列到具体条目（串场 / 横幅）", /串场/.test(d3) && /横幅/.test(d3));
  check("不需要的条目不进清单", !/代购酒水/.test(d3), d3.replace(/\s+/g, " ").slice(0, 140));
  check("不在阶段内不给「去填写」", !/去填写/.test(d3));

  console.log("\n[3] 筹备中项目：草稿状态 + 能去填写");
  const d1 = await openTab(page, "MP-2026-001", "demand");
  check("标明「草稿，尚未归档」", /草稿，尚未归档/.test(d1), d1.replace(/\s+/g, " ").slice(0, 120));
  check("给了「去填写」入口", /去填写/.test(d1));

  console.log("\n[4] 已立项项目：还没到筹备，提示阶段而不是硬给入口");
  const d9 = await openTab(page, "MP-2026-009", "demand");
  check("提示在筹备 / 执行阶段填写", /筹备中 \/ 执行中」阶段填写/.test(d9), d9.replace(/\s+/g, " ").slice(0, 140));
  check("没有「去填写」按钮", !/去填写/.test(d9));

  console.log("\n[5] 概览页的门禁摘要带上会务需求");
  const ov = await openTab(page, "MP-2026-003", "overview");
  check("流程门禁里有「会务需求」一行", /会务需求：已归档/.test(ov), ov.replace(/\s+/g, " ").slice(0, 200));

  await page.screenshot({ path: "/tmp/ui-v1216.png", fullPage: true });

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
