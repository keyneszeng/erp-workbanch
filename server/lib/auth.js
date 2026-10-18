"use strict";
const crypto = require("node:crypto");
const { db } = require("./db");
const { now, randToken } = require("./util");

const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12 小时
const COOKIE = "erp_sid";

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

function createSession(userId, ip) {
  const token = randToken(32);
  const created = new Date();
  const expires = new Date(created.getTime() + SESSION_TTL_MS);
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
  return row || null;
}

function publicUser(u) {
  if (!u) return null;
  return { id: u.id, username: u.username, name: u.name, role: u.role, assoc: u.assoc, dept: u.dept, phone: u.phone, title: u.title };
}

function login(username, password, ip) {
  const u = db.prepare("SELECT * FROM users WHERE username = ? AND active = 1").get(String(username || ""));
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
  hashPassword, verifyPassword, createSession, destroySession, userByToken, publicUser, login,
  pruneSessions, COOKIE, SESSION_TTL_MS, isThrottled, noteFailure, clearFailures
};
