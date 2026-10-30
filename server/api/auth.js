"use strict";
const { db } = require("../lib/db");
const { isDemoMode } = require("../lib/runtime");
const {
  login, publicUser, destroySession, createSession, hashPassword, verifyPassword, validatePassword,
  COOKIE, SESSION_TTL_MS, isThrottled, noteFailure, clearFailures
} = require("../lib/auth");
const { sendJson, cookieHeader } = require("../lib/http");
const { logAudit } = require("../lib/audit");
const { ROLES, MODULES, STATUSES, isSuper, can, PERMS } = require("../lib/rbac");
const { VERIFY_STEPS, MATERIAL_KINDS, CONTRACT_CATEGORIES, DEMAND_STATUSES, ASSOCS, FORMS, DEPTS, PAYMENT_TYPES, FLOW, STATUS_DESC } = require("../lib/constants");
const { bad, HttpError } = require("../lib/util");

function register(router) {
  router.post("/api/auth/login", async (ctx) => {
    const { username, password } = ctx.body || {};
    if (!username || !password) throw bad("请输入账号与密码");
    if (isThrottled(ctx.ip, username)) {
      throw new HttpError(429, "TOO_MANY_ATTEMPTS", "登录失败次数过多，请 5 分钟后再试");
    }
    const r = login(username, password, ctx.ip);
    if (!r) {
      noteFailure(ctx.ip, username);
      logAudit({ user: null, module: "系统配置", action: "登录失败", target: String(username), detail: "账号或密码错误", ip: ctx.ip });
      throw new HttpError(401, "INVALID_CREDENTIALS", "账号或密码错误");
    }
    clearFailures(ctx.ip, username);
    logAudit({ user: r.user, module: "系统配置", action: "登录", target: r.user.username, detail: `角色：${ROLES[r.user.role].name}`, ip: ctx.ip });
    return {
      __cookie: cookieHeader(COOKIE, r.token, { maxAge: Math.floor(SESSION_TTL_MS / 1000), secure: ctx.secure }),
      user: publicUser(r.user),
      role: ROLES[r.user.role]
    };
  });

  router.post("/api/auth/logout", async (ctx) => {
    destroySession(ctx.token);
    return { __cookie: cookieHeader(COOKIE, "", { maxAge: 0, secure: ctx.secure }), ok: true };
  });

  /**
   * 自助修改密码
   *
   * 改完做三件事，缺一不可：
   *   1) 写入新哈希；
   *   2) users.token_ver + 1 —— 让所有已签发的令牌（含其它设备）签名校验失败；
   *   3) 清空该用户全部会话行，再给当前这次操作重新签发一个，避免用户改完自己也被踢掉。
   */
  router.post("/api/auth/password", async (ctx) => {
    const { oldPassword, newPassword, confirmPassword } = ctx.body || {};
    if (!oldPassword || !newPassword) throw bad("请填写原密码与新密码");
    if (confirmPassword !== undefined && String(confirmPassword) !== String(newPassword)) {
      throw bad("两次输入的新密码不一致");
    }
    // V1.2.17 SEC-04：与建号、重置共用同一份强度校验
    const next = validatePassword(newPassword, { oldPassword, label: "新密码" });

    const u = db.prepare("SELECT * FROM users WHERE id = ?").get(ctx.user.id);
    if (!u) throw new HttpError(404, "NOT_FOUND", "账号不存在");
    if (!verifyPassword(oldPassword, u.pass_salt, u.pass_hash)) {
      logAudit({ user: ctx.user, module: "系统配置", action: "改密失败", target: u.username, detail: "原密码错误", ip: ctx.ip });
      throw new HttpError(400, "BAD_PASSWORD", "原密码不正确");
    }

    const { salt, hash } = hashPassword(next);
    db.prepare("UPDATE users SET pass_salt = ?, pass_hash = ?, token_ver = token_ver + 1 WHERE id = ?").run(salt, hash, u.id);
    db.prepare("DELETE FROM sessions WHERE user_id = ?").run(u.id);

    const s = createSession(u.id, ctx.ip);
    logAudit({ user: ctx.user, module: "系统配置", action: "修改密码", target: u.username, detail: "已失效其它设备登录", ip: ctx.ip });

    return {
      __cookie: cookieHeader(COOKIE, s.token, { maxAge: Math.floor(SESSION_TTL_MS / 1000), secure: ctx.secure }),
      message: "密码已修改，其它设备的登录已失效"
    };
  });

  router.get("/api/auth/me", async (ctx) => {
    if (!ctx.user) return { user: null, demo: isDemoMode() };
    const role = ROLES[ctx.user.role];
    return {
      user: publicUser(ctx.user),
      demo: isDemoMode(),
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
      contractCategories: CONTRACT_CATEGORIES,
      demandStatuses: DEMAND_STATUSES,
      assocs: ASSOCS,
      forms: FORMS,
      depts: DEPTS,
      paymentTypes: PAYMENT_TYPES
    };
  });

  return router;
}

module.exports = { register };
