"use strict";
/**
 * LIVE five-role browser inspection against erp.aibuild.work.
 * Does not reset demo data or submit irreversible workflows.
 * The separate live survey runs the complete business write/read lifecycle.
 */
const { chromium } = require("playwright");
const fs = require("node:fs");
const path = require("node:path");

const BASE = (process.env.ERP_BASE || "https://erp.aibuild.work").replace(/\/$/, "");
const OUTPUT = path.join(process.cwd(), "artifacts", "live-regression");
fs.mkdirSync(OUTPUT, { recursive: true });
const ROLES = ["admin", "assoc", "exec", "finance", "guest"];
const PRIVATE_ROUTES = ["users", "approvals", "finance", "verify", "demand", "contracts", "materials", "audit", "archive"];
const TITLE_BY_ROUTE = {
  dashboard: "我的工作台", flow: "全流程总览", projects: "会议项目",
  approvals: "审批中心", verify: "核销看板", finance: "付款与结算",
  contracts: "合同台账", demand: "会务需求", materials: "材料中心",
  archive: "数字卷宗", audit: "审计日志", users: "用户与权限"
};
const OPEN_MODALS = {
  projects: ["#newBtn"],
  contracts: ["#newC"],
  finance: ["#newPay"],
  materials: ["#add"],
  users: ["#newU", "#resetAll"]
};
const results = [];
const inventory = [];
const errors = [];
let pass = 0, fail = 0, skip = 0;
function check(role, module, action, ok, actual = "") {
  const status = ok === null ? "SKIP" : ok ? "PASS" : "FAIL";
  if (status === "PASS") pass++;
  if (status === "FAIL") fail++;
  if (status === "SKIP") skip++;
  results.push({ role, module, action, status, actual: String(actual).slice(0, 350) });
  console.log("  [" + status + "] " + role + " / " + module + " / " + action +
              (status === "FAIL" ? " => " + String(actual).slice(0, 180) : ""));
}
function delay(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

async function loaded(page) {
  await page.waitForFunction(() => {
    const app = document.getElementById("app");
    const root = document.querySelector("#content > .page");
    return app && !app.hidden && root && !root.querySelector(".sk") &&
      !!root.textContent.trim();
  }, { timeout: 30000 }).catch(() => {});
}
async function go(page, route) {
  await page.goto(BASE + "/#/" + route, { waitUntil: "domcontentloaded", timeout: 40000 });
  await loaded(page);
}
async function modalOpenAndClose(page, role, route, selector) {
  const el = page.locator("#content " + selector).first();
  if (!await el.count()) return check(role, route, "入口 " + selector, null, "not visible for this role/state");
  if (!await el.isEnabled()) return check(role, route, "入口 " + selector, null, "disabled by business state");
  try {
    await el.click({ timeout: 12000 });
    await page.waitForTimeout(350);
    const opened = await page.locator("#modal.open .mbox").isVisible().catch(() => false);
    if (!opened) {
      const toast = await page.locator(".toast").allTextContents().catch(() => []);
      check(role, route, "打开弹窗 " + selector, false, "no modal; " + toast.join(" "));
    } else {
      check(role, route, "打开弹窗 " + selector, true);
      if (selector === "#resetAll") {
        const no = await page.locator("#modal #doReset").isDisabled().catch(() => false);
        check(role, route, "重置二次确认保护", no, "confirm disabled: " + no);
      }
    }
  } catch (err) {
    check(role, route, "打开弹窗 " + selector, false, err.message);
  } finally {
    if (await page.locator("#modal.open .close").count()) {
      await page.locator("#modal.open .close").click({ timeout: 5000 }).catch(() => {});
    }
  }
}
async function testExports(page, role, route) {
  for (const sel of ["#expBtn", "#expPay", "#expSt", "#exp", "#export"]) {
    const el = page.locator("#content " + sel).first();
    if (!(await el.count()) || !(await el.isEnabled())) continue;
    try {
      const downloadPromise = page.waitForEvent("download", { timeout: 15000 });
      await el.click({ timeout: 12000 });
      const item = await downloadPromise;
      check(role, route, "实际导出 " + sel, /\.csv$/i.test(item.suggestedFilename()), item.suggestedFilename());
    } catch (err) {
      check(role, route, "实际导出 " + sel, false, err.message);
    }
  }
}
async function inspectRoute(page, role, route) {
  try {
    await go(page, route);
    const where = new URL(page.url()).hash;
    const body = await page.locator("#content").innerText({ timeout: 10000 }).catch(() => "");
    check(role, route, "路由可达", where.startsWith("#/" + route) &&
      !/页面加载失败|无权访问|对象不存在|服务未就绪/.test(body),
      where + " " + body.slice(0, 140));
    const title = TITLE_BY_ROUTE[route];
    if (title) check(role, route, "页面标题", body.includes(title) || (await page.locator("#top").innerText()).includes(title), body.slice(0, 110));
    const buttons = await page.locator("#content button").evaluateAll(els => els.map(e => ({
      text: (e.innerText || e.title || "").trim().slice(0, 52),
      id: e.id || "", disabled: e.disabled, dataset: Object.keys(e.dataset).slice(0, 2).join("|")
    })));
    inventory.push({ role, route, buttons });
    // 全流程总览是纯只读状态图，没有按钮是正确设计；不能误判为功能故障。
    if (route === "flow") {
      check(role, route, "只读流程图无需按钮", buttons.length === 0, buttons.length);
    } else {
      check(role, route, "功能键可枚举", buttons.length > 0, buttons.length);
    }
    const q = page.locator("#content input#q");
    if (await q.count()) {
      await q.fill("QA_不存在的关键字");
      await page.waitForTimeout(550);
      await q.fill("");
      await page.waitForTimeout(450);
      check(role, route, "搜索键入与清除", (await q.inputValue()) === "");
    }
    // Exercise the distinct list tab states; no business data changes.
    for (const attr of ["data-v", "data-stage", "data-st"]) {
      const buttons = page.locator("#content button[" + attr + "]");
      const names = await buttons.evaluateAll(els => els.slice(0, 5).map(e => e.getAttribute("data-v") ?? e.getAttribute("data-stage") ?? e.getAttribute("data-st")));
      for (const val of names) {
        const clickIt = page.locator('#content button[' + attr + '="' + val + '"]').first();
        if (!await clickIt.count()) continue;
        try {
          await clickIt.click({ timeout: 8000 });
          await page.waitForTimeout(250);
          check(role, route, "列表页签 " + val, !/页面加载失败/.test(await page.locator("#content").innerText()), val);
        } catch (err) {
          check(role, route, "列表页签 " + val, false, err.message);
        }
      }
    }
    for (const sel of (OPEN_MODALS[route] || [])) {
      await modalOpenAndClose(page, role, route, sel);
    }
    await testExports(page, role, route);
    if (route === "users") {
      check(role, route, "权限矩阵显示", /角色权限矩阵/.test(await page.locator("#content").innerText()));
      check(role, route, "重置危险操作入口", (await page.locator("#resetAll").count()) === 1);
    }
  } catch (err) {
    check(role, route, "页面流程异常", false, err.message);
  }
}

async function inspectDetail(page, role) {
  try {
    const projects = await page.evaluate(async () => {
      const resp = await fetch("/api/projects?size=50", { credentials: "same-origin" });
      const d = await resp.json();
      return (d.rows || []).map(x => x.id);
    });
    if (!projects.length) {
      check(role, "project-detail", "项目可见性", null, "no accessible project");
      return;
    }
    const pid = projects[0];
    await go(page, "projects/" + pid);
    const view = await page.locator("#content").innerText();
    check(role, "project-detail", "进入项目详情", !/页面加载失败|无权访问|对象不存在/.test(view), pid);
    const tabs = await page.locator("#content button[data-tab]").evaluateAll(els => els.map(e => e.dataset.tab));
    if (role === "guest") {
      check(role, "project-detail", "嘉宾只有公开概览页签", tabs.length === 1 && tabs[0] === "overview", tabs.join(","));
      check(role, "project-detail", "嘉宾财务信息不展示", !/财务概览|付款门禁|审批记录|成员与授权/.test(view));
    } else {
      check(role, "project-detail", "八个业务页签", tabs.length === 8, tabs.join(","));
    }
    for (const tab of tabs) {
      try {
        await page.locator('#content button[data-tab="' + tab + '"]').click({ timeout: 10000 });
        await page.waitForTimeout(180);
        const t = await page.locator("#tabbody").innerText({ timeout: 10000 });
        check(role, "project-detail", "业务页签 " + tab, t.length > 0 && !/页面加载失败/.test(t), t.slice(0, 90));
      } catch (e) {
        check(role, "project-detail", "业务页签 " + tab, false, e.message);
      }
    }
    await modalOpenAndClose(page, role, "project-detail", "#editBtn");
    await modalOpenAndClose(page, role, "project-detail", "#changeBtn");
  } catch (err) {
    check(role, "project-detail", "详情页面检查", false, err.message);
  }
}
async function inspectRestrictedRoutes(page, role, navKeys) {
  for (const route of PRIVATE_ROUTES) {
    if (navKeys.includes(route)) continue;
    try {
      await go(page, route);
      await page.waitForTimeout(120);
      const hash = new URL(page.url()).hash;
      check(role, "rbac", "拒绝未授权页面 " + route, !hash.startsWith("#/" + route), hash);
    } catch (err) {
      check(role, "rbac", "拒绝未授权页面 " + route, false, err.message);
    }
  }
}
async function oneRole(browser, role) {
  const ctx = await browser.newContext({ viewport: { width: 1366, height: 850 }, acceptDownloads: true });
  const page = await ctx.newPage();
  page.on("pageerror", e => errors.push({ role, type: "pageerror", message: e.message }));
  page.on("console", e => {
    if (e.type() === "error" && !/favicon|Failed to load resource/.test(e.text())) {
      errors.push({ role, type: "console", message: e.text().slice(0, 180) });
    }
  });
  try {
    await page.goto(BASE, { waitUntil: "domcontentloaded", timeout: 50000 });
    await page.locator("#lform").waitFor({ timeout: 25000 });
    await page.fill('input[name="username"]', role);
    await page.fill('input[name="password"]', "123456");
    await page.locator("#lbtn").click();
    await page.waitForSelector("#app:not([hidden])", { timeout: 25000 });
    await loaded(page);
    check(role, "auth", "真实浏览器登录", true);
    const roleInfo = await page.evaluate(async () => (await (await fetch("/api/auth/me")).json()));
    check(role, "auth", "角色身份与授权读取", roleInfo.user?.username === role && !!roleInfo.role?.name, roleInfo.user?.username);
    if (role === "exec") {
      // Separate material metadata registration from real Cloudflare object storage readiness.
      const cap = await page.evaluate(async () => {
        const res = await fetch("/api/uploads/capability", { credentials: "same-origin" });
        return { status: res.status, ...await res.json() };
      });
      if (cap.status !== 200) {
        check(role, "attachments", "上传能力接口", false, "HTTP " + cap.status);
      } else if (!cap.enabled) {
        check(role, "attachments", "真实照片/PDF上传能力", null,
          "BLOCKED: Cloudflare backend " + cap.backend + " 未启用 R2（材料元数据登记不代表文件上传）");
      } else {
        check(role, "attachments", "Cloudflare 文件存储已启用", true, cap.backend);
        const actual = await page.evaluate(async () => {
          const b64 = "R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==";
          const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
          const res = await fetch("/api/uploads", {
            method: "POST",
            headers: { "Content-Type": "image/gif", "x-file-name": "qa-1pixel.gif" },
            body: bytes
          });
          const data = await res.json();
          return { status: res.status, url: data.url || "", code: data.error?.code || "" };
        });
        check(role, "attachments", "真实图片上传", actual.status === 200 && !!actual.url,
          "HTTP " + actual.status + " " + actual.code);
        if (actual.url) {
          const ownerStatus = await page.evaluate(async u => (await fetch(u)).status, actual.url);
          check(role, "attachments", "上传人下载文件", ownerStatus === 200, ownerStatus);
        }
      }
    }
    const nav = await page.locator("#nav button[data-go]").evaluateAll(els => els.map(e => e.dataset.go));
    check(role, "navigation", "侧栏菜单已加载", nav.length >= 2, nav.join(","));
    await page.screenshot({ path: path.join(OUTPUT, role + "-dashboard.png") });
    for (const route of [...new Set(nav)]) {
      await inspectRoute(page, role, route);
    }
    if (nav.includes("projects")) await inspectDetail(page, role);
    await inspectRestrictedRoutes(page, role, nav);
    await go(page, "dashboard");
    if (await page.locator("#pwdBtn").count()) {
      await page.locator("#pwdBtn").click();
      check(role, "auth", "修改密码弹窗", await page.locator("#modal.open").isVisible());
      if (await page.locator("#modal.open .close").count()) await page.locator("#modal.open .close").click();
    }
    await page.locator("#logoutBtn").click();
    await page.locator("#lform").waitFor({ timeout: 15000 });
    check(role, "auth", "退出后返回登录页", await page.locator("#app").isHidden());
  } catch (err) {
    check(role, "auth", "角色巡检异常", false, err.message);
    await page.screenshot({ path: path.join(OUTPUT, role + "-ERROR.png") }).catch(() => {});
  } finally {
    await ctx.close().catch(() => {});
  }
}
(async () => {
  const b = await chromium.launch({ headless: true });
  try {
    for (const role of ROLES) await oneRole(b, role);
  } finally {
    await b.close();
  }
  for (const e of errors) {
    if (e.type === "pageerror") check(e.role, "javascript", "无未捕获 JS 错误", false, e.message);
  }
  const out = { base: BASE, at: new Date().toISOString(), pass, fail, skip, results, inventory, errors };
  fs.writeFileSync(path.join(OUTPUT, "role-button-coverage.json"), JSON.stringify(out, null, 2));
  console.log("LIVE_ROLE_REGRESSION " + JSON.stringify({ pass, fail, skip, roles: ROLES, screens: 5, inspectedPages: inventory.length }));
  process.exitCode = fail ? 1 : 0;
})().catch(err => { console.error("LIVE_ROLE_FATAL", err.message); process.exitCode = 2; });
