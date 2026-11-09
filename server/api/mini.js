"use strict";
/**
 * Production-only WeChat Mini Program bridge.
 * wx.login code is exchanged server-side: never send AppSecret/session_key to a client.
 * First bind: whitelisted phone + password + SMS OTP + WeChat code.
 * Existing binding: wx.login code -> server-side OpenID -> same session DB as Web.
 * All ERP business routes reuse central role, project scope and force-password gates.
 */
const crypto=require("node:crypto");
const { db, transaction } = require("../lib/db");
const { isDemoMode } = require("../lib/runtime");
const { normalizePhone } = require("../lib/phone-whitelist");
const { sendPasswordCode, consumePasswordCode } = require("../lib/sms");
const { createSession, destroySession, hashPassword, verifyPassword, validatePassword,
  publicUser, isThrottled, noteFailure, clearFailures, SESSION_TTL_MS } = require("../lib/auth");
const { logAudit } = require("../lib/audit");
const { ROLES, can, PERMS, MODULES, hasModule } = require("../lib/rbac");
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
// WeChat phone authorization uses a separate, short-lived code from getPhoneNumber.
// This code must be redeemed server-side; a client-supplied phone string is NOT proof.
let cachedAccessToken="", accessTokenExpires=0;
async function wechatAccessToken(){
 const c=credentials();
 if(c.test)return "test";
 if(cachedAccessToken&&Date.now()<accessTokenExpires)return cachedAccessToken;
 let data;
 try{
  const url=new URL("https://api.weixin.qq.com/cgi-bin/token");
  url.searchParams.set("grant_type","client_credential");
  url.searchParams.set("appid",c.appid);url.searchParams.set("secret",c.secret);
  const response=await fetch(url,{signal:AbortSignal.timeout(7000)});
  if(!response.ok)throw new Error("access token unavailable");
  data=await response.json();
 }catch{throw new HttpError(503,"WECHAT_UNAVAILABLE","微信手机号服务暂不可用");}
 if(data.errcode||!data.access_token)throw new HttpError(503,"WECHAT_UNAVAILABLE","微信手机号服务未正确配置");
 cachedAccessToken=data.access_token;
 accessTokenExpires=Date.now()+Math.max(60,(Number(data.expires_in)||7200)-300)*1000;
 return cachedAccessToken;
}
async function exchangePhoneCode(value){
 const code=String(value||"");
 if(!/^[a-zA-Z0-9_-]{6,128}$/.test(code))throw bad("微信手机号授权凭证无效");
 const c=credentials();
 if(c.test){
  if(!/^phone_test_1[3-9]\\d{9}$/.test(code))throw new HttpError(401,"WECHAT_PHONE_INVALID","手机号授权失效");
  return normalizePhone(code.slice("phone_test_".length));
 }
 const token=await wechatAccessToken();
 let data;
 try{
  const response=await fetch("https://api.weixin.qq.com/wxa/business/getuserphonenumber?access_token="+encodeURIComponent(token),{
   method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({code}),
   signal:AbortSignal.timeout(7000)
  });
  if(!response.ok)throw new Error("phone unavailable");
  data=await response.json();
 }catch{throw new HttpError(503,"WECHAT_UNAVAILABLE","微信手机号核验暂不可用");}
 if(data.errcode!==0||!data.phone_info?.purePhoneNumber)
  throw new HttpError(401,"WECHAT_PHONE_INVALID","微信手机号授权已失效，请重新授权");
 if(String(data.phone_info.countryCode)!=="86")
  throw bad("当前仅支持绑定中国大陆手机号");
 return normalizePhone(data.phone_info.purePhoneNumber);
}
function boundUser(openid){
 return db.prepare("SELECT u.* FROM mini_bindings b JOIN users u ON u.id=b.user_id WHERE b.openid=? AND u.active=1").get(openid);
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
function sessionRole(user) {
  return { ...ROLES[user.role], modules: MODULES.filter(m=>hasModule(user,m.k)).map(m=>m.k) };
}
function session(user, ip) {
  const s = createSession(user.id, ip);
  return { accessToken: s.token, expiresIn: Math.floor(SESSION_TTL_MS / 1000),
    user: publicUser(user), role: sessionRole(user),
    perms: Object.keys(PERMS).filter(k => can(user, k)) };
}
function register(router) {
  router.post("/api/mini/auth/sms/send", async ctx => {
    requireEnabled();
    const { phone, password } = ctx.body || {};
    const user = account(phone, password, ctx.ip);
    return sendPasswordCode(user);
  });
  // First-time phone authorization: match an existing active system account by
  // trusted WeChat phone, otherwise create an unprivileged ordinary user.
  router.post("/api/mini/auth/phone-bind",async ctx=>{
    requireEnabled();
    const {code,phoneCode}=ctx.body||{};
    // WeChat identity and phone credentials are both redeemed server-side.
    const openid=await exchangeCode(code);
    const phone=await exchangePhoneCode(phoneCode);
    const existing=boundUser(openid);
    if(existing){
      if(existing.phone!==phone)throw new HttpError(409,"WECHAT_ALREADY_BOUND","微信已绑定其他手机号，请联系管理员");
      return session(existing,ctx.ip);
    }
    const at=new Date().toISOString();
    let user;
    try{
      transaction(()=>{
        user=db.prepare("SELECT * FROM users WHERE phone=?").get(phone);
        if(user&&!user.active)throw new HttpError(403,"ACCOUNT_DISABLED","该手机号对应系统账号已停用，请联系管理员");
        if(!user){
          const random=hashPassword(crypto.randomBytes(32).toString("hex"));
          const username="mini_"+crypto.randomBytes(12).toString("hex");
          db.prepare("INSERT INTO users (username,name,role,assoc,dept,phone,pass_salt,pass_hash,active,created_at,must_change_password,phone_verified_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)")
           .run(username,"普通用户","user",null,null,phone,random.salt,random.hash,1,at,0,at);
          user=db.prepare("SELECT * FROM users WHERE username=?").get(username);
        }
        const owned=db.prepare("SELECT openid FROM mini_bindings WHERE user_id=?").get(user.id);
        if(owned&&owned.openid!==openid)
          throw new HttpError(409,"WECHAT_ALREADY_BOUND","该系统手机号已绑定其他微信账号，请联系管理员");
        db.prepare("INSERT INTO mini_bindings(openid,user_id,bound_at) VALUES (?,?,?)").run(openid,user.id,at);
        db.prepare("UPDATE users SET phone_verified_at=? WHERE id=?").run(at,user.id);
      });
    }catch(e){
      if(e instanceof HttpError)throw e;
      if(/UNIQUE|constraint/i.test(String(e.message)))throw new HttpError(409,"WECHAT_ALREADY_BOUND","绑定关系已发生变化，请重新登录");
      throw e;
    }
    const fresh=db.prepare("SELECT * FROM users WHERE id=? AND active=1").get(user.id);
    logAudit({user:fresh,module:"系统配置",action:"小程序手机号首次绑定",target:String(fresh.id),
      detail:fresh.role==="user"?"已验证手机号并绑定普通用户":"已验证手机号并关联系统白名单账号",ip:ctx.ip});
    return session(fresh,ctx.ip);
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
    if (!user) throw new HttpError(401, "WECHAT_UNBOUND", "首次登录请授权手机号，系统将自动匹配账号权限");
    logAudit({ user, module: "系统配置", action: "小程序登录", target: String(user.id),
      detail: "微信已绑定身份登录", ip: ctx.ip });
    return session(user, ctx.ip);
  });
  router.get("/api/mini/auth/me", async ctx => {
    requireEnabled();
    return { user: publicUser(ctx.user), role: sessionRole(ctx.user),
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
