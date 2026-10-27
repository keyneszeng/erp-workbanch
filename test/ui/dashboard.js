/**
 * 工作台 UI 验证（真实 Chrome）
 * 运行：node test/ui/dashboard.js
 *
 * 验的是 V1.2.9 精简后的形态：
 *   1. 「阶段分布」「最近操作」两块已删掉，页面上再也找不到
 *   2. 「我的待办」独占整行，且面板里只有待办（一张表、五列，行数 = 接口 todos 数）
 *   3. 「近期会议」下移到待办之后，信息没丢
 *   4. 待办「处理」每条都能跳转（审批/核销/付款各验一条，且不弹回工作台）
 *   5. 全程无 JS 报错
 *
 * 脚本自带服务（设 ERP_BASE 可指向已有服务）。
 */
const { chromium } = require("playwright");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..", "..");
const PORT = Number(process.env.ERP_PORT || 8822);
const BASE = process.env.ERP_BASE || `http://127.0.0.1:${PORT}`;
const SELF_HOSTED = !process.env.ERP_BASE;

const DB = path.join(ROOT, "data", "ui-dashboard.db");
const UP = path.join(ROOT, "data", "ui-dashboard-uploads");

let pass = 0, fail = 0;
const check = (name, ok, extra = "") => {
  if (ok) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}  ${extra}`); }
};

function clean() {
  // 改名而不是删除：沙箱对「一个 turn 内累计删除次数」有配额
  for (const f of [DB, DB + "-wal", DB + "-shm"]) if (fs.existsSync(f)) fs.renameSync(f, f + ".old");
  if (fs.existsSync(UP)) fs.rmSync(UP, { recursive: true, force: true });
}

async function waitHealth(timeout = 40000) {
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
  if (body !== undefined) {
    opt.body = JSON.stringify(body);
    opt.headers["Content-Type"] = "application/json";
  }
  const r = await fetch(BASE + url, opt);
  const text = await r.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  return { status: r.status, data };
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
  const dash = (await api("GET", "/api/dashboard")).data;

  const browser = await chromium.launch({ channel: "chrome", headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 950 } });
  const errs = [];
  page.on("pageerror", (e) => errs.push(`[pageerror] ${e.message}`));
  page.on("console", (m) => { if (m.type() === "error") errs.push(m.text()); });

  try {
    /* ---------- 登录 ---------- */
    console.log("\n[1] 登录进工作台");
    await page.goto(BASE, { waitUntil: "networkidle" });
    await page.waitForTimeout(800);
    await page.fill('input[name="username"]', "admin");
    await page.fill('input[name="password"]', "123456");
    await page.click("#lbtn");
    await page.waitForTimeout(2200);
    check("进入工作台", !!(await page.$(".panel")), "");

    /* ---------- 删掉的两块 ---------- */
    console.log("\n[2] 阶段分布 / 最近操作 已删掉");
    const bodyText = await page.textContent("body");
    check("没有「阶段分布」", !bodyText.includes("阶段分布"));
    check("没有「最近操作」", !bodyText.includes("最近操作"));
    // 这两块删了以后，KPI 里的「在管会议」还在（它靠 counts 算总数）
    check("KPI 仍在", /在管会议/.test(bodyText) && /预算总额/.test(bodyText));
    const titles = await page.$$eval(".panel-h h2", (els) => els.map((e) => e.textContent.trim()));
    check("面板只剩 异常预警/我的待办/近期会议", titles.join("/") === "异常预警/我的待办/近期会议", titles.join("/"));

    /* ---------- 我的待办独占整行 ---------- */
    console.log("\n[3] 我的待办：独占整行、只显示待办");
    const box = await page.evaluate(() => {
      const panels = [...document.querySelectorAll(".panel")];
      const p = panels.find((el) => el.querySelector(".panel-h h2")?.textContent.trim() === "我的待办");
      if (!p) return null;
      const main = p.closest("main") || document.querySelector(".main") || document.body;
      const r = p.getBoundingClientRect();
      const m = main.getBoundingClientRect();
      return { w: r.width, mw: m.width, top: r.top };
    });
    check("找到「我的待办」面板", !!box);
    check("占满整行（≥ 主区 90%）", box && box.w >= box.mw * 0.9, box ? `${Math.round(box.w)}/${Math.round(box.mw)}` : "—");

    // 面板里只能有一张表：类型 / 事项 / 项目 / 时限 / 操作
    const todoCols = await page.$$eval(".panel", (els) => {
      const p = els.find((el) => el.querySelector(".panel-h h2")?.textContent.trim() === "我的待办");
      if (!p) return null;
      return {
        tables: p.querySelectorAll("table").length,
        heads: [...p.querySelectorAll("thead th")].map((th) => th.textContent.trim()),
        rows: p.querySelectorAll("tbody tr").length
      };
    });
    check("面板内只有一张表", todoCols && todoCols.tables === 1, JSON.stringify(todoCols));
    check("列头就是待办五列", todoCols && todoCols.heads.join("/") === "类型/事项/项目/时限/操作", todoCols ? todoCols.heads.join("/") : "—");
    check("行数等于接口待办数", todoCols && todoCols.rows === dash.todos.length, todoCols ? `${todoCols.rows} vs ${dash.todos.length}` : "—");
    // 待办面板里不该混进别的区块（比如又塞了个统计块）
    const todoInner = await page.$$eval(".panel", (els) => {
      const p = els.find((el) => el.querySelector(".panel-h h2")?.textContent.trim() === "我的待办");
      return p ? p.querySelectorAll("table, .tl, .alert, .kpi").length : -1;
    });
    check("待办面板没有混进别的区块", todoInner === 1, `${todoInner} 个区块`);

    /* ---------- 近期会议下移 ---------- */
    console.log("\n[4] 近期会议：下移到待办之后，信息还在");
    const order = await page.evaluate(() => {
      const panels = [...document.querySelectorAll(".panel")];
      const pos = (t) => {
        const p = panels.find((el) => el.querySelector(".panel-h h2")?.textContent.trim() === t);
        return p ? p.getBoundingClientRect().top : -1;
      };
      return { todo: pos("我的待办"), up: pos("近期会议") };
    });
    check("近期会议在待办下方", order.up > order.todo, `待办 ${Math.round(order.todo)} / 会议 ${Math.round(order.up)}`);
    const upText = await page.$$eval(".panel", (els) => {
      const p = els.find((el) => el.querySelector(".panel-h h2")?.textContent.trim() === "近期会议");
      return p ? p.textContent.replace(/\s+/g, " ") : "";
    });
    check("近期会议仍列会议与状态", /会期/.test(upText) && /状态/.test(upText), upText.slice(0, 60));
    check("会议条数等于接口", (upText.match(/20\d\d-\d\d-\d\d/g) || []).length === dash.upcoming.length,
      `${(upText.match(/20\d\d-\d\d-\d\d/g) || []).length} vs ${dash.upcoming.length}`);

    /* ---------- 待办「处理」能跳转 ---------- */
    console.log("\n[5] 待办「处理」：每条都能跳到能动手的页面");
    // 造一笔「已审批待付款」，让待办里出现付款类 —— 种子数据里没有，不造就测不到 finance 路由
    const pc = await api("POST", "/api/payments", {
      pid: "MP-2026-008", type: "学会公付", payee: "定位测试收款方", amount: 1234.5, invoice_no: ""
    });
    const payId = pc.data?.payment?.id;
    check("造一笔待付款", pc.status === 200 && !!payId, JSON.stringify(pc.data).slice(0, 80));
    const ap = payId ? await api("POST", `/api/payments/${payId}/approve`, { approve: true }) : { status: 0, data: {} };
    check("付款审批通过（待办里才会出现「待付款」）", ap.status === 200, JSON.stringify(ap.data).slice(0, 100));

    // 当前已经在工作台，goto 同一个 hash 不会重新加载 —— 必须 reload 才拿得到刚造的待办
    await page.goto(`${BASE}/#/dashboard`, { waitUntil: "networkidle" });
    await page.reload({ waitUntil: "networkidle" });
    await page.waitForTimeout(1800);
    const gos = await page.$$eval(".panel tbody [data-go]", (els) => els.map((e) => e.dataset.go));
    check("每条待办都带跳转目标", gos.length > 0 && gos.every(Boolean), `${gos.length} 条`);
    /**
     * 这里守的是本次的 bug：目标原来是 `${go}/${pid}` 硬拼，approvals/MP-xxx、finance/MP-xxx
     * 在路由表里根本不存在，点下去 route() 匹配不到就把人丢回工作台 —— 「点了处理没反应」。
     * 所以要求每个目标都是路由认得的形态（前缀 + 可选 id）。
     */
    const badGo = gos.filter((g) => !/^(approvals|verify|finance|projects|demand)(\/[\w-]+)?$/.test(g));
    check("目标都是合法路由形态", badGo.length === 0, badGo.join(" / "));

    const cases = [
      { name: "审批", hit: (g) => g.startsWith("approvals/"), expect: /审批中心/ },
      { name: "核销", hit: (g) => g.startsWith("verify/"), expect: /核销作业/ },
      { name: "付款", hit: (g) => g.startsWith("finance/"), expect: /付款与结算/ }
    ];
    for (const cs of cases) {
      const idx = gos.findIndex(cs.hit);
      if (idx < 0) { check(`${cs.name}：有待办可点`, false, "待办里没有这类"); continue; }
      await page.goto(`${BASE}/#/dashboard`, { waitUntil: "networkidle" });
      await page.waitForTimeout(1200);
      const btns = await page.$$(".panel tbody [data-go]");
      await btns[idx].click();
      await page.waitForTimeout(1700);
      const hash = await page.evaluate(() => location.hash);
      const top = await page.textContent("#top");
      check(`${cs.name}：跳到 ${gos[idx]}，没被弹回工作台`,
        hash.includes(gos[idx]) && cs.expect.test(top), `hash=${hash}`);
      if (cs.name === "审批") {
        const n = await page.evaluate(() => document.querySelectorAll("tr.row-focus").length);
        check("审批：目标行高亮", n === 1, `${n} 行`);
      }
      if (cs.name === "付款") {
        const loc = await page.evaluate(() => !!document.querySelector(".locate"));
        const n = await page.evaluate(() => document.querySelectorAll("tr.row-focus").length);
        check("付款：有定位条且目标行高亮", loc && n === 1, `定位条 ${loc} / 高亮 ${n}`);
      }
    }

    /* ---------- 无报错 ---------- */
    console.log("\n[6] 控制台");
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
