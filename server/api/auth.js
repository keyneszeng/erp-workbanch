"use strict";
const { db } = require("../lib/db");
const { login, publicUser, destroySession, COOKIE, SESSION_TTL_MS } = require("../lib/auth");
const { sendJson, cookieHeader } = require("../lib/http");
const { logAudit } = require("../lib/audit");
const { ROLES, MODULES, STATUSES, isSuper, can, PERMS } = require("../lib/rbac");
const { VERIFY_STEPS, MATERIAL_KINDS, ASSOCS, FORMS, DEPTS, PAYMENT_TYPES, FLOW, STATUS_DESC } = require("../lib/constants");
const { bad, HttpError } = require("../lib/util");

function register(router) {
  router.post("/api/auth/login", async (ctx) => {
    const { username, password } = ctx.body || {};
    if (!username || !password) throw bad("请输入账号与密码");
    const r = login(username, password, ctx.ip);
    if (!r) {
      logAudit({ user: null, module: "系统配置", action: "登录失败", target: String(username), detail: "账号或密码错误", ip: ctx.ip });
      throw new HttpError(401, "INVALID_CREDENTIALS", "账号或密码错误");
    }
    logAudit({ user: r.user, module: "系统配置", action: "登录", target: r.user.username, detail: `角色：${ROLES[r.user.role].name}`, ip: ctx.ip });
    return {
      __cookie: cookieHeader(COOKIE, r.token, { maxAge: Math.floor(SESSION_TTL_MS / 1000) }),
      user: publicUser(r.user),
      role: ROLES[r.user.role]
    };
  });

  router.post("/api/auth/logout", async (ctx) => {
    destroySession(ctx.token);
    return { __cookie: cookieHeader(COOKIE, "", { maxAge: 0 }), ok: true };
  });

  router.get("/api/auth/me", async (ctx) => {
    if (!ctx.user) return { user: null };
    const role = ROLES[ctx.user.role];
    return {
      user: publicUser(ctx.user),
      role: { ...role, key: ctx.user.role },
      perms: Object.keys(PERMS).filter((p) => can(ctx.user, p)),
      super: isSuper(ctx.user)
    };
  });

  router.get("/api/meta", async () => {
    const org = db.prepare("SELECT v FROM settings WHERE k = 'org'").get();
    return {
      org: org ? org.v : "会务执行中心",
      roles: Object.entries(ROLES).map(([k, v]) => ({ key: k, ...v })),
      modules: MODULES,
      statuses: STATUSES,
      statusDesc: STATUS_DESC,
      flow: FLOW,
      verifySteps: VERIFY_STEPS,
      materialKinds: MATERIAL_KINDS,
      assocs: ASSOCS,
      forms: FORMS,
      depts: DEPTS,
      paymentTypes: PAYMENT_TYPES
    };
  });

  return router;
}

module.exports = { register };
