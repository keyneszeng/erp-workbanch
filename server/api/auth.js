"use strict";
const { db } = require("../lib/db");
const {
  login, publicUser, destroySession, createSession, hashPassword, verifyPassword,
  COOKIE, SESSION_TTL_MS, isThrottled, noteFailure, clearFailures
} = require("../lib/auth");
const { sendJson, cookieHeader } = require("../lib/http");
const { logAudit } = require("../lib/audit");
const { ROLES, MODULES, STATUSES, isSuper, can, PERMS } = require("../lib/rbac");
const { VERIFY_STEPS, MATERIAL_KINDS, CONTRACT_CATEGORIES, DEMAND_STATUSES, ASSOCS, FORMS, DEPTS, PAYMENT_TYPES, FLOW, STATUS_DESC } = require("../lib/constants");
const { bad, HttpError } = require("../lib/util");

/** 常见弱口令：长度够但一眼能猜到的，直接拦掉 */
const WEAK_PASSWORDS = new Set([
  "12345678", "123456789", "1234567890", "password", "password1", "password123",
  "qwerty123", "abc12345", "abcd1234", "admin123", "admin1234", "aa123456",
  "1qaz2wsx", "1q2w3e4r", "iloveyou", "welcome1", "letmein1", "sunshine",
  "88888888", "66666666", "11111111", "00000000"
]);

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
      __cookie: cookieHeader(COOKIE, r.token, { maxAge: Math.floor(SESSION_TTL_MS / 1000) }),
      user: publicUser(r.user),
      role: ROLES[r.user.role]
    };
  });

  router.post("/api/auth/logout", async (ctx) => {
    destroySession(ctx.token);
    return { __cookie: cookieHeader(COOKIE, "", { maxAge: 0 }), ok: true };
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
    const next = String(newPassword);
    if (next.length < 8) throw bad("新密码至少 8 位");
    if (next.length > 64) throw bad("新密码不能超过 64 位");
    if (!/[A-Za-z]/.test(next) || !/\d/.test(next)) throw bad("新密码需同时包含字母和数字");
    if (WEAK_PASSWORDS.has(next.toLowerCase())) throw bad("该密码过于常见，请更换");
    if (next === String(oldPassword)) throw bad("新密码不能与原密码相同");

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
      __cookie: cookieHeader(COOKIE, s.token, { maxAge: Math.floor(SESSION_TTL_MS / 1000) }),
      message: "密码已修改，其它设备的登录已失效"
    };
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
