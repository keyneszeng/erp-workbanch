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

/**
 * 金额定点：一律换算成「分」再运算。
 *
 * 金额入库是 REAL（两位小数），但浮点加法会留下尾巴：
 *   1234.56 + 2345.67 = 3580.2300000000005
 *   140000 - 135580.6 = 4419.399999999994
 * 后果不是「显示难看」这么轻：
 *   1. 结算单 profit 直接带着 12 位小数入库，导出 CSV 就是 4419.399999999994；
 *   2. 预算门禁 `已占用 + 本笔 > 预算` 会把「正好用尽」判成超预算，
 *      实测预算 5389.78、已用 2789.69、本笔 2600.09 被拒，超预算 ¥0.0000000000000009；
 *   3. 预算下调到「刚好等于已占用」也被拒（3580.23 < 3580.2300000000005）。
 * 所有金额的比较与汇总都过一遍 cents()，展示与入库走 yuan()。
 */
function cents(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return 0;
  return Math.round(v * 100);
}

/** 把任意金额收敛到「分」，返回两位小数以内的数值 */
function yuan(n) {
  return cents(n) / 100;
}

/**
 * 银行账号校验 —— 付款与结算共用。
 *
 * 为什么要单独一个函数：付款、结算单两处都要登记收款账户，规则必须一致，
 * 否则同一笔钱在两张单子上一个能存一个不能存，财务对账时对不上。
 *
 * 规则：去掉空格与短横后必须是 10~25 位纯数字。
 * 不放宽到「随便什么字符」——账号写错一位就打给别人了，宁可让录入的人多看一眼。
 * 也不卡死 16/19 位：对公账户、存折、农商行号段长度并不统一。
 */
function parseBankAccount(v, label = "银行账号") {
  const raw = String(v ?? "").trim();
  if (!raw) throw bad(`${label}为必填项`);
  const digits = raw.replace(/[\s-]/g, "");
  if (!/^\d+$/.test(digits)) throw bad(`${label}只能是数字（可含空格或短横分隔）`);
  if (digits.length < 10 || digits.length > 25) {
    throw bad(`${label}应为 10~25 位数字（当前 ${digits.length} 位）`);
  }
  return digits;
}

/** 开户行校验：必填，2~40 字 */
function parseBankName(v, label = "开户行") {
  const s = String(v ?? "").trim();
  if (!s) throw bad(`${label}为必填项`);
  if (s.length < 2) throw bad(`${label}至少 2 个字`);
  if (s.length > 40) throw bad(`${label}不能超过 40 字`);
  return s;
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

module.exports = { now, today, nowIso, nextId, randToken, money, cents, yuan, toCsv, csvCell, parseBankAccount, parseBankName, HttpError, bad, forbidden, notFound, conflict, pad };
