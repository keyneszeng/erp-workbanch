/**
 * 核销 6 步「详情」面板 UI 验证（真实 Chrome）
 * 运行：node test/ui/verify-detail.js
 *
 * 验的是：判定人在点「通过 / 不通过」之前，能不能当场看到这一步要核的原始数据。
 * 没有这块，核销就是凭印象盖章。
 *
 * 覆盖：
 *   1. 核销看板 6 个步骤各有「详情」按钮
 *   2. 逐个打开，标题正确、关键数据出现（议程环节 / 报名门槛 / 费用构成 / 课件清单 /
 *      合同清单 / 三方金额）
 *   3. 材料原件链接指向 /api/uploads/<key> 且真能取到文件
 *   4. 详情弹窗底部可直接进「判定」，不必关掉再回列表找按钮
 *   5. 必须按顺序判定时（前面还有未判定的步骤），详情里不给判定入口
 *   6. 项目详情页的核销页签也有同样的「详情」
 *   7. 第 3 步把「归档预算 / 已申请费用 / 其中已付款 / 超支或结余」摆在一起
 *   8. 第 2 步报名人数为 0 时显示「无法核算」，不给「≥ 0」这种永远成立的门槛
 *   9. 全程无 JS 报错
 *
 * 脚本自带服务（设 ERP_BASE 可指向已有服务）。
 */
const { chromium } = require("playwright");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..", "..");
const PORT = Number(process.env.ERP_PORT || 8816);
const BASE = process.env.ERP_BASE || `http://127.0.0.1:${PORT}`;
const SELF_HOSTED = !process.env.ERP_BASE;

const TMP = "/tmp/erp-verify-detail";
const PDF_FILE = path.join(TMP, "议程.pdf");
const IMG_FILE = path.join(TMP, "签到表现场.jpg");
const DB = path.join(ROOT, "data", "ui-vdetail.db");
const UP = path.join(ROOT, "data", "ui-vdetail-uploads");

/** 用 MP-2026-003：待核销、有 2 份合同、1 笔待审批付款、报名 260 人 */
const PID = "MP-2026-003";

let pass = 0, fail = 0;
const check = (name, ok, extra = "") => {
  if (ok) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}  ${extra}`); }
};

function makeFixtures() {
  fs.mkdirSync(TMP, { recursive: true });
  fs.writeFileSync(PDF_FILE, Buffer.from(
    "%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n", "utf8"));
  fs.writeFileSync(IMG_FILE, Buffer.from(
    "/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==",
    "base64"));
}

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

async function api(method, url, body, raw) {
  const opt = { method, headers: { cookie } };
  if (body !== undefined) {
    if (Buffer.isBuffer(body)) { opt.body = body; opt.headers["Content-Type"] = "application/pdf"; }
    else { opt.body = JSON.stringify(body); opt.headers["Content-Type"] = "application/json"; }
  }
  const r = await fetch(BASE + url, opt);
  const text = await r.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  return { status: r.status, data };
}

/** 造一套核销要核对的数据：8 类材料（其中 6 类带原件）+ 1 笔付款 */
async function seedVerifyData() {
  /**
   * V1.2.19：种子里 MP-2026-003 已经备齐 8 类材料（核销前置门要求）。
   * 本用例要精确断言「议程材料（1 份）」，所以先把种子那套清掉，再用自己的数据重建 ——
   * 不清的话同名类别会叠成 2 份，断言就飘了。
   */
  const d0 = await api("GET", `/api/projects/${PID}`);
  for (const m of d0.data.materials || []) {
    const del = await api("DELETE", `/api/materials/${m.id}`);
    if (del.status !== 200) throw new Error(`清理种子材料失败：${JSON.stringify(del.data)}`);
  }

  const pdf = fs.readFileSync(PDF_FILE);
  const jpg = fs.readFileSync(IMG_FILE);
  const upPdf = await api("POST", "/api/uploads", pdf);
  const upJpg = await api("POST", "/api/uploads", jpg);
  if (!upPdf.data?.key) throw new Error("PDF 上传失败：" + JSON.stringify(upPdf.data));
  if (!upJpg.data?.key) throw new Error("JPEG 上传失败：" + JSON.stringify(upJpg.data));

  for (const k of ["议程", "课件", "签到表", "劳务表", "发票"]) {
    const r = await api("POST", `/api/projects/${PID}/materials`, {
      kind: k, name: `${k}（回归）`, file_key: upPdf.data.key
    });
    if (r.status !== 200) throw new Error(`登记材料「${k}」失败：${JSON.stringify(r.data)}`);
  }
  const r2 = await api("POST", `/api/projects/${PID}/materials`, {
    kind: "现场照片", name: "开幕式现场.jpg", file_key: upJpg.data.key
  });
  if (r2.status !== 200) throw new Error("登记现场照片失败");

  // 补齐剩下两类：核销前置要求 8 类齐备，缺一类就判不了
  for (const k of ["立项文件", "合同"]) {
    const r = await api("POST", `/api/projects/${PID}/materials`, { kind: k, name: `${k}（回归）` });
    if (r.status !== 200) throw new Error(`登记材料「${k}」失败：${JSON.stringify(r.data)}`);
  }

  return { pdfKey: upPdf.data.key, jpgKey: upJpg.data.key };
}

/**
 * 给 MP-2026-003 建一张需求单并确认归档。
 * 第 3 步的「预算对照」只有归档后才给基准，不建单就永远测不到那一段。
 * 预算 10 万；该项目已申请 8.4 万（待审批，算「已申请」不算「已付」）→ 结余 1.6 万。
 */
async function seedDemand() {
  const items = [
    { grp: "设计", item: "主视觉与串场", need: "需要", spec: "16:9 含 5 个环节页", owner: "张伟", due: "2026-08-20", budget: "40000" },
    { grp: "制作", item: "物料制作", need: "需要", spec: "台卡 40 个 / 横幅 1 条", owner: "李强", due: "2026-08-28", budget: "60000" },
    { grp: "其他", item: "茶歇", need: "不需要", spec: "", owner: "", due: "", budget: "" }
  ];
  const r = await api("PATCH", `/api/demand/${PID}`, { items });
  if (r.status !== 200) throw new Error("建需求单失败：" + JSON.stringify(r.data));
  const c = await api("POST", `/api/demand/${PID}/confirm`);
  if (c.status !== 200) throw new Error("归档需求单失败：" + JSON.stringify(c.data));
}

const modalTitle = (page) => page.textContent("#modal .mh h3").catch(() => "");
const modalBody = (page) => page.textContent("#modal .mb").catch(() => "");
const openDetail = async (page, no) => {
  const b = await page.$(`[data-detail="${no}"]`);
  if (!b) return false;
  await b.click();
  await page.waitForTimeout(500);
  return true;
};
const closeModal = async (page) => {
  const btn = await page.$('#modal [data-x="0"]');
  if (btn) await btn.click();
  await page.waitForTimeout(200);
};

(async () => {
  makeFixtures();
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
  const keys = await seedVerifyData();
  await seedDemand();

  const browser = await chromium.launch({ channel: "chrome", headless: true });
  const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } });
  const errs = [];
  page.on("pageerror", (e) => errs.push(`[pageerror] ${e.message}`));
  page.on("console", (m) => { if (m.type() === "error") errs.push(m.text()); });

  try {
    /* ---------- 登录 ---------- */
    console.log("\n[1] 登录");
    await page.goto(BASE, { waitUntil: "networkidle" });
    await page.waitForTimeout(700);
    await page.fill('input[name="username"]', "admin");
    await page.fill('input[name="password"]', "123456");
    await page.click("#lbtn");
    await page.waitForTimeout(2200);
    check("登录后进入系统", !!(await page.$("#pwdBtn")), "");

    /* ---------- 核销看板 ---------- */
    console.log("\n[2] 核销看板：6 个步骤都有「详情」");
    await page.goto(`${BASE}/#/verify/${PID}`, { waitUntil: "networkidle" });
    await page.waitForTimeout(1800);
    const detailBtns = await page.$$("[data-detail]");
    check("详情按钮 6 个", detailBtns.length === 6, `实际 ${detailBtns.length}`);
    const stepNames = await page.$$eval(".vstep .nm", (els) => els.map((e) => e.textContent.trim()));
    check("6 个步骤名齐全", stepNames.length === 6, JSON.stringify(stepNames));

    /* ---------- 逐步打开 ---------- */
    console.log("\n[3] 第 1 步：议程与课件核对");
    await openDetail(page, 1);
    check("弹窗标题正确", /第 1 步 · 议程与课件核对/.test(await modalTitle(page)));
    let body = await modalBody(page);
    check("列出登记的议程环节", /登记的议程环节/.test(body) && /09:00 开幕致辞/.test(body));
    check("列出议程材料", /议程材料（1 份）/.test(body));
    check("列出课件材料", /课件材料（1 份）/.test(body));
    check("有核对要点说明", /实际执行的议程环节/.test(body));

    console.log("\n[4] 第 2 步：签到人数与报名核对");
    await closeModal(page);
    await openDetail(page, 2);
    check("弹窗标题正确", /第 2 步 · 签到人数与报名核对/.test(await modalTitle(page)));
    body = await modalBody(page);
    check("显示报名人数 260", /报名人数（项目资料）/.test(body) && /260/.test(body));
    check("显示 85% 门槛 221", /达标门槛/.test(body) && /221/.test(body));
    check("列出签到表材料", /签到表材料/.test(body));

    console.log("\n[5] 第 3 步：现场费用凭证");
    await closeModal(page);
    await openDetail(page, 3);
    check("弹窗标题正确", /第 3 步 · 现场费用凭证/.test(await modalTitle(page)));
    body = await modalBody(page);
    check("显示费用构成", /费用构成/.test(body));
    check("列出票据材料", /发票 \/ 票据材料/.test(body));
    check("列出现场照片", /现场照片（1 份）/.test(body));

    /* 归档需求单 ↔ 实际费用的对照：判定人要看得出钱花超没超 */
    check("有「会务需求预算对照」段", /会务需求预算对照/.test(body));
    check("显示归档预算合计 ¥100,000", /需求单预算合计（归档）/.test(body) && /¥100,000/.test(body));
    check("显示已申请费用 ¥84,000", /已申请费用（不含已驳回）/.test(body) && /¥84,000/.test(body));
    check("显示其中已付款 ¥0", /其中已付款/.test(body));
    check("结余 ¥16,000 且不标超支", /结余/.test(body) && /¥16,000/.test(body) && !/超支/.test(body));
    // 「已发生」会把待审批的付款也算进去，让人以为钱都付了 —— 口径必须拆开
    check("不再用「已发生」这个误导口径", !/已发生/.test(body));
    check("列出归档预算明细条目", /主视觉与串场/.test(body) && /物料制作/.test(body));
    check("标注归档人与时间", /由\s*\S+\s*于\s*20\d\d-\d\d-\d\d/.test(body));

    console.log("\n[6] 第 4 步：课件与议程课题一致性");
    await closeModal(page);
    await openDetail(page, 4);
    check("弹窗标题正确", /第 4 步 · 课件与议程课题一致性/.test(await modalTitle(page)));
    body = await modalBody(page);
    check("列出议程环节与课件清单", /议程环节/.test(body) && /课件清单/.test(body));

    console.log("\n[7] 第 5 步：劳务与专家费核对");
    await closeModal(page);
    await openDetail(page, 5);
    check("弹窗标题正确", /第 5 步 · 劳务与专家费核对/.test(await modalTitle(page)));
    body = await modalBody(page);
    check("列出劳务表材料", /劳务表材料/.test(body));
    // V1.2.13：第 5 步只列「劳务专家」类合同。
    // MP-2026-003 有两份合同：HT-2026-004 会场租赁（场地餐饮）、HT-2026-005 专家劳务协议。
    // 以前两份都列，场地租赁会混进劳务核对里；现在只该出现后者。
    check("只列劳务专家类合同（1 份 ¥36,000）",
      /劳务 \/ 专家类合同（1 份）/.test(body) && /¥36,000/.test(body), body.slice(0, 260));
    check("场地租赁合同不混进第 5 步", !/会场租赁/.test(body));
    check("列出个人报销类付款", /个人报销类付款/.test(body));

    console.log("\n[8] 第 6 步：发票与合同金额核对");
    await closeModal(page);
    await openDetail(page, 6);
    check("弹窗标题正确", /第 6 步 · 发票与合同金额核对/.test(await modalTitle(page)));
    body = await modalBody(page);
    check("显示合同总额 ¥164,000", /合同总额/.test(body) && /¥164,000/.test(body));
    check("显示已付款合计", /已付款合计/.test(body));
    check("显示差额并标注不一致", /差额（合同 − 已付）/.test(body));

    /* ---------- 原件链接 ---------- */
    console.log("\n[9] 材料原件链接可打开");
    await closeModal(page);
    await openDetail(page, 1);
    const href = await page.getAttribute(`#modal a[href^="/api/uploads/"]`, "href");
    check("详情里有原件链接", !!href && href.includes(keys.pdfKey), href || "无");
    if (href) {
      const r = await page.evaluate(async (u) => {
        const x = await fetch(u);
        return { status: x.status, type: x.headers.get("content-type"), size: (await x.arrayBuffer()).byteLength };
      }, href);
      check("原件 HTTP 200", r.status === 200, JSON.stringify(r));
      check("原件是 PDF", /application\/pdf/.test(r.type || ""), r.type);
      check("原件内容非空", r.size > 10, `${r.size} 字节`);
    }

    /* ---------- 详情 → 判定 ---------- */
    console.log("\n[10] 详情弹窗可直接进入判定");
    const judgeInModal = await page.$('#modal [data-x="1"]');
    check("详情底部有判定入口", !!judgeInModal);
    if (judgeInModal) {
      await judgeInModal.click();
      await page.waitForTimeout(500);
      check("切到判定弹窗", /判定结果/.test(await modalBody(page)));
      await closeModal(page);
    }

    /* ---------- 顺序限制 ---------- */
    console.log("\n[11] 前面步骤未判定时，详情里不给判定入口");
    // 第 6 步前面还有未判定的步骤（种子数据里第 5、6 步待判定）
    await openDetail(page, 6);
    const j6 = await page.$('#modal [data-x="1"]');
    check("第 6 步详情无判定入口", !j6);
    await closeModal(page);

    /* ---------- 项目详情页 ---------- */
    console.log("\n[12] 项目详情页的核销页签同样有详情");
    await page.goto(`${BASE}/#/projects/${PID}`, { waitUntil: "networkidle" });
    await page.waitForTimeout(1600);
    const tab = await page.$('[data-tab="verify"]');
    check("找到核销页签", !!tab);
    if (tab) {
      await tab.click();
      await page.waitForTimeout(800);
      const n = (await page.$$("[data-detail]")).length;
      check("核销页签有 6 个详情按钮", n === 6, `实际 ${n}`);
      await openDetail(page, 1);
      check("项目页详情弹窗标题正确", /第 1 步 · 议程与课件核对/.test(await modalTitle(page)));
      await closeModal(page);
    }

    /* ---------- 报名 0 人 ---------- */
    console.log("\n[14] 第 2 步：报名人数为 0 时不给假门槛");
    // MP-2026-005 报名人数是 0。ceil(0×85%)=0，「实际签到 ≥ 0」永远成立 ——
    // 这一步就退化成点一下通过。必须显示「无法核算」而不是给个 0。
    await page.goto(`${BASE}/#/projects/MP-2026-005`, { waitUntil: "networkidle" });
    await page.waitForTimeout(1600);
    const tab0 = await page.$('[data-tab="verify"]');
    check("MP-2026-005 有核销页签", !!tab0);
    if (tab0) {
      await tab0.click();
      await page.waitForTimeout(800);
      const d0 = await page.$('[data-detail="2"]');
      check("第 2 步有详情按钮", !!d0);
      if (d0) {
        await d0.click();
        await page.waitForTimeout(500);
        body = await modalBody(page);
        check("报名人数显示「未登记」", /报名人数（项目资料）[\s\S]{0,40}未登记/.test(body));
        check("门槛显示「无法核算」", /达标门槛（报名 × 85%）[\s\S]{0,40}无法核算/.test(body));
        check("不出现「≥ 0」的假门槛", !/≥\s*0(?!\d)/.test(body));
        check("核对要点讲清怎么处理", /没有可核算的达标门槛/.test(body));
        await closeModal(page);
      }
    }

    /* ---------- 无报错 ---------- */
    console.log("\n[15] 控制台");
    check("无 JS 报错", errs.length === 0, errs.join(" | ").slice(0, 200));
  } finally {
    await browser.close();
    proc?.kill();
    await new Promise((r) => setTimeout(r, 300));
    if (SELF_HOSTED) clean();
  }

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error("测试异常：", e);
  proc?.kill();
  process.exit(1);
});
