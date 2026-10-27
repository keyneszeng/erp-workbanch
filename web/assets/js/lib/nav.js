import { state, can } from "./api.js";

/**
 * 侧栏结构 + 「这个角色能不能进这个页面」的唯一口径。
 *
 * 单独抽出来是因为有两个地方要判断可达性：
 *   1. app.js 的路由守卫（canVisit）—— 拦住直接敲 hash 的人
 *   2. pages/dashboard.js 的待办 / 预警按钮 —— 不能给出一个点进去必然被弹回的目标
 * 原来这套逻辑只写在 app.js 里，工作台拿不到，于是「去处理」对某些角色
 * 指向了没有权限的模块，点了原地不动（被守卫弹回工作台，看起来像按钮坏了）。
 *
 * 后端 server/lib/rbac.js 的 canVisitNav 是同一张表的服务端版本，
 * 改这里的 need 条件时必须同步改那边。
 */
export const NAV = [
  { k: "dashboard", n: "工作台", items: [{ k: "dashboard", n: "我的工作台" }, { k: "flow", n: "全流程总览" }] },
  { k: "projects", n: "项目管理", items: [
    { k: "projects", n: "会议项目" },
    { k: "approvals", n: "审批中心", need: () => can("project:approve") || can("verify:exception_approve") || can("payment:approve") },
    { k: "contracts", n: "合同台账", need: () => state.role.modules.includes("prep") }
  ] },
  { k: "demand", n: "会务需求", items: [{ k: "demand", n: "需求确认" }] },
  { k: "verify", n: "会后核销", items: [{ k: "verify", n: "核销看板" }] },
  { k: "finance", n: "财务结算", items: [{ k: "finance", n: "付款与结算" }] },
  { k: "materials", n: "材料中心", items: [{ k: "materials", n: "归档材料" }] },
  { k: "archive", n: "档案中心", items: [{ k: "archive", n: "数字卷宗" }] },
  { k: "audit", n: "审计日志", items: [{ k: "audit", n: "操作留痕" }] },
  { k: "system", n: "系统配置", items: [{ k: "users", n: "用户与权限" }] }
];

/**
 * nav 页面 key → 能不能进。
 * 组（g.k）必须在角色的模块白名单里，且条目自己的 need() 要通过。
 */
export function canVisit(nav) {
  const mods = state.role?.modules || [];
  for (const g of NAV) {
    if (!mods.includes(g.k)) continue;
    const it = g.items.find((x) => x.k === nav);
    if (it) return !it.need || it.need();
  }
  return false;
}

/** `approvals/AP-2026-013` → `approvals`；用来判断一个 data-go 目标进不进得去 */
export function navOf(target) {
  return String(target || "").split("/")[0];
}

/** 这个跳转目标当前角色能不能真的打开（不能就别渲染成按钮） */
export function reachable(target) {
  return !!target && canVisit(navOf(target));
}
