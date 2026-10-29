import { api, state, can } from "./lib/api.js";
import { esc, toast, modal, formHtml, readForm, validate } from "./lib/ui.js";
// 侧栏结构与页面可达性抽到 lib/nav.js —— 工作台也要用同一套判断，
// 否则它会给出「去处理」指向当前角色进不去的模块，点了被弹回工作台。
import { NAV, canVisit } from "./lib/nav.js";
import * as login from "./pages/login.js";
import * as dashboard from "./pages/dashboard.js";
import * as projects from "./pages/projects.js";
import * as project from "./pages/project.js";
import * as approvals from "./pages/approvals.js";
import * as verify from "./pages/verify.js";
import * as finance from "./pages/finance.js";
import * as contracts from "./pages/contracts.js";
import * as prepInvitations from "./pages/prep-invitations.js";
import * as materials from "./pages/materials.js";
import * as demand from "./pages/demand.js";
import * as archive from "./pages/archive.js";
import * as audit from "./pages/audit.js";
import * as users from "./pages/users.js";
import * as invitationConfig from "./pages/invitation-config.js";
import * as flow from "./pages/flow.js";

const ROUTES = [
  { re: /^dashboard$/, page: dashboard, nav: "dashboard", title: "我的工作台", sub: "待办、会议与异常预警" },
  { re: /^flow$/, page: flow, nav: "flow", title: "全流程总览", sub: "9 状态 8 流转 · 门禁链与阶段职责" },
  { re: /^projects$/, page: projects, nav: "projects", title: "会议项目", sub: "按数据范围列出全部会议" },
  { re: /^projects\/([\w-]+)$/, page: project, nav: "projects", title: "项目详情", sub: "全生命周期作业台" },
  { re: /^approvals$/, page: approvals, nav: "approvals", title: "审批中心", sub: "立项 / 例外单 / 付款 / 变更" },
  // 带目标：从工作台待办/预警点进来时定位到具体那一条（审批单号或项目号）
  { re: /^approvals\/([\w-]+)$/, page: approvals, nav: "approvals", title: "审批中心", sub: "已定位到待处理事项" },
  { re: /^verify$/, page: verify, nav: "verify", title: "核销看板", sub: "6 步 SOP · 付款唯一前置门" },
  { re: /^verify\/([\w-]+)$/, page: verify, nav: "verify", title: "核销作业", sub: "6 步判定与例外单闭环" },
  { re: /^finance$/, page: finance, nav: "finance", title: "付款与结算", sub: "付款申请、审批、付款与结算单" },
  // 带项目：从「待付款」待办点进来时只列该项目的付款，直接能看到付款按钮
  { re: /^finance\/([\w-]+)$/, page: finance, nav: "finance", title: "付款与结算", sub: "已定位到指定项目" },
  { re: /^contracts$/, page: contracts, nav: "contracts", title: "合同台账", sub: "合同金额与签署状态" },
  { re: /^prep-invitations$/, page: prepInvitations, nav: "prep-invitations", title: "筹备管理 · 邀请函", sub: "内置模板匹配、PDF、邮件与微信小程序分享" },
  { re: /^demand$/, page: demand, nav: "demand", title: "会务需求确认", sub: "四组清单：设计 / 制作 / 现场执行 / 其他" },
  { re: /^demand\/([\w-]+)$/, page: demand, nav: "demand", title: "需求单", sub: "逐条确认会务需求" },
  { re: /^materials$/, page: materials, nav: "materials", title: "材料中心", sub: "归档必备 8 类材料" },
  { re: /^archive$/, page: archive, nav: "archive", title: "数字卷宗", sub: "已归档项目检索与导出" },
  { re: /^audit$/, page: audit, nav: "audit", title: "审计日志", sub: "Who / When / What / Which" },
  { re: /^users$/, page: users, nav: "users", title: "用户与权限", sub: "账号、角色与数据范围" },
  { re: /^invitation-config$/, page: invitationConfig, nav: "invitation-config", title: "邀请函上线配置", sub: "草稿 · 预览 · 发布 · 回退" }
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
      // V1.2.17 UX-01：只有一个条目时用**条目名**，不要用组名。
      // 否则 guest 侧栏显示「项目管理」，点进去页面标题却是「会议项目」—— 同一处两个叫法。
      return `<button class="ni d1${active === it.k ? " on" : ""}" data-go="${it.k}">
        <span class="dot"></span><span class="lbl">${it.n}</span></button>`;
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
      <button class="btn btn-o btn-sm" id="pwdBtn">修改密码</button>
      <button class="btn btn-o btn-sm" id="logoutBtn">退出</button>
    </div>`;
}

/**
 * 路由渲染的「代次」。每次切页 +1，页面渲染完成后如果代次已经变了，
 * 说明用户早就点走了 —— 这次的结果必须丢掉。
 *
 * 不这么做的后果（线上 2026-10-28 真实发生过）：登录后工作台的大盘要拉一堆接口，
 * 老板等不及直接点「审批中心」；审批中心渲染完了，工作台那批慢请求才回来，
 * 把 #content 整个写成工作台 —— 顶栏写着「审批中心」，内容是工作台。
 */
let routeSeq = 0;

/**
 * 通用骨架屏：一张页头 + 四张 KPI + 一个表格占位。
 * 不做逐页面定制 —— 各页面结构差异大，定制成本高且容易和真实版式对不上，
 * 「大致占住位置、别让人以为卡死」这个目标通用版就够了。
 */
function skeletonHtml() {
  const rows = Array.from({ length: 6 }, () => '<div class="sk-row"></div>').join("");
  return `<div class="sk" aria-busy="true" aria-live="polite">
    <div class="sk-h"></div>
    <div class="sk-sub"></div>
    <div class="sk-kpis">
      ${Array.from({ length: 4 }, () => '<div class="sk-kpi"><i></i><b></b></div>').join("")}
    </div>
    <div class="sk-panel">
      <div class="sk-row sk-head"></div>
      ${rows}
    </div>
    <span class="sr-only">加载中…</span>
  </div>`;
}

/** 该页面当前角色是否可访问（模块白名单 + 条目级权限） */
async function route() {
  if (!state.user) return;
  const path = parseHash();
  let hit = null;
  for (const r of ROUTES) {
    const m = r.re.exec(path);
    if (m) { hit = { ...r, params: m.slice(1) }; break; }
  }
  /**
   * 匹配不到路由时原来只是 `location.hash = "#/dashboard"`，一声不响地把人丢回工作台 ——
   * 用户点了个按钮，页面闪一下还在原地，看起来就是「按钮坏了」。
   * 现在明确告诉他链接失效，再回工作台。
   */
  if (!hit) {
    toast("页面不存在或链接已失效，已返回工作台", "warn");
    location.hash = "#/dashboard";
    return;
  }

  if (!canVisit(hit.nav)) {
    toast("当前角色无权访问该页面", "warn");
    location.hash = "#/dashboard";
    return;
  }

  state.route = hit.nav;
  document.getElementById("nav").innerHTML = navHtml(hit.nav);
  document.getElementById("top").innerHTML = topHtml(hit);
  document.getElementById("logoutBtn").onclick = doLogout;
  document.getElementById("pwdBtn").onclick = openPassword;

  // 每次渲染给一个自己的容器：慢页面即使晚回来，写的也是已经被摘掉的旧容器，
  // 不会盖住用户当前看的页面。
  const seq = ++routeSeq;
  const content = document.getElementById("content");
  const box = document.createElement("div");
  box.className = "page";
  // V1.2.17 UX-02：骨架屏替代一行「加载中…」。
  // 线上接口 2~3 秒，纯文字会让人以为卡死；骨架屏先把版式占住，内容一到就替换。
  box.innerHTML = skeletonHtml();
  content.replaceChildren(box);
  try {
    await hit.page.render(box, hit.params, hit);
    if (seq !== routeSeq) return;
  } catch (e) {
    if (seq !== routeSeq) return; // 已经切走，别拿错误页盖住新页面
    const title = e.status === 403 ? "无权访问" : e.status === 404 ? "对象不存在" : "页面加载失败";
    const tip = e.status === 403
      ? "该项目不在你的数据范围内，或当前角色缺少对应权限。"
      : e.status === 404 ? "链接可能已失效，或对象已被删除。" : "请稍后重试；若持续出现请联系管理员。";
    box.innerHTML = `<div class="panel" style="max-width:560px;margin:40px auto;text-align:center">
      <div style="font-size:15px;font-weight:700;margin-bottom:6px">${title}</div>
      <div style="font-size:13px;color:var(--sub);line-height:1.8">${esc(e.message)}<br>${tip}</div>
      <div style="margin-top:16px"><button class="btn btn-p" data-go="dashboard">返回工作台</button></div>
    </div>`;
  }
  content.scrollTop = 0;
}

/* ---------------- 修改密码 ---------------- */
function openPassword() {
  const fields = [
    { k: "oldPassword", l: "原密码", t: "password", req: 1, full: 1 },
    { k: "newPassword", l: "新密码", t: "password", req: 1, full: 1, tip: "至少 8 位，需同时包含字母和数字" },
    { k: "confirmPassword", l: "确认新密码", t: "password", req: 1, full: 1 }
  ];
  const m = modal({
    title: "修改密码",
    body: formHtml(fields) +
      '<div class="tip" style="margin-top:10px;color:var(--mute);line-height:1.7">' +
      "修改成功后，该账号在其它设备上的登录会立即失效，本机保持登录。</div>",
    footer: `<button class="btn btn-o" data-x="0">取消</button><button class="btn btn-p" data-x="1">确认修改</button>`
  });
  m.querySelector('[data-x="0"]').onclick = () => m.classList.remove("open");
  m.querySelector('[data-x="1"]').onclick = async () => {
    if (!validate(m, fields)) return;
    const v = readForm(m);
    if (v.newPassword !== v.confirmPassword) { toast("两次输入的新密码不一致", "warn"); return; }
    if (v.newPassword === v.oldPassword) { toast("新密码不能与原密码相同", "warn"); return; }
    const btn = m.querySelector('[data-x="1"]');
    btn.disabled = true;
    btn.textContent = "提交中…";
    try {
      const r = await api.post("/api/auth/password", v);
      m.classList.remove("open");
      toast(r.message || "密码已修改", "ok");
    } catch (e) {
      toast(e.message, "warn");
      btn.disabled = false;
      btn.textContent = "确认修改";
    }
  };
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
