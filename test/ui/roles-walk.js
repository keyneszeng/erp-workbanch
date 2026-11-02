/**
 * 三个角色的连贯性巡检（线上/本地都能跑）
 *
 * 用法：
 *   ERP_BASE=http://8.134.140.186:8080 node test/ui/roles-walk.js
 *   不带 ERP_BASE 时自起一个演示库（默认端口 8842）
 *
 * 每个角色：登录 → 逐个点侧栏 → 逐个点项目页签 → 开关键弹窗，
 * 全程收集：JS 报错、接口 4xx/5xx、页面空白、明显的错误横幅。
 *
 * 只读巡检，不提交任何业务单据（避免污染线上数据）。
 */
const { chromium } = require("playwright");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..", "..");
const PORT = Number(process.env.ERP_PORT || 8842);
const BASE = process.env.ERP_BASE || `http://127.0.0.1:${PORT}`;
const SELF_HOSTED = !process.env.ERP_BASE;
const DB = path.join(ROOT, "data", "ui-roles.db");
const UP = path.join(ROOT, "data", "ui-roles-uploads");

// 线上用真实手机号账号；自起演示库时用种子账号（admin/exec/finance，密码 123456）
const ACCOUNTS = SELF_HOSTED
  ? [
      { role: "总管理员", user: "admin", pass: "123456" },
      { role: "会务执行", user: "exec", pass: "123456" },
      { role: "财务", user: "finance", pass: "123456" }
    ]
  : [
      { role: "总管理员", user: process.env.ERP_ADMIN_USER || "13800138000", pass: process.env.ERP_ADMIN_PASS || "keynes1987" },
      { role: "会务执行", user: process.env.ERP_EXEC_USER || "18620867488", pass: process.env.ERP_EXEC_PASS || "keynes1987" },
      { role: "财务", user: process.env.ERP_FIN_USER || "18802080472", pass: process.env.ERP_FIN_PASS || "keynes1987" }
    ];

/** 允许出现的失败请求：登录前的 401、以及明确的权限拒绝（那是设计，不是 bug） */
const IGNORE_URL = /\/api\/auth\/(login|me|sms)|\/api\/health/;

/**
 * 各页面上的关键「功能键」：点开 → 看弹窗里该有的东西在不在 → 关掉。
 * 只开不提交，不会产生任何业务数据。
 */
const MODAL_CHECKS = {
  projects: [{ sel: "#newBtn", expect: /会议名称/, label: "新建立项" }],
  contracts: [{ sel: "#newC", expect: /合同名称/, label: "录入合同" }],
  materials: [{ sel: "#add", expect: /材料类别/, label: "登记材料" }],
  users: [{ sel: "#newU", expect: /手机号|姓名/, label: "新增用户" }],
  finance: [{ sel: "#newPay", expect: /收款方/, label: "付款申请" }],
  verify: [{ sel: "#content [data-judge], #content .judge-btn", expect: /判定|核验/, label: "核销判定" }]
};

async function checkModals(page, key, role, errs) {
  const list = MODAL_CHECKS[key];
  if (!list) return;
  for (const c of list) {
    if (!(await page.$(c.sel))) continue; // 这个角色/状态下没有这个按钮，跳过
    const before = errs.length;
    try {
      await page.click(c.sel);
      await page.waitForTimeout(900);
      const opened = await page.evaluate(() => document.getElementById("modal")?.classList.contains("open"));
      if (!opened) {
        // 没弹窗不一定是坏：常见的是「当前没有可付款项目」这类业务空状态，有 toast 说明就行
        const toast = ((await page.textContent("#toast")) || "").trim();
        if (toast) console.log(`  – ${c.label}：未打开（${toast}）`);
        else note(role, `弹窗打不开 · ${c.label}`, "点击后既没弹窗也没提示");
        continue;
      }
      const txt = ((await page.textContent("#modal")) || "").replace(/\s+/g, " ");
      if (!c.expect.test(txt)) note(role, `弹窗内容不对 · ${c.label}`, txt.slice(0, 120));
      else console.log(`  ✓ 弹窗 ${c.label}`);
      const e2 = errs.slice(before);
      if (e2.length) note(role, `弹窗报错 · ${c.label}`, e2.join(" ; "));
      await page.keyboard.press("Escape").catch(() => {});
      await page.evaluate(() => document.getElementById("modal")?.classList.remove("open")).catch(() => {});
      await page.waitForTimeout(300);
    } catch (e) {
      note(role, `弹窗打不开 · ${c.label}`, e.message);
    }
  }
}

let proc = null;
const problems = [];
const note = (role, kind, detail) => { problems.push({ role, kind, detail }); };

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

async function login(page, user, pass) {
  await page.goto(BASE, { waitUntil: "networkidle" });
  await page.waitForTimeout(600);
  await page.fill('input[name="username"]', user);
  await page.fill('input[name="password"]', pass);
  await page.click("#lbtn");
  await page.waitForSelector("#pwdBtn", { timeout: 30000 });
  await page.waitForTimeout(900);
}

/** 点一个导航项，返回页面文本，顺带检查空白 */
async function visit(page, key, label) {
  const sel = `#nav button[data-go="${key}"]`;
  if (!(await page.$(sel))) return { skipped: true };
  await page.click(sel);
  await page.waitForTimeout(1100);
  const text = ((await page.textContent("#content")) || "").replace(/\s+/g, " ").trim();
  if (!text) return { empty: true, text };
  return { text };
}

async function walkRole(browser, acct) {
  console.log(`\n════ ${acct.role}（${acct.user}）════`);
  const page = await browser.newPage({ viewport: { width: 1440, height: 950 } });
  const errs = [];
  page.on("pageerror", (e) => errs.push(`[pageerror] ${e.message}`));
  page.on("console", (m) => {
    const t = m.text();
    if (m.type() === "error" && !/Failed to load resource|favicon/.test(t)) errs.push(`[console] ${t}`);
  });
  page.on("response", (r) => {
    const s = r.status(), u = r.url();
    if (s >= 400 && !IGNORE_URL.test(u)) errs.push(`[http ${s}] ${u.replace(BASE, "")}`);
  });

  try {
    await login(page, acct.user, acct.pass);
  } catch (e) {
    note(acct.role, "登录失败", e.message);
    await page.close();
    return;
  }

  const navs = await page.$$eval("#nav button[data-go]", (els) => els.map((e) => e.dataset.go));
  console.log("  侧栏：", navs.join(" / "));

  for (const key of navs) {
    const before = errs.length;
    const r = await visit(page, key, key);
    if (r.skipped) continue;
    if (r.empty) note(acct.role, "页面空白", key);
    const newErrs = errs.slice(before);
    if (newErrs.length) note(acct.role, `页面报错 · ${key}`, newErrs.join(" ; "));
    else console.log(`  ✓ ${key}`);
    await checkModals(page, key, acct.role, errs);
  }

  // 项目详情：逐页签
  const opened = await visit(page, "projects", "projects");
  if (!opened.skipped && !opened.empty) {
    const link = await page.$('#content [data-go^="projects/"]');
    if (link) {
      const before = errs.length;
      await link.click();
      await page.waitForTimeout(1300);
      const tabs = await page.$$eval("[data-tab]", (els) => els.map((e) => e.dataset.tab));
      console.log("  项目页签：", tabs.join(" / "));
      for (const t of tabs) {
        const b2 = errs.length;
        await page.click(`[data-tab="${t}"]`);
        await page.waitForTimeout(900);
        const txt = ((await page.textContent("#tabbody")) || "").replace(/\s+/g, " ").trim();
        if (!txt) note(acct.role, "页签空白", t);
        const e2 = errs.slice(b2);
        if (e2.length) note(acct.role, `页签报错 · ${t}`, e2.join(" ; "));
        else console.log(`  ✓ 项目页签 ${t}`);
      }
      const after = errs.slice(before);
      if (after.length) note(acct.role, "项目详情报错", after.join(" ; "));
    }
  }

  if (errs.length) console.log("  累计异常：\n   " + [...new Set(errs)].join("\n   "));
  await page.close();
}

(async () => {
  if (SELF_HOSTED) {
    clean();
    proc = spawn(process.execPath, ["--experimental-sqlite", "server/index.js"], {
      cwd: ROOT,
      env: { ...process.env, ERP_PORT: String(PORT), ERP_DB: DB, ERP_UPLOAD_DIR: UP, ERP_DEMO_MODE: "1" },
      stdio: ["ignore", "pipe", "pipe"]
    });
    proc.stderr.on("data", (d) => {
      const s = d.toString();
      if (!s.includes("ExperimentalWarning") && !s.includes("trace-warnings")) process.stderr.write("[srv] " + s);
    });
    await waitHealth();
  }

  const browser = await chromium.launch({ channel: "chrome", headless: true });
  for (const a of ACCOUNTS) await walkRole(browser, a);
  await browser.close();
  if (proc) proc.kill("SIGTERM");

  console.log("\n════ 汇总 ════");
  if (!problems.length) { console.log("没有发现问题"); process.exit(0); }
  for (const p of problems) console.log(`✗ [${p.role}] ${p.kind}：${p.detail}`);
  process.exit(1);
})().catch((e) => {
  console.error("巡检失败：", e.message);
  if (proc) proc.kill("SIGTERM");
  process.exit(1);
});
