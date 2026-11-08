"use strict";
const crypto = require("node:crypto");
const { db } = require("./db");
const { now, randToken, bad } = require("./util");
const { isDemoMode } = require("./runtime");

const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12 小时
const COOKIE = "erp_sid";

/**
 * 会话令牌采用「签名令牌 + 会话表」双轨：
 * - 会话表用于本实例的审计与主动登出；
 * - 签名令牌保证跨实例可用（Serverless 每个实例的 /tmp 各自独立，
 *   只靠会话表会导致换实例后全体 401）。
 * 吊销：users.token_ver + 1，令牌里的 ver 对不上即失效。
 */
const SECRET = process.env.ERP_SECRET || crypto.randomBytes(32).toString("hex");

/**
 * 跨实例兜底开关：
 * - 本地 / 单机部署（默认关闭）：严格以 sessions 表为准，登出、过期立即失效；
 * - Serverless（api/index.js 置 1）：会话表只在本实例有效，必须靠签名令牌兜底，
 *   否则实例一换就全体 401。代价是登出只在签发实例生效（前端会同步清 Cookie）。
 */
const STATELESS_FALLBACK = process.env.ERP_SESSION_FALLBACK === "1";

function signToken(uid, exp, ver) {
  return crypto
    .createHmac("sha256", SECRET)
    .update(`${uid}.${exp}.${ver}`)
    .digest("base64url")
    .slice(0, 32);
}

function parseToken(token) {
  const parts = String(token || "").split(".");
  if (parts.length !== 5 || parts[0] !== "v1") return null;
  const uid = Number(parts[1]);
  const exp = Number(parts[2]);
  const ver = Number(parts[3]);
  if (!Number.isInteger(uid) || !Number.isInteger(exp) || !Number.isInteger(ver)) return null;
  if (exp <= Date.now()) return null;
  const want = signToken(uid, exp, ver);
  const got = parts[4];
  if (want.length !== got.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(want), Buffer.from(got))) return null;
  return { uid, exp, ver };
}

function hashPassword(password, salt = randToken(16)) {
  const hash = crypto.scryptSync(String(password), salt, 64).toString("hex");
  return { salt, hash };
}

function verifyPassword(password, salt, hash) {
  const calc = crypto.scryptSync(String(password), salt, 64).toString("hex");
  const a = Buffer.from(calc, "hex");
  const b = Buffer.from(String(hash), "hex");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** 常见弱口令：长度够但一眼能猜到的，直接拦掉 */
const WEAK_PASSWORDS = new Set([
  "12345678", "123456789", "1234567890", "password", "password1", "password123",
  "qwerty123", "abc12345", "abcd1234", "admin123", "admin1234", "aa123456",
  "1qaz2wsx", "1q2w3e4r", "iloveyou", "welcome1", "letmein1", "sunshine",
  "88888888", "66666666", "11111111", "00000000"
]);

/**
 * 口令强度校验 —— 建号、重置、自助改密**共用这一份**。
 *
 * 测试报告 SEC-04：建号接受 3 位纯数字 `123`，而自助改密要求 8 位 ——
 * 同一套系统两种策略，等于「改密严、建号松」，弱口令账号批量产生。
 * 校验原来写在改密 handler 里，别处想用只能抄一遍，抄着抄着就抄漏了。
 *
 * @param {string} pw
 * @param {{ oldPassword?: string, label?: string }} opt
 *        oldPassword：自助改密时传原密码，用于「不能与原密码相同」的判断
 *        label：错误文案里的字段名（默认「密码」）
 */
function validatePassword(pw, { oldPassword, label = "密码" } = {}) {
  const s = String(pw ?? "");
  if (!s) throw bad(`请设置${label}`);
  if (s.length < 8) throw bad(`${label}至少 8 位`);
  if (s.length > 64) throw bad(`${label}不能超过 64 位`);
  if (!/[A-Za-z]/.test(s) || !/\d/.test(s)) throw bad(`${label}需同时包含字母和数字`);
  if (WEAK_PASSWORDS.has(s.toLowerCase())) throw bad("该密码过于常见，请更换");
  if (oldPassword !== undefined && s === String(oldPassword)) throw bad("新密码不能与原密码相同");
  return s;
}

function createSession(userId, ip) {
  const created = new Date();
  const expires = new Date(created.getTime() + SESSION_TTL_MS);
  const ver = db.prepare("SELECT token_ver FROM users WHERE id = ?").get(userId)?.token_ver ?? 0;
  const exp = expires.getTime();
  const token = `v1.${userId}.${exp}.${ver}.${signToken(userId, exp, ver)}`;
  db.prepare("INSERT INTO sessions (token, user_id, created_at, expires_at, ip) VALUES (?,?,?,?,?)").run(
    token, userId, now(created), expires.toISOString(), ip || ""
  );
  return { token, expires };
}

function destroySession(token) {
  if (token) db.prepare("DELETE FROM sessions WHERE token = ?").run(token);
}

function userByToken(token) {
  if (!token) return null;
  const row = db
    .prepare(
      `SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token = ? AND s.expires_at > ? AND u.active = 1`
    )
    .get(token, new Date().toISOString());
  if (row) return row;

  // 跨实例兜底：本实例会话表没有这条记录（另一个实例签发的），改用签名校验
  if (!STATELESS_FALLBACK) return null;
  const p = parseToken(token);
  if (!p) return null;
  return db
    .prepare("SELECT * FROM users WHERE id = ? AND active = 1 AND token_ver = ?")
    .get(p.uid, p.ver) || null;
}

function publicUser(u) {
  if (!u) return null;
  return { id: u.id, username: u.username, name: u.name, role: u.role, assoc: u.assoc, dept: u.dept, phone: u.phone, title: u.title, mustChangePassword: !isDemoMode() && !!u.must_change_password };
}

function login(username, password, ip) {
  const u = isDemoMode()
    ? db.prepare("SELECT * FROM users WHERE username = ? AND active = 1").get(String(username || ""))
    : db.prepare("SELECT * FROM users WHERE phone = ? AND active = 1").get(String(username || "").trim());
  if (!u || !verifyPassword(password, u.pass_salt, u.pass_hash)) return null;
  const { token, expires } = createSession(u.id, ip);
  return { user: u, token, expires };
}

function pruneSessions() {
  db.prepare("DELETE FROM sessions WHERE expires_at <= ?").run(new Date().toISOString());
}

/* ---------------- 登录失败限流（内存级，单实例够用） ---------------- */
const WINDOW_MS = 5 * 60 * 1000;
const MAX_FAILS = 5;
const fails = new Map(); // key -> { count, first }

function throttleKey(ip, username) {
  return `${ip || "-"}|${String(username || "").toLowerCase()}`;
}
function isThrottled(ip, username) {
  const k = throttleKey(ip, username);
  const rec = fails.get(k);
  if (!rec) return false;
  if (Date.now() - rec.first > WINDOW_MS) { fails.delete(k); return false; }
  return rec.count >= MAX_FAILS;
}
function noteFailure(ip, username) {
  const k = throttleKey(ip, username);
  const rec = fails.get(k);
  if (!rec || Date.now() - rec.first > WINDOW_MS) fails.set(k, { count: 1, first: Date.now() });
  else rec.count += 1;
  if (fails.size > 5000) fails.clear(); // 防内存膨胀
}
function clearFailures(ip, username) {
  fails.delete(throttleKey(ip, username));
}

module.exports = {
  hashPassword, verifyPassword, validatePassword, WEAK_PASSWORDS,
  createSession, destroySession, userByToken, publicUser, login,
  pruneSessions, COOKIE, SESSION_TTL_MS, isThrottled, noteFailure, clearFailures
};
