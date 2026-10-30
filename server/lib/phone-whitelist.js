"use strict";
const { bad, conflict } = require("./util");
const { db } = require("./db");
const { isDemoMode } = require("./runtime");

const INITIAL_PASSWORD = "123456";
function normalizePhone(value) {
  const s = String(value ?? "").trim();
  if (!/^1[3-9]\d{9}$/.test(s)) throw bad("请输入有效的中国大陆 11 位手机号码");
  return s;
}
function ensureAvailable(phone, excludeId = 0) {
  if (db.prepare("SELECT id FROM users WHERE phone = ? AND id <> ?").get(phone, excludeId)) {
    throw conflict("该手机号码已经在白名单中");
  }
}
function enforceRootAdmin(user) {
  if (!isDemoMode() && user.role !== "admin") throw bad("生产环境只允许部署时指定的总管理员管理白名单");
}
module.exports = { INITIAL_PASSWORD, normalizePhone, ensureAvailable, enforceRootAdmin };
