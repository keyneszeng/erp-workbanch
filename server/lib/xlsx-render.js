"use strict";
/**
 * XLSX → 结构化表格数据，供前端用 <table> 原样渲染（含合并单元格与列宽）。
 *
 * 与「转成 PDF」的区别：PDF 会重新分页、改变表格布局；这里直接读 OOXML 的
 * sheet/cell/mergeCells/cols，把真实的行列结构交给前端还原，不改变原件、不改编排。
 *
 * 安全：不执行宏、公式只取缓存值、不加载外部资源；条目/单元格/文本都有硬上限，
 * 防止恶意大表把 1.7G 的小机器打趴。
 */
const PizZip = require("pizzip");
const { detectOoxml } = require("./ooxml");

const MAX_SHEETS = 20;
const MAX_ROWS = 800;
const MAX_COLS = 60;
const MAX_CELLS = 20000;
const MAX_CELL_TEXT = 2000;
const MAX_PART = 12 * 1024 * 1024;

function entities(text) {
  return String(text || "")
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'");
}
function attribute(attrs, name) {
  return new RegExp("(?:^|\\s)" + name + "\\s*=\\s*([\"'])(.*?)\\1").exec(attrs)?.[2] || "";
}
function richText(xml) {
  const found = [];
  for (const m of String(xml || "").matchAll(/<(?:[A-Za-z_][\w.-]*:)?t\b[^>]*>([\s\S]*?)<\/(?:[A-Za-z_][\w.-]*:)?t>/g))
    found.push(entities(m[1]));
  return found.join("");
}
function colNum(ref) {
  const letters = /^[A-Z]{1,3}/i.exec(String(ref || ""))?.[0]?.toUpperCase() || "";
  let n = 0;
  for (const x of letters) n = n * 26 + x.charCodeAt(0) - 64;
  return n;
}

function invalid(msg) {
  return Object.assign(new Error(msg), { status: 422, code: "XLSX_INVALID" });
}

/** 从 xlsx buffer 解析出表格结构。返回 {sheets:[{name, cols, rows, merges}]} */
function parseXlsxTable(buffer) {
  if (!Buffer.isBuffer(buffer) || !detectOoxml(buffer)) throw invalid("不是有效的 XLSX 文件");
  let zip;
  try { zip = new PizZip(buffer); } catch { throw invalid("XLSX 文件损坏"); }
  const names = Object.keys(zip.files);
  if (!names.includes("xl/workbook.xml")) throw invalid("XLSX 缺少工作簿");
  const read = name => {
    const node = zip.file(name);
    if (!node) return "";
    const raw = node.asText();
    if (raw.length > MAX_PART) throw invalid("工作表过大，无法在线预览");
    return raw;
  };

  // 共享字符串表
  const shared = [];
  for (const m of read("xl/sharedStrings.xml").matchAll(/<(?:\w+:)?si\b[^>]*>([\s\S]*?)<\/(?:\w+:)?si>/g))
    shared.push(richText(m[1]));

  // sheet 名与顺序：workbook.xml 里的 <sheet name r:id>，配合 workbook.xml.rels 映射 rId→target
  const rels = {};
  for (const m of read("xl/_rels/workbook.xml.rels").matchAll(/<Relationship\b([^>]*?)\/>/g)) {
    const id = attribute(m[1], "Id"), target = attribute(m[1], "Target");
    if (id && target) rels[id] = target.replace(/^\//, "");
  }
  const sheetDefs = [];
  for (const m of read("xl/workbook.xml").matchAll(/<(?:\w+:)?sheet\b([^>]*?)\/>/g)) {
    const name = entities(attribute(m[1], "name") || "工作表");
    const rid = attribute(m[1], "r:id") || attribute(m[1], "id");
    let target = rels[rid] || "";
    if (target && !target.startsWith("xl/")) target = "xl/" + target.replace(/^worksheets\//, "worksheets/");
    sheetDefs.push({ name, path: target });
  }
  if (!sheetDefs.length) throw invalid("工作簿没有可预览的工作表");

  const sheets = [];
  for (const def of sheetDefs.slice(0, MAX_SHEETS)) {
    // 兜底：若 rels 解析不到，按序号猜 worksheets/sheetN.xml
    const path = def.path && zip.files[def.path] ? def.path :
      "xl/worksheets/sheet" + (sheets.length + 1) + ".xml";
    const xml = read(path);
    if (!xml) continue;

    // 列宽（可选）
    const cols = [];
    for (const m of xml.matchAll(/<(?:\w+:)?col\b([^>]*?)\/>/g)) {
      const min = Number(attribute(m[1], "min")) || 0;
      const width = Number(attribute(m[1], "width")) || 0;
      if (min > 0 && min <= MAX_COLS) cols.push({ col: min, width: Math.round(width * 7) });
    }

    // 合并单元格：A1:C2 → {r:1,c:1,rs:2,cs:3}
    const merges = [];
    const mergeBlock = /<(?:\w+:)?mergeCells\b[^>]*>([\s\S]*?)<\/(?:\w+:)?mergeCells>/.exec(xml)?.[1] || "";
    for (const m of mergeBlock.matchAll(/<(?:\w+:)?mergeCell\b[^>]*?ref="([^"]+)"/g)) {
      const [a, b] = String(m[1]).split(":");
      const refA = /^([A-Z]+)(\d+)$/i.exec(a || ""), refB = /^([A-Z]+)(\d+)$/i.exec(b || a || "");
      if (!refA || !refB) continue;
      const r = Number(refA[2]), c = colNum(refA[1]);
      const rs = Number(refB[2]) - r + 1, cs = colNum(refB[1]) - c + 1;
      if (r > 0 && c > 0 && rs > 0 && cs > 0) merges.push({ r, c, rs, cs });
    }

    // 单元格：行/列/值/对齐/粗体（只取最基础的呈现信息）
    const cells = [];
    let cellCount = 0, fallbackRow = 1;
    for (const row of xml.matchAll(/<(?:\w+:)?row\b([^>]*?)>([\s\S]*?)<\/(?:\w+:)?row>/g)) {
      const rowNo = Number(attribute(row[1], "r")) || fallbackRow;
      fallbackRow = rowNo + 1;
      if (rowNo > MAX_ROWS) break;
      let seq = 0;
      const re = /<(?:\w+:)?c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/(?:\w+:)?c>)/g;
      for (const c of row[2].matchAll(re)) {
        if (++cellCount > MAX_CELLS) break;
        const body = c[2] || "", ref = attribute(c[1], "r");
        const col = colNum(ref) || ++seq;
        if (col > MAX_COLS) continue;
        const type = attribute(c[1], "t");
        const v = /<(?:\w+:)?v\b[^>]*>([\s\S]*?)<\/(?:\w+:)?v>/.exec(body)?.[1];
        let value = "";
        if (type === "s") {
          const idx = Number(v);
          if (Number.isSafeInteger(idx) && idx >= 0 && idx < shared.length) value = shared[idx];
        } else if (type === "inlineStr") {
          value = richText(/<(?:\w+:)?is\b[^>]*>([\s\S]*?)<\/(?:\w+:)?is>/.exec(body)?.[1] || body);
        } else if (type !== "e") {
          value = v !== undefined ? entities(v) : richText(body);
        }
        value = String(value || "").replace(/[\r\n\t]+/g, " ").trim();
        if (value.length > MAX_CELL_TEXT) value = value.slice(0, MAX_CELL_TEXT) + "…";
        cells.push({
          r: rowNo, c: col, v: value,
          t: type === "s" || type === "inlineStr" || type === "str" ? "s" : "n"
        });
      }
      if (cellCount > MAX_CELLS) break;
    }

    let maxRow = 0, maxCol = 0;
    for (const x of cells) { if (x.r > maxRow) maxRow = x.r; if (x.c > maxCol) maxCol = x.c; }
    for (const m of merges) {
      if (m.r + m.rs - 1 > maxRow) maxRow = m.r + m.rs - 1;
      if (m.c + m.cs - 1 > maxCol) maxCol = m.c + m.cs - 1;
    }
    maxRow = Math.min(MAX_ROWS, maxRow);
    maxCol = Math.min(MAX_COLS, maxCol);
    sheets.push({ name: def.name, rows: maxRow, colsCount: maxCol, widths: cols, merges, cells });
  }
  return { sheets };
}

module.exports = { parseXlsxTable, MAX_SHEETS, MAX_ROWS, MAX_COLS };
