"use strict";
/**
 * 列表分页 —— 纯函数，不碰数据库，由各接口自行拼 LIMIT / OFFSET。
 *
 * 设计原则：**不传 page 就返回全量**。
 * 这样旧前端、旧脚本、旧测试的行为完全不变，分页是「按需启用」的增强，
 * 而不是一次会打破兼容性的行为变更。
 */

const DEFAULT_SIZE = 50;
const MAX_SIZE = 200;

/**
 * 解析 query 里的分页参数。
 * @returns {null | {page:number,size:number,offset:number}} 未请求分页时返回 null
 */
function readPaging(query = {}) {
  const raw = query.page;
  if (raw === undefined || raw === null || String(raw).trim() === "") return null;

  let page = Number.parseInt(raw, 10);
  if (!Number.isFinite(page) || page < 1) page = 1;

  let size = Number.parseInt(query.size, 10);
  if (!Number.isFinite(size) || size < 1) size = DEFAULT_SIZE;
  if (size > MAX_SIZE) size = MAX_SIZE;

  return { page, size, offset: (page - 1) * size };
}

/**
 * 组装返回体。rows 由调用方按 paging 取好。
 * 不分页时 total 等于实际行数，pages 恒为 1，paged=false，
 * 前端据此决定是否渲染分页条。
 */
function pageOf(rows, total, paging) {
  if (!paging) {
    return { rows, total: rows.length, page: 1, size: rows.length, pages: 1, paged: false };
  }
  const safeTotal = Number(total) || 0;
  return {
    rows,
    total: safeTotal,
    page: paging.page,
    size: paging.size,
    pages: Math.max(1, Math.ceil(safeTotal / paging.size)),
    paged: true
  };
}

/** 取 COUNT 结果里的数字（列名兼容 c / n / count） */
function countOf(row) {
  if (!row) return 0;
  const v = row.c ?? row.n ?? row.count ?? Object.values(row)[0];
  return Number(v) || 0;
}

module.exports = { readPaging, pageOf, countOf, DEFAULT_SIZE, MAX_SIZE };
