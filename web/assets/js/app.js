import { api, state, can } from "./lib/api.js";
import { esc, toast } from "./lib/ui.js";
import * as login from "./pages/login.js";
import * as dashboard from "./pages/dashboard.js";
import * as projects from "./pages/projects.js";
import * as project from "./pages/project.js";
import * as approvals from "./pages/approvals.js";
import * as verify from "./pages/verify.js";
import * as finance from "./pages/finance.js";
import * as contracts from "./pages/contracts.js";
import * as materials from "./pages/materials.js";
import * as archive from "./pages/archive.js";
import * as audit from "./pages/audit.js";
import * as users from "./pages/users.js";
import * as flow from "./pages/flow.js";

const NAV = [
  { k: "dashboard", n: "工作台", items: [{ k: "dashboard", n: "我的工作台" }, { k: "flow", n: "全流程总览" }] },
  { k: "projects", n: "项目管理", items: [
    { k: "projects", n: "会议项目" },
    { k: "approvals", n: "审批中心", need: () => can("project:approve") || can("verify:exception_approve") || can("payment:approve") },
    { k: "contracts", n: "合同台账", need: () => state.role.modules.includes("prep") }
  ] },
  { k: "verify", n: "会后核销", items: [{ k: "verify", n: "核销看板" }] },
  { k: "finance", n: "财务结算", items: [{ k: "finance", n: "付款与结算" }] },
  { k: "materials", n: "材料中心", items: [{ k: "materials", n: "归档材料" }] },
  { k: "archive", n: "档案中心", items: [{ k: "archive", n: "数字卷宗" }] },
  { k: "audit", n: "审计日志", items: [{ k: "audit", n: "操作留痕" }] },
  { k: "system", n: "系统配置", items: [{ k: "users", n: "用户与权限" }] }
];

const ROUTES = [
  { re: /^dashboard$/, page: dashboard, nav: "dashboard", title: "我的工作台", sub: "待办、会议与异常预警" },
  { re: /^flow$/, page: flow, nav: "flow", title: "全流程总览", sub: "9 状态 8 流转 · 门禁链与阶段职责" },
  { re: /^projects$/, page: projects, nav: "projects", title: "会议项目", sub: "按数据范围列出全部会议" },
  { re: /^projects\/([\w-]+)$/, page: project, nav: "projects", title: "项目详情", sub: "全生命周期作业台" },
  { re: /^approvals$/, page: approvals, nav: "approvals", title: "审批中心", sub: "立项 / 例外单 / 付款 / 变更" },
  { re: /^verify$/, page: verify, nav: "verify", title: "核销看板", sub: "6 步 SOP · 付款唯一前置门" },
  { re: /^verify\/([\w-]+)$/, page: verify, nav: "verify", title: "核销作业", sub: "6 步判定与例外单闭环" },
  { re: /^finance$/, page: finance, nav: "finance", title: "付款与结算", sub: "付款申请、审批、付款与结算单" },
  { re: /^contracts$/, page: contracts, nav: "contracts", title: "合同台账", sub: "合同金额与签署状态" },
  { re: /^materials$/, page: materials, nav: "materials", title: "材料中心", sub: "归档必备 8 类材料" },
  { re: /^archive$/, page: archive, nav: "archive", title: "数字卷宗", sub: "已归档项目检索与导出" },
  { re: /^audit$/, page: audit, nav: "audit", title: "审计日志", sub: "Who / When / What / Which" },
  { re: /^users$/, page: users, nav: "users", title: "用户与权限", sub: "账号、角色与数据范围" }
];

function parseHash() {
  const h = location.hash.replace(/^#\/?/, "");
  return h || "dashboard";
}

function navHtml(active) {
  const mods = state.role?.modules || [];
  return NAV.filter((g) => mods.includes(g.k)).map((g) => {
    const items = g.items.filter((it) => !it.need || it.need());
    if (!items.length) return "";
    if (items.length === 1) {
      const it = items[0];
      return `<button class="ni d1${active === it.k ? " on" : ""}" data-go="${it.k}">
        <span class="dot"></span><span class="lbl">${g.n}</span></button>`;
    }
    return `<button class="ni d1 anc" disabled><span class="dot"></span><span class="lbl">${g.n}</span></button>` +
      items.map((it) => `<button class="ni d2${active === it.k ? " on" : ""}" data-go="${it.k}">
        <span class="dot"></span><span class="lbl">${it.n}</span></button>`).join("");
  }).filter(Boolean).join('<div class="nav-sep"></div>');
}

function topHtml(r) {
  const role = state.role || {};
  return `<div>
      <div style="font-size:12px;color:var(--mute);letter-spacing:.5px">协会会议执行 ERP</div>
      <div style="font-size:12.5px;color:var(--sub);font-weight:600">${esc(r.title)}</div>
    </div>
    <div class="top-right">
      ${state.super ? '<span class="super-tag">全部权限 · 全平台</span>' : ""}
      <span class="role-tag ${state.super ? "super" : ""}">${esc(role.name || "")}</span>
      <span style="font-size:12.5px;color:var(--sub)">${esc(state.user.name)}</span>
      <button class="btn btn-o btn-sm" id="logoutBtn">退出</button>
    </div>`;
}

async function route() {
  if (!state.user) return;
  const path = parseHash();
  let hit = null;
  for (const r of ROUTES) {
    const m = r.re.exec(path);
    if (m) { hit = { ...r, params: m.slice(1) }; break; }
  }
  if (!hit) { location.hash = "#/dashboard"; return; }

  state.route = hit.nav;
  document.getElementById("nav").innerHTML = navHtml(hit.nav);
  document.getElementById("top").innerHTML = topHtml(hit);
  document.getElementById("logoutBtn").onclick = doLogout;

  const content = document.getElementById("content");
  content.innerHTML = '<div class="empty" style="padding:60px">加载中…</div>';
  try {
    await hit.page.render(content, hit.params, hit);
  } catch (e) {
    content.innerHTML = `<div class="alert alert-r"><div><b>页面加载失败</b><br>${esc(e.message)}</div></div>`;
  }
  content.scrollTop = 0;
}

async function doLogout() {
  try { await api.post("/api/auth/logout", {}); } catch {}
  state.user = null;
  document.getElementById("app").hidden = true;
  document.getElementById("login").style.display = "";
  login.render(document.getElementById("login"), boot);
}

async function boot() {
  const me = await api.get("/api/auth/me");
  if (!me.user) {
    document.getElementById("app").hidden = true;
    document.getElementById("login").style.display = "";
    login.render(document.getElementById("login"), boot);
    return;
  }
  state.user = me.user;
  state.role = me.role;
  state.perms = me.perms || [];
  state.super = !!me.super;
  state.meta = await api.get("/api/meta");

  document.getElementById("login").style.display = "none";
  document.getElementById("app").hidden = false;
  document.getElementById("sideFoot").innerHTML = `<div class="side-user">
    <div class="av">${esc(state.user.name.slice(0, 1))}</div>
    <div><b>${esc(state.user.name)}</b><span>${esc(state.role.name)}${state.user.assoc ? " · " + esc(state.user.assoc) : ""}</span></div>
  </div>`;

  if (!location.hash) location.hash = "#/dashboard";
  await route();
}

window.addEventListener("hashchange", route);
window.addEventListener("erp:unauthorized", () => {
  if (!state.user) return;
  state.user = null;
  toast("登录状态已失效，请重新登录", "warn");
  boot();
});

document.addEventListener("click", (e) => {
  const go = e.target.closest("[data-go]");
  if (go && go.dataset.go) {
    const k = go.dataset.go;
    location.hash = k.startsWith("#") ? k : `#/${k}`;
    e.preventDefault();
  }
});

boot().catch((e) => {
  document.getElementById("login").innerHTML = `<div class="login-box"><div class="login-right">
    <h2>服务未就绪</h2><p class="hint">${esc(e.message)}</p></div></div>`;
});
