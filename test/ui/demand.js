/**
 * 会务需求 UI 验证（真实 Chrome）
 * 运行：node test/ui/demand.js
 *
 * 验的是这一版改的三件事：
 *   1. 确认即归档 —— 归档后整单只读、能撤销归档、核销第 3 步拿它当费用对照
 *   2. 新增一行 —— 能加模板里没有的条目，保存后还在
 *   3. 精简字段 —— 附件 / 执行状态两列已去掉，预算归属变成预算金额并能合计
 *
 * 脚本自带服务（设 ERP_BASE 可指向已有服务）。
 */
const { chromium } = require("playwright");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..", "..");
const PORT = Number(process.env.ERP_PORT || 8821);
const BASE = process.env.ERP_BASE || `http://127.0.0.1:${PORT}`;
const SELF_HOSTED = !process.env.ERP_BASE;

const DB = path.join(ROOT, "data", "ui-demand.db");
const UP = path.join(ROOT, "data", "ui-demand-uploads");

const PID = "MP-2026-001"; // 有种子需求单，用来验交互
const PID2 = "MP-2026-003"; // 待核销，用来验核销侧对照

let pass = 0, fail = 0;
const check = (name, ok, extra = "") => {
  if (ok) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}  ${extra}`); }
};

function clean() {
  for (const f of [DB, DB + "-wal", DB + "-shm"]) if (fs.existsSync(f)) fs.unlinkSync(f);
  if (fs.existsSync(UP)) fs.rmSync(UP, { recursive: true, force: true });
}

async function waitHealth(timeout = 20000) {
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
  const text = await r.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  return { status: r.status, data };
}

/** 给待核销的项目造一份已归档的需求单，用来验核销侧的费用对照 */
async function seedArchivedDemand() {
  const r1 = await api("PATCH", `/api/demand/${PID2}`, {
    items: [
      { grp: "设计", item: "串场", need: "需要", spec: "主视觉", owner: "王敏", budget: "5000" },
      { grp: "制作", item: "横幅", need: "需要", spec: "8m", owner: "李强", budget: "3000" },
      { grp: "其他", item: "代购酒水", need: "不需要", budget: "9999" }
    ]
  });
  if (r1.status !== 200) throw new Error("造需求单失败：" + JSON.stringify(r1.data));
  const r2 = await api("POST", `/api/demand/${PID2}/confirm`);
  if (r2.status !== 200) throw new Error("归档需求单失败：" + JSON.stringify(r2.data));
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
  const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } });
  const errs = [];
  page.on("pageerror", (e) => errs.push(`[pageerror] ${e.message}`));
  page.on("console", (m) => { if (m.type() === "error") errs.push(m.text()); });

  try {
    console.log("\n[1] 登录");
    await page.goto(BASE, { waitUntil: "networkidle" });
    await page.waitForTimeout(700);
    await page.fill('input[name="username"]', "admin");
    await page.fill('input[name="password"]', "123456");
    await page.click("#lbtn");
    await page.waitForTimeout(2200);
    check("登录后进入系统", !!(await page.$("#pwdBtn")), "");

    console.log("\n[2] 需求列表页：KPI 与列头");
    await page.goto(`${BASE}/#/demand`, { waitUntil: "networkidle" });
    await page.waitForTimeout(1500);
    const kpi = await page.$$eval(".kpi .t", (els) => els.map((e) => e.textContent.trim()));
    check("KPI 有「已归档」", kpi.includes("已归档"), JSON.stringify(kpi));
    check("KPI 有「需求预算合计」", kpi.includes("需求预算合计"), JSON.stringify(kpi));
    check("KPI 不再有「需要 / 已完成」", !kpi.some((x) => x.includes("已完成")), JSON.stringify(kpi));
    const listHeads = await page.$$eval(".panel th", (els) => els.map((e) => e.textContent.trim()));
    check("列表列头含「预算金额」", listHeads.includes("预算金额"), JSON.stringify(listHeads));
    check("列表列头含「归档」", listHeads.includes("归档"), JSON.stringify(listHeads));
    const archivedCell = await page.$$eval(".panel td", (els) => els.map((e) => e.textContent.trim()));
    check("MP-2026-003 显示「已归档」", archivedCell.some((x) => x === "已归档"), "");

    console.log("\n[3] 需求单：列头已精简");
    await page.goto(`${BASE}/#/demand/${PID}`, { waitUntil: "networkidle" });
    await page.waitForTimeout(1600);
    const heads = await page.$$eval("[data-panel] th", (els) => els.map((e) => e.textContent.trim()));
    check("有「预算金额」列", heads.includes("预算金额"), JSON.stringify(heads));
    check("没有「附件」列", !heads.includes("附件"), JSON.stringify(heads));
    check("没有「执行状态」列", !heads.includes("执行状态"), JSON.stringify(heads));
    check("没有「预算归属」列", !heads.includes("预算归属"), JSON.stringify(heads));
    const stat0 = await page.textContent("#dstat");
    check("页头显示预算合计", /预算合计\s*¥/.test(stat0), stat0);
    check("种子数据合计 90,900", /90,900/.test(stat0), stat0);

    console.log("\n[4] 新增一行：加一条模板里没有的");
    const rowSel = '[data-panel="其他"] tbody tr[data-grp]';
    const before = await page.$$eval(rowSel, (els) => els.length);
    await page.click('[data-add="其他"]');
    await page.waitForTimeout(300);
    const after = await page.$$eval(rowSel, (els) => els.length);
    check("点「新增一行」后多了一行", after === before + 1, `${before} → ${after}`);
    const rows = await page.$$(rowSel);
    const last = rows[rows.length - 1];
    check("新行条目名可编辑", !!(await last.$('[data-f="item"]')), "");
    await (await last.$('[data-f="item"]')).fill("临时加：指引牌");
    await (await last.$('[data-f="budget"]')).fill("260");
    await page.waitForTimeout(300);
    const stat1 = await page.textContent("#dstat");
    check("预算合计随输入实时更新", /91,160/.test(stat1), stat1);

    await page.click("#save");
    await page.waitForTimeout(1800);
    const names = await page.$$eval(`${rowSel} [data-f="item"]`, (els) => els.map((e) => e.value));
    check("保存后自定义条目还在", names.includes("临时加：指引牌"), JSON.stringify(names));
    const saved = await api("GET", `/api/demand/${PID}`);
    check("后端已存下自定义条目", saved.data.items["其他"].some((x) => x.item === "临时加：指引牌"), "");
    check("后端预算合计 91160", Number(saved.data.budgetTotal) === 91160, String(saved.data.budgetTotal));

    console.log("\n[5] 确认并归档：整单锁定");
    await page.click("#confirm");
    await page.waitForTimeout(600);
    const boxText = await page.textContent("#modal .mb").catch(() => "");
    check("归档前有二次确认", /归档后需求单将锁定/.test(boxText), boxText.slice(0, 60));
    await page.click('#modal [data-x="1"]');
    await page.waitForTimeout(2000);
    check("出现归档横幅", !!(await page.$(".banner.ok")), "");
    const banner = await page.textContent(".banner.ok");
    // 归档人是账号姓名（admin 的姓名是「李静」），不写死具体名字，只验「有人 + 有时间」
    check("横幅写明归档人与时间", /已封存/.test(banner) && /\S+\s*于\s*20\d\d-\d\d-\d\d/.test(banner), banner.slice(0, 90));
    const disabled = await page.$$eval('[data-f="item"]', (els) => els.filter((e) => e.disabled).length);
    const allInputs = await page.$$eval('[data-f="item"]', (els) => els.length);
    check("全部条目已只读", disabled === allInputs && allInputs > 0, `${disabled}/${allInputs}`);
    check("「保存」按钮已消失", !(await page.$("#save")), "");
    check("「新增一行」已消失", (await page.$$("[data-add]")).length === 0, "");
    check("出现「撤销归档」", !!(await page.$("#unarchive")), "");
    const del = await page.$$("[data-del]");
    check("归档后不能删行", del.length === 0, String(del.length));

    console.log("\n[6] 归档后接口也拒绝保存");
    const rej = await api("PATCH", `/api/demand/${PID}`, { items: [{ grp: "设计", item: "串场", need: "需要" }] });
    check("PATCH 返回 409", rej.status === 409, String(rej.status));
    check("错误码 DEMAND_ARCHIVED", rej.data?.error?.code === "DEMAND_ARCHIVED", JSON.stringify(rej.data?.error));

    console.log("\n[7] 核销第 3 步：拿归档需求单当费用对照");
    await page.goto(`${BASE}/#/verify/${PID2}`, { waitUntil: "networkidle" });
    await page.waitForTimeout(1800);
    const d3 = await page.$('[data-detail="3"]');
    check("第 3 步有详情按钮", !!d3, "");
    await d3.click();
    await page.waitForTimeout(700);
    const body = await page.textContent("#modal .mb");
    check("出现「会务需求预算对照」", /会务需求预算对照/.test(body), "");
    check("显示归档预算合计", /需求单预算合计（归档）/.test(body), "");
    check("显示已申请费用与其中已付款", /已申请费用（不含已驳回）/.test(body) && /其中已付款/.test(body), "");
    check("显示归档人与时间", /确认归档/.test(body), "");
    check("列出需要的条目", /串场/.test(body) && /横幅/.test(body), "");
    check("标了不需要的条目不在核对清单", !/9999/.test(body), "");
    check("核对要点提到归档预算", /归档预算/.test(body), "");
    await page.click('#modal [data-x="0"]');
    await page.waitForTimeout(300);

    console.log("\n[7b] 项目详情页的核销页签：同一个第 3 步，同样的对照");
    await page.goto(`${BASE}/#/projects/${PID2}`, { waitUntil: "networkidle" });
    await page.waitForTimeout(1600);
    const vtab = await page.$('button[data-tab="verify"]');
    check("项目详情页有核销页签", !!vtab, "");
    if (vtab) {
      await vtab.click();
      await page.waitForTimeout(900);
      const d3b = await page.$('[data-detail="3"]');
      check("页签里的第 3 步有详情", !!d3b, "");
      if (d3b) {
        await d3b.click();
        await page.waitForTimeout(700);
        const body2 = await page.textContent("#modal .mb");
        check("页签里也有「会务需求预算对照」", /会务需求预算对照/.test(body2), "");
        check("页签里也显示归档预算", /需求单预算合计（归档）/.test(body2), "");
        check("口径已拆开：申请费用 + 其中已付款",
          /已申请费用（不含已驳回）/.test(body2) && /其中已付款/.test(body2), "");
        check("不再出现误导性的「已发生费用」", !/已发生费用/.test(body2), "");
        await page.click('#modal [data-x="0"]');
        await page.waitForTimeout(300);
      }
    }

    console.log("\n[8] 撤销归档：回到可编辑");
    await page.goto(`${BASE}/#/demand/${PID}`, { waitUntil: "networkidle" });
    await page.waitForTimeout(1600);
    await page.click("#unarchive");
    await page.waitForTimeout(500);
    await page.click('#modal [data-x="1"]');
    await page.waitForTimeout(1800);
    check("归档横幅消失", !(await page.$(".banner.ok")), "");
    check("「保存」按钮回来了", !!(await page.$("#save")), "");
    check("「新增一行」回来了", (await page.$$("[data-add]")).length > 0, "");
    const stillThere = await page.$$eval(`${rowSel} [data-f="item"]`, (els) => els.map((e) => e.value));
    check("撤销归档不丢数据", stillThere.includes("临时加：指引牌"), JSON.stringify(stillThere));

    console.log("\n[9] 全程无 JS 报错");
    check("无 JS 报错", errs.length === 0, errs.slice(0, 3).join(" | "));

    await page.screenshot({ path: "/tmp/demand-sheet.png", fullPage: true });
  } finally {
    await browser.close();
    if (proc) proc.kill("SIGTERM");
  }

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
})();
