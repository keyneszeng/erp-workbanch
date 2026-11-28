"use strict";
/**
 * 原件在线预览转换：把 Office 原件转成 PDF，供前端弹窗 iframe 直接查看。
 *
 * 设计约束（与 file-compress.js 一致的血泪经验）：
 * - 服务器只有 1.7G 内存，LibreOffice 一次转换就能吃掉几百 MB；
 *   因此用串行锁，同一时刻最多跑一个 soffice，绝不并发。
 * - 子进程用独立临时目录做 HOME/TMPDIR（systemd ProtectHome/ProtectSystem），
 *   不碰 ~/.config，也不与其他实例抢 profile 锁。
 * - 转换结果按 file_key 哈希落盘缓存（部署脚本已建 ERP_PREVIEW_CACHE_DIR），
 *   同一份原件只在首次点击查看时转换，之后直接读缓存。
 * - 只做「原件 → PDF」的只读转换，不修改原件、不写业务表、不产生新业务数据。
 */
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const PizZip = require("pizzip");
const { detectOoxml } = require("./ooxml");

const run = promisify(execFile);
const CMD_TIMEOUT = 180000;
const OFFICE_EXT = new Set(["pptx", "ppt", "docx", "doc", "xlsx", "xls"]);

// 串行锁：转换是内存/CPU 密集型，并发跑多个 LibreOffice 会把小机器打趴。
let queue = Promise.resolve();
function serial(fn) {
  const next = queue.then(fn, fn);
  queue = next.then(() => undefined, () => undefined);
  return next;
}

function cacheDir() {
  return process.env.ERP_PREVIEW_CACHE_DIR || path.join(os.tmpdir(), "erp-preview-cache");
}
function childEnv(dir) {
  return { ...process.env, HOME: dir, TMPDIR: dir, TMP: dir, TEMP: dir };
}

/** Office 原件转 PDF；不走缓存的调用方极少，默认始终缓存。 */
async function officeToPdf(key, bytes, ext) {
  const cachePath = path.join(cacheDir(), crypto.createHash("sha256").update(String(key)).digest("hex") + ".pdf");
  // 命中缓存：直接读，避免重复转换。
  try {
    return await fs.readFile(cachePath);
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
  }
  return serial(async () => {
    // 拿锁后再查一次，避免并发排队时重复转换。
    try {
      return await fs.readFile(cachePath);
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
    }
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "erp-preview-"));
    try {
      const input = path.join(dir, "source." + ext);
      await fs.writeFile(input, bytes);
      const profile = path.join(dir, "lo-profile");
      await run("soffice", ["--headless", "--norestore",
        "-env:UserInstallation=file://" + profile,
        "--convert-to", "pdf", "--outdir", dir, input],
      { timeout: CMD_TIMEOUT, maxBuffer: 8 * 1024 * 1024, env: childEnv(dir) });
      const converted = path.join(dir, "source.pdf");
      const buf = await fs.readFile(converted);
      // 缓存写失败不能让预览整体失败（临时目录只读时降级为每次转换）。
      await fs.mkdir(cacheDir(), { recursive: true }).catch(() => {});
      await fs.writeFile(cachePath, buf).catch(() => {});
      return buf;
    } finally {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  });
}

/**
 * 给 xlsx 的每个工作表注入「缩放到一页宽」的打印设置，再转 PDF。
 *
 * 目的：xlsx 原件常有很宽的表，LibreOffice 默认按 100% 分页会把一张表拆成好几页，
 * 预览时反复换页、看不全。这里只改打印设置（fitToPage / fitToWidth / 横版 / 窄边距），
 * 不动任何单元格内容、字体、边框、颜色、合并单元格——原件样式由 LibreOffice 原生渲染。
 * 实测 60行×12列的宽表从 4 页降到 2 页。
 */
function applyFitToWidth(xml) {
  let s = String(xml);
  // sheetPr：启用 fitToPage；已有则替换，没有则插到 worksheet 开标签之后。
  const sheetPr = '<sheetPr><pageSetUpPr fitToPage="1"/></sheetPr>';
  if (/<(?:\w+:)?sheetPr\b[^>]*>[\s\S]*?<\/(?:\w+:)?sheetPr>/.test(s))
    s = s.replace(/<(?:\w+:)?sheetPr\b[^>]*>[\s\S]*?<\/(?:\w+:)?sheetPr>/, sheetPr);
  else s = s.replace(/(<(?:\w+:)?worksheet\b[^>]*>)/, "$1" + sheetPr);

  // OOXML schema 要求顺序：sheetData → pageMargins → pageSetup。
  // pageMargins：缩窄边距，给表格更多空间。
  const margins = '<pageMargins left="0.25" right="0.25" top="0.35" bottom="0.35" header="0.15" footer="0.15"/>';
  if (/<(?:\w+:)?pageMargins\b[^>]*\/>/.test(s))
    s = s.replace(/<(?:\w+:)?pageMargins\b[^>]*\/>/, margins);
  else s = s.replace(/<\/(?:\w+:)?worksheet>/, margins + "</worksheet>");

  // pageSetup：一页宽、高度不限、横版（必须排在 pageMargins 之后）。
  const pageSetup = '<pageSetup fitToWidth="1" fitToHeight="0" orientation="landscape"/>';
  if (/<(?:\w+:)?pageSetup\b[^>]*\/>/.test(s))
    s = s.replace(/<(?:\w+:)?pageSetup\b[^>]*\/>/, pageSetup);
  else s = s.replace(/<\/(?:\w+:)?worksheet>/, pageSetup + "</worksheet>");
  return s;
}

/** 把 xlsx 改成「缩放打印版」的字节，供转 PDF 使用；失败时返回原字节（降级）。 */
function xlsxWithFitWidth(bytes) {
  try {
    if (!Buffer.isBuffer(bytes) || !detectOoxml(bytes)) return bytes;
    const zip = new PizZip(bytes);
    let changed = false;
    for (const name of Object.keys(zip.files)) {
      if (!/^xl\/worksheets\/sheet\d+\.xml$/.test(name)) continue;
      const xml = zip.file(name).asText();
      zip.file(name, applyFitToWidth(xml));
      changed = true;
    }
    return changed ? zip.generate({ type: "nodebuffer" }) : bytes;
  } catch { return bytes; }
}

/** xlsx 原件 → 缩放版 PDF（保留原件表格样式，减少换页）。 */
async function xlsxToPdfScaled(key, bytes) {
  const cachePath = path.join(cacheDir(), crypto.createHash("sha256").update(String(key) + ":fit").digest("hex") + ".pdf");
  try { return await fs.readFile(cachePath); } catch (e) { if (e.code !== "ENOENT") throw e; }
  return serial(async () => {
    try { return await fs.readFile(cachePath); } catch (e) { if (e.code !== "ENOENT") throw e; }
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "erp-xlspreview-"));
    try {
      const input = path.join(dir, "source.xlsx");
      await fs.writeFile(input, xlsxWithFitWidth(bytes));
      const profile = path.join(dir, "lo-profile");
      await run("soffice", ["--headless", "--norestore",
        "-env:UserInstallation=file://" + profile,
        "--convert-to", "pdf", "--outdir", dir, input],
      { timeout: CMD_TIMEOUT, maxBuffer: 8 * 1024 * 1024, env: childEnv(dir) });
      const buf = await fs.readFile(path.join(dir, "source.pdf"));
      await fs.mkdir(cacheDir(), { recursive: true }).catch(() => {});
      await fs.writeFile(cachePath, buf).catch(() => {});
      return buf;
    } finally {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  });
}

module.exports = { officeToPdf, xlsxToPdfScaled, applyFitToWidth, xlsxWithFitWidth, OFFICE_EXT };
