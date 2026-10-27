"use strict";
const { forbidden } = require("./util");

/**
 * 角色定义 —— 与演示版 V1.0.2 一致
 * 总管理员 = 超级角色：拥有全部模块、全部动作、全部数据范围，且不受数据范围过滤
 */
const ROLES = {
  admin: {
    name: "总管理员", short: "总管理", scope: "全平台", super: true,
    modules: ["dashboard", "projects", "prep", "demand", "exec", "materials", "verify", "finance", "archive", "audit", "system"],
    desc: "全部模块 · 全部数据 · 可代任何角色操作"
  },
  assoc: {
    name: "协会管理员", short: "协会", scope: "本协会", super: false,
    modules: ["dashboard", "projects", "prep", "demand", "exec", "materials", "verify", "finance", "archive", "audit"],
    desc: "本协会项目全流程 + 审计查阅"
  },
  exec: {
    name: "会务执行人员", short: "执行", scope: "授权会议", super: false,
    modules: ["dashboard", "projects", "prep", "demand", "exec", "materials", "verify"],
    desc: "被授权会议的执行、材料与核销取证"
  },
  finance: {
    name: "财务与核销", short: "财务", scope: "授权项目", super: false,
    modules: ["dashboard", "projects", "prep", "exec", "materials", "verify", "finance", "archive"],
    desc: "核销判定、付款审批、结算与归档"
  },
  user: {
    name: "普通用户 / 嘉宾", short: "用户", scope: "本人数据", super: false,
    modules: ["dashboard", "projects"],
    desc: "仅本人相关的会议与材料"
  }
};

/** 动作级权限：动作 -> 允许的角色（admin 恒通过） */
const PERMS = {
  "project:create": ["assoc", "exec"],
  "project:approve": ["assoc"],
  "project:transition": ["assoc", "exec", "finance"],
  "project:change": ["assoc", "exec"],
  /**
   * 变更落账：把已审批的变更真正写进项目（含预算）。
   *
   * 单独一个权限，是因为它必须能交给「申请人 / 审批人以外」的人 ——
   * 老板要求的双人复核是「批的人不落账、提的人不落账」。
   * 如果沿用 project:approve（只有协会 + 超管），
   * 「协会提交 → 超管审批」这种最常见的组合就没人能落账了，流程会卡死。
   */
  "change:execute": ["assoc", "exec", "finance"],
  "project:member": ["assoc"],
  "contract:write": ["assoc", "exec"],
  "contract:approve": ["assoc"],
  "demand:write": ["assoc", "exec"],
  "payment:create": ["assoc", "exec", "finance"],
  "payment:approve": ["finance"],
  "payment:pay": ["finance"],
  "verify:check": ["assoc", "exec", "finance"],
  "verify:exception": ["assoc", "exec"],
  "verify:exception_approve": ["finance"],
  "verify:conclude": ["finance"],
  "settle:create": ["finance"],
  "archive:write": ["assoc", "finance"],
  "material:write": ["assoc", "exec", "finance"],
  "audit:read": ["assoc"],
  "export:any": ["assoc", "exec", "finance"],
  "user:manage": [],
  "setting:write": []
};

const MODULES = [
  { k: "dashboard", n: "工作台", d: "待办 / 本周会议 / 异常预警" },
  { k: "projects", n: "项目管理", d: "会议列表、立项与阶段推进" },
  { k: "prep", n: "筹备管理", d: "合同 / 招商 / 嘉宾 / 议程 / 资源 / 任务" },
  { k: "demand", n: "会务需求", d: "设计 / 制作 / 现场执行 / 其他" },
  { k: "exec", n: "会务执行", d: "报名签到 / 嘉宾邀请 / 任务 / 异常" },
  { k: "materials", n: "材料中心", d: "课件 / 串场 / 劳务表 / 协议 / 照片" },
  { k: "verify", n: "会后核销", d: "6 步 SOP + 例外单（付款唯一前置门）" },
  { k: "finance", n: "财务结算", d: "公付 / 报销 / 厂家款 / 发票 / 结算单" },
  { k: "archive", n: "档案中心", d: "数字卷宗检索 / 归档 / 导出" },
  { k: "audit", n: "审计日志", d: "跨模块全量操作留痕 · 4W" },
  { k: "system", n: "系统配置", d: "用户、角色与参数" }
];

const STATUSES = ["草稿", "待审批", "已立项", "筹备中", "执行中", "待核销", "已核销", "已结算", "已归档"];

/**
 * 页面 → 所属模块。与前端 `web/assets/js/lib/nav.js` 的 NAV 是同一张表。
 *
 * 为什么要放在后端也算一遍：工作台的「异常预警 / 我的待办」每条都带一个 `go` 目标，
 * 如果这个角色根本进不去那个页面，前端点下去会被路由守卫弹回工作台 ——
 * 用户看到的就是「按钮点了没反应」。所以生成预警时先问一遍可达性，
 * 不可达的预警干脆不生成（它本来也处理不了）。
 * 改前端 NAV 的 need 条件时，这里必须同步改。
 */
const NAV_MODULE = {
  dashboard: "dashboard", flow: "dashboard",
  projects: "projects", approvals: "projects", contracts: "prep",
  demand: "demand", verify: "verify", finance: "finance",
  materials: "materials", archive: "archive", audit: "audit", users: "system"
};

/** 这个角色能不能打开某个页面（含审批中心的动作级条件） */
function canVisitNav(user, nav) {
  if (!user || !ROLES[user.role]) return false;
  const need = NAV_MODULE[nav];
  if (!need) return false;
  if (!ROLES[user.role].modules.includes(need)) return false;
  if (nav === "approvals") {
    return can(user, "project:approve") || can(user, "verify:exception_approve") || can(user, "payment:approve");
  }
  return true;
}

const isSuper = (user) => !!(user && ROLES[user.role] && ROLES[user.role].super);

function can(user, perm) {
  if (!user) return false;
  if (isSuper(user)) return true;
  const allow = PERMS[perm];
  return Array.isArray(allow) && allow.includes(user.role);
}

function assertCan(user, perm, msg) {
  if (!can(user, perm)) throw forbidden(msg || `当前角色「${ROLES[user.role]?.name || user.role}」无权执行该操作`);
}

/** 数据范围 → SQL 片段（仅作用在 projects 别名 p 上） */
function scopeFilter(user) {
  if (isSuper(user)) return { sql: "1=1", params: [] };
  switch (user.role) {
    case "assoc":
      return { sql: "p.assoc = ?", params: [user.assoc || ""] };
    case "exec":
    case "finance":
      // 「本人负责」按 user_id 认人，不再比对姓名 ——
      // 姓名可以重名（新建一个同名账号就能看到别人名下的项目），
      // 也可以被改（负责人一改名，名下项目全部从视野消失）。
      // 只有老数据 owner_id 为空时才退回姓名比对，避免历史项目直接失联。
      return {
        sql:
          "(p.owner_id = ? OR (p.owner_id IS NULL AND p.owner = ?)" +
          " OR EXISTS (SELECT 1 FROM project_members m WHERE m.project_id = p.id AND m.user_id = ?))",
        params: [user.id, user.name, user.id]
      };
    case "user":
      // 普通用户 / 嘉宾：只看被授权（成员关系）的项目，不看负责人字段
      return {
        sql: "EXISTS (SELECT 1 FROM project_members m WHERE m.project_id = p.id AND m.user_id = ?)",
        params: [user.id]
      };
    default:
      return { sql: "1=0", params: [] };
  }
}

function assertProjectVisible(user, project) {
  if (!project) return;
  if (isSuper(user)) return;
  const { sql, params } = scopeFilter(user);
  const row = require("./db").db
    .prepare(`SELECT 1 AS ok FROM projects p WHERE p.id = ? AND (${sql})`)
    .get(project.id, ...params);
  if (!row) throw forbidden("该项目不在你的数据范围内");
}

module.exports = { ROLES, PERMS, MODULES, STATUSES, isSuper, can, assertCan, scopeFilter, assertProjectVisible, canVisitNav };
