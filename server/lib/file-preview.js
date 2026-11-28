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

module.exports = { officeToPdf, OFFICE_EXT };
