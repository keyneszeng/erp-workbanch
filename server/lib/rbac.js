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
      return {
        sql: "(p.owner = ? OR EXISTS (SELECT 1 FROM project_members m WHERE m.project_id = p.id AND m.user_id = ?))",
        params: [user.name, user.id]
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

module.exports = { ROLES, PERMS, MODULES, STATUSES, isSuper, can, assertCan, scopeFilter, assertProjectVisible };
