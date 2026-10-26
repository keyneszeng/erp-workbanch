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

/**
 * 生成业务单号：MP-2026-019 / PY-2026-041
 *
 * 序号一律取「最后一个 - 之后」的整段数字。
 * 不能用 slice(-width)：序号一旦超过 999（如 HT-2026-1000），
 * slice(-3) 会得到 "000"，max 回退成 999，于是又生成 HT-2026-1000，
 * 与已存在的记录撞号并触发 UNIQUE 约束，接口直接 500。
 * 付款单一年上千笔对协会是常态，这个坑必须堵。
 */
function nextId(db, table, column, prefix, width = 3) {
  const year = new Date().getFullYear();
  const like = `${prefix}-${year}-%`;
  const rows = db.prepare(`SELECT ${column} AS id FROM ${table} WHERE ${column} LIKE ?`).all(like);
  let max = 0;
  for (const r of rows) {
    const n = parseInt(String(r.id).split("-").pop(), 10);
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

/** CSV 单元格：双引号转义 + 公式注入中和（= + - @ 制表符 回车 开头加 ' 前缀） */
function csvCell(v) {
  let s = String(v ?? "");
  if (typeof v === "string" && /^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return `"${s.replace(/"/g, '""')}"`;
}

/** CSV 序列化：带 BOM、CRLF、双引号转义 */
function toCsv(headers, rows) {
  const lines = [headers.map(csvCell).join(",")];
  for (const r of rows) lines.push(r.map(csvCell).join(","));
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

module.exports = { now, today, nowIso, nextId, randToken, money, toCsv, csvCell, HttpError, bad, forbidden, notFound, conflict, pad };
