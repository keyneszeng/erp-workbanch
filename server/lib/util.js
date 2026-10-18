"use strict";
const crypto = require("node:crypto");

const pad = (n) => String(n).padStart(2, "0");

function now(d = new Date()) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function today(d = new Date()) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
function nowIso() {
  return new Date().toISOString();
}

/** 生成业务单号：MP-2026-019 / PY-2026-041 */
function nextId(db, table, column, prefix, width = 3) {
  const year = new Date().getFullYear();
  const like = `${prefix}-${year}-%`;
  const rows = db.prepare(`SELECT ${column} AS id FROM ${table} WHERE ${column} LIKE ?`).all(like);
  let max = 0;
  for (const r of rows) {
    const n = parseInt(String(r.id).slice(-width), 10);
    if (!Number.isNaN(n) && n > max) max = n;
  }
  return `${prefix}-${year}-${String(max + 1).padStart(width, "0")}`;
}

function randToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString("hex");
}

function money(n) {
  return Number(n || 0).toLocaleString("zh-CN");
}

/** CSV 序列化：带 BOM、CRLF、双引号转义 */
function toCsv(headers, rows) {
  const esc = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const lines = [headers.map(esc).join(",")];
  for (const r of rows) lines.push(r.map(esc).join(","));
  return "\ufeff" + lines.join("\r\n");
}

class HttpError extends Error {
  constructor(status, code, message, extra) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}
const bad = (msg, code = "BAD_REQUEST") => new HttpError(400, code, msg);
const forbidden = (msg = "当前角色无权执行该操作", code = "FORBIDDEN") => new HttpError(403, code, msg);
const notFound = (msg = "对象不存在", code = "NOT_FOUND") => new HttpError(404, code, msg);
const conflict = (msg, code = "CONFLICT", extra) => new HttpError(409, code, msg, extra);

module.exports = { now, today, nowIso, nextId, randToken, money, toCsv, HttpError, bad, forbidden, notFound, conflict, pad };
