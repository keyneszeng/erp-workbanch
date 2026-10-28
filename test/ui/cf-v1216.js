/**
 * V1.2.16 线上验证：会务需求只列筹备 / 执行中，归档记录在项目详情页（**只读**）
 * 运行：node test/ui/cf-v1216.js
 *
 * 老板 2026-10-28 的修正：不是筹备 / 执行阶段的项目不该出现在会务需求列表里，
 * 归档后的需求单要到项目详情页看。这里只读，不改任何数据。
 */
const { chromium } = require("playwright");

const BASE = process.env.ERP_BASE || "https://erp.aibuild.work";

let pass = 0, fail = 0;
const check = (name, ok, extra = "") => {
  if (ok) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}  ${extra}`); }
};

async function openTab(page, pid, tab) {
  await page.evaluate(() => {
    const m = document.getElementById("modal");
    if (m) { m.classList.remove("open"); m.innerHTML = ""; }
  });
  await page.goto(`${BASE}/#/projects/${pid}`, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForSelector(`[data-tab="${tab}"]`, { timeout: 30000 });
  await page.click(`[data-tab="${tab}"]`);
  await page.waitForTimeout(1500);
  return (await page.textContent("#tabbody")) || "";
}

(async () => {
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errs = [];
  page.on("pageerror", (e) => errs.push(`[pageerror] ${e.message}`));
  page.on("console", (m) => {
    const t = m.text();
    if (m.type() === "error" && !/Failed to load resource/.test(t)) errs.push(t);
  });

  console.log("\n[1] 登录 → 会务需求列表");
  await page.goto(BASE, { waitUntil: "networkidle", timeout: 60000 });
  await page.waitForTimeout(1200);
  await page.fill('input[name="username"]', "admin");
  await page.fill('input[name="password"]', "123456");
  await page.click("#lbtn");
  await page.waitForSelector("#pwdBtn", { timeout: 40000 });
  await page.click('button[data-go="demand"]');
  await page.waitForSelector(".panel .panel-h", { timeout: 30000 });
  await page.waitForTimeout(1200);

  const kpi = await page.$$eval(".kpi .t", (els) => els.map((e) => e.textContent.trim()));
  check("KPI 是「筹备 / 执行中」", kpi.includes("筹备 / 执行中"), JSON.stringify(kpi));

  const rows = await page.$$eval(".panel tbody tr", (rs) =>
    rs.map((r) => r.textContent.replace(/\s+/g, " ").trim()));
  check("列表每行都是筹备中 / 执行中", rows.length > 0 && rows.every((t) => /筹备中|执行中/.test(t)),
    JSON.stringify(rows.slice(0, 3)));
  check("待核销 / 已核销项目（京津冀论坛）不在列表", !rows.some((t) => /京津冀论坛/.test(t)));
  check("已归档项目（肿瘤精准治疗会）不在列表", !rows.some((t) => /肿瘤精准治疗会/.test(t)));
  check("待审批项目（全科医学大会）不在列表", !rows.some((t) => /全科医学大会/.test(t)));
  console.log(`      列表项目：${rows.map((t) => t.split(" ")[0]).join("、") || "无"}`);

  console.log("\n[2] 项目详情 → 会务需求（已过阶段的项目也能查到记录）");
  const d3 = await openTab(page, "MP-2026-003", "demand");
  const hasSheet = /会务需求清单/.test(d3);
  check("页签能打开且不报错", d3.trim().length > 0, d3.replace(/\s+/g, " ").slice(0, 100));
  if (hasSheet) {
    check("给出归档状态（已归档 / 草稿）", /确认并归档|草稿，尚未归档/.test(d3),
      d3.replace(/\s+/g, " ").slice(0, 120));
    check("列出需要项与预算合计", /需要 \d+ 项/.test(d3) && /¥/.test(d3));
  } else {
    check("无单时说明阶段或未建单", /还没有会务需求单/.test(d3), d3.replace(/\s+/g, " ").slice(0, 120));
  }
  check("已过阶段的项目不给「去填写」", !/去填写/.test(d3), d3.replace(/\s+/g, " ").slice(0, 120));

  console.log("\n[3] 筹备中项目：页签有内容，能给填写入口");
  const d1 = await openTab(page, "MP-2026-001", "demand");
  check("MP-2026-001 会务需求页签有内容", d1.trim().length > 0);
  check("种子里有需求单（清单或草稿）", /会务需求清单|还没有会务需求单/.test(d1),
    d1.replace(/\s+/g, " ").slice(0, 120));

  console.log("\n[4] 概览页的流程门禁带上会务需求");
  const ov = await openTab(page, "MP-2026-003", "overview");
  check("门禁里有「会务需求：」一行", /会务需求：/.test(ov), ov.replace(/\s+/g, " ").slice(0, 160));

  await page.screenshot({ path: "/tmp/cf-v1216.png", fullPage: true });

  console.log("\n[5] 页面错误");
  check("无 JS 报错", errs.length === 0, errs.slice(0, 3).join(" | "));

  await browser.close();
  console.log(`\n=== ${pass} 通过 / ${fail} 失败 ===`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error("脚本异常：", e);
  process.exit(1);
});
