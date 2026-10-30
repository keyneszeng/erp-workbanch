"use strict";
/**
 * Production-only WeChat Mini Program bridge.
 * wx.login code is exchanged server-side: never send AppSecret/session_key to a client.
 * First bind: whitelisted phone + password + SMS OTP + WeChat code.
 * Existing binding: wx.login code -> server-side OpenID -> same session DB as Web.
 * All ERP business routes reuse central role, project scope and force-password gates.
 */
const { db, transaction } = require("../lib/db");
const { isDemoMode } = require("../lib/runtime");
const { normalizePhone } = require("../lib/phone-whitelist");
const { sendPasswordCode, consumePasswordCode } = require("../lib/sms");
const { createSession, destroySession, hashPassword, verifyPassword, validatePassword,
  publicUser, isThrottled, noteFailure, clearFailures, SESSION_TTL_MS } = require("../lib/auth");
const { logAudit } = require("../lib/audit");
const { ROLES, can, PERMS } = require("../lib/rbac");
const { HttpError, bad } = require("../lib/util");

function enabled() {
  return !isDemoMode() && process.env.ERP_MINIPROGRAM_ENABLED === "1";
}
function requireEnabled() {
  if (!enabled()) throw new HttpError(404, "MINI_DISABLED", "微信小程序员工入口尚未启用");
}
function credentials() {
  const appid = process.env.ERP_WECHAT_APP_ID || "";
  const secret = process.env.ERP_WECHAT_APP_SECRET || "";
  if (process.env.NODE_ENV === "test" && process.env.ERP_WECHAT_TEST_MODE === "1")
    return { test: true };
  if (!/^wx[0-9a-f]{16}$/i.test(appid) || !secret)
    throw new HttpError(503, "WECHAT_NOT_CONFIGURED", "微信小程序尚未配置有效 AppID 与 AppSecret");
  return { appid, secret };
}
async function exchangeCode(value) {
  const code = String(value || "");
  if (!/^[a-zA-Z0-9_-]{6,128}$/.test(code)) throw bad("微信登录凭证无效，请重新登录");
  const c = credentials();
  if (c.test) {
    if (!/^test_[a-z0-9_-]{5,60}$/.test(code)) throw new HttpError(401, "WECHAT_CODE_INVALID", "微信登录凭证无效");
    return "test-openid-" + code.slice(5);
  }
  const url = new URL("https://api.weixin.qq.com/sns/jscode2session");
  url.searchParams.set("appid", c.appid);
  url.searchParams.set("secret", c.secret);
  url.searchParams.set("js_code", code);
  url.searchParams.set("grant_type", "authorization_code");
  let data;
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(7000) });
    if (!response.ok) throw new Error("HTTP " + response.status);
    data = await response.json();
  } catch {
    throw new HttpError(503, "WECHAT_UNAVAILABLE", "微信身份服务暂不可用，请稍后重试");
  }
  // Never log or expose the sensitive session_key, even on provider errors.
  if (data.errcode || typeof data.openid !== "string" || !data.openid || data.openid.length > 128)
    throw new HttpError(401, "WECHAT_CODE_INVALID", "微信登录已过期，请重新授权");
  return data.openid;
}
function account(phone, password, ip) {
  const normalized = normalizePhone(phone);
  if (isThrottled(ip, normalized))
    throw new HttpError(429, "TOO_MANY_ATTEMPTS", "登录失败次数过多，请 5 分钟后再试");
  const user = db.prepare("SELECT * FROM users WHERE phone = ? AND active = 1").get(normalized);
  if (!user || !verifyPassword(password || "", user.pass_salt, user.pass_hash)) {
    noteFailure(ip, normalized);
    throw new HttpError(401, "INVALID_CREDENTIALS", "账号或密码错误");
  }
  clearFailures(ip, normalized);
  return user;
}
function session(user, ip) {
  const s = createSession(user.id, ip);
  return { accessToken: s.token, expiresIn: Math.floor(SESSION_TTL_MS / 1000),
    user: publicUser(user), role: ROLES[user.role],
    perms: Object.keys(PERMS).filter(k => can(user, k)) };
}
function register(router) {
  router.post("/api/mini/auth/sms/send", async ctx => {
    requireEnabled();
    const { phone, password } = ctx.body || {};
    const user = account(phone, password, ctx.ip);
    return sendPasswordCode(user);
  });
  router.post("/api/mini/auth/bind", async ctx => {
    requireEnabled();
    const { code, phone, password, smsCode, newPassword } = ctx.body || {};
    const user = account(phone, password, ctx.ip);
    const openid = await exchangeCode(code);
    const existing = db.prepare("SELECT user_id FROM mini_bindings WHERE openid = ?").get(openid);
    const owned = db.prepare("SELECT openid FROM mini_bindings WHERE user_id = ?").get(user.id);
    if ((existing && existing.user_id !== user.id) || (owned && owned.openid !== openid))
      throw new HttpError(409, "WECHAT_ALREADY_BOUND", "微信账号或手机号已经绑定，如需更换请联系管理员");
    const next = user.must_change_password
      ? validatePassword(newPassword, { oldPassword: password, label: "新密码" })
      : null;
    // Incorrect attempts must persist, not roll back with the business transaction.
    consumePasswordCode(user, smsCode);
    transaction(() => {
      if (!existing) {
        db.prepare("INSERT INTO mini_bindings(openid,user_id,bound_at) VALUES (?,?,?)")
          .run(openid, user.id, new Date().toISOString());
      }
      if (next) {
        const hp = hashPassword(next);
        db.prepare("UPDATE users SET pass_salt=?,pass_hash=?,must_change_password=0,phone_verified_at=?,token_ver=token_ver+1 WHERE id=?")
          .run(hp.salt, hp.hash, new Date().toISOString(), user.id);
        db.prepare("DELETE FROM sessions WHERE user_id=?").run(user.id);
      } else {
        db.prepare("UPDATE users SET phone_verified_at=? WHERE id=?").run(new Date().toISOString(), user.id);
      }
    });
    const fresh = db.prepare("SELECT * FROM users WHERE id = ?").get(user.id);
    logAudit({ user: fresh, module: "系统配置", action: "小程序绑定", target: String(fresh.id),
      detail: "手机号短信验证成功，已建立微信身份关联", ip: ctx.ip });
    return session(fresh, ctx.ip);
  });
  router.post("/api/mini/auth/login", async ctx => {
    requireEnabled();
    const openid = await exchangeCode((ctx.body || {}).code);
    const user = db.prepare(
      "SELECT u.* FROM mini_bindings b JOIN users u ON b.user_id=u.id WHERE b.openid=? AND u.active=1"
    ).get(openid);
    if (!user) throw new HttpError(401, "WECHAT_UNBOUND", "微信尚未绑定白名单手机号，请先完成身份绑定");
    logAudit({ user, module: "系统配置", action: "小程序登录", target: String(user.id),
      detail: "微信已绑定身份登录", ip: ctx.ip });
    return session(user, ctx.ip);
  });
  router.get("/api/mini/auth/me", async ctx => {
    requireEnabled();
    return { user: publicUser(ctx.user), role: ROLES[ctx.user.role],
      perms: Object.keys(PERMS).filter(k => can(ctx.user, k)) };
  });
  router.post("/api/mini/auth/sms/send-password", async ctx => {
    requireEnabled();
    return sendPasswordCode(db.prepare("SELECT * FROM users WHERE id=? AND active=1").get(ctx.user.id));
  });
  router.post("/api/mini/auth/password", async ctx => {
    requireEnabled();
    const { oldPassword, newPassword, smsCode } = ctx.body || {};
    const user = db.prepare("SELECT * FROM users WHERE id=? AND active=1").get(ctx.user.id);
    if (!user || !verifyPassword(oldPassword || "", user.pass_salt, user.pass_hash))
      throw new HttpError(400, "BAD_PASSWORD", "原密码不正确");
    const next = validatePassword(newPassword, { oldPassword, label: "新密码" });
    // Preserve SMS failure counters even when verification fails.
    consumePasswordCode(user, smsCode);
    transaction(() => {
      const hp = hashPassword(next);
      db.prepare("UPDATE users SET pass_salt=?,pass_hash=?,must_change_password=0,phone_verified_at=?,token_ver=token_ver+1 WHERE id=?")
        .run(hp.salt, hp.hash, new Date().toISOString(), user.id);
      db.prepare("DELETE FROM sessions WHERE user_id=?").run(user.id);
    });
    const fresh = db.prepare("SELECT * FROM users WHERE id=?").get(user.id);
    logAudit({ user: fresh, module: "系统配置", action: "小程序修改密码", target: String(fresh.id),
      detail: "已吊销该用户所有旧会话", ip: ctx.ip });
    return session(fresh, ctx.ip);
  });
  router.post("/api/mini/auth/logout", async ctx => {
    requireEnabled();
    destroySession(ctx.token);
    return { ok: true };
  });
}
module.exports = { register, exchangeCode };
