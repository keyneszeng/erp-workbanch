"use strict";
/**
 * Office 原件转 PDF（用于在线预览）
 *
 * 浏览器没有 Word / Excel / PowerPoint 的渲染能力，课件、串场、劳务表这类原件
 * 点开只能下载。这里用 LibreOffice 无头模式转成 PDF，再交给已有的 PDF 渲染链路
 * 变成图片，核销人就能在页面里直接核对内容。
 *
 * 三个必须处理好的点：
 *   1) 并发：soffice 单实例会抢 CPU 和用户配置锁，这里用 Promise 链串行化；
 *   2) 配置目录：每个任务给独立的 UserInstallation，避免锁冲突，也避免写进 HOME；
 *   3) 缓存：key 是一次上传一个、永不改写，所以转换结果可以按 key 长期缓存，
 *      否则每次翻页都要重新跑一次 LibreOffice（1~3 秒）。
 */
const { execFile } = require("node:child_process");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const TIMEOUT = Number(process.env.ERP_OFFICE_TIMEOUT_MS || 90000);
const CACHE_DIR = process.env.ERP_PREVIEW_CACHE_DIR || path.join(os.tmpdir(), "erp-preview-cache");

/** 探测结果缓存：没装就一直是没装，不必每次都 fork 一次进程 */
let available = null;
/** 串行队列：LibreOffice 同时跑两个实例容易互相抢锁、把 1C2G 的小机器打满 */
let queue = Promise.resolve();

function run(program, args, timeout, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(program, args, {
      timeout, maxBuffer: 8 * 1024 * 1024, windowsHide: true, shell: false,
      // soffice 是 shell 包装脚本，会 cd 到当前目录、也会读写 HOME：
      // 服务进程若从 /root 之类不可读的目录启动，转换会直接报
      // "cd: can't cd to /root" 或 "User installation could not be completed"。
      cwd: options.cwd,
      env: { ...process.env, ...(options.env || {}) }
    }, (e, stdout, stderr) => {
      if (!e) return resolve(String(stdout || ""));
      const err = new Error(String(stderr || e.message || "转换失败").slice(0, 300));
      err.code = e.code === "ENOENT" ? "SOFFICE_MISSING" : (e.killed ? "SOFFICE_TIMEOUT" : "SOFFICE_FAILED");
      reject(err);
    });
  });
}

async function hasLibreOffice() {
  if (available !== null) return available;
  try {
    await run("soffice", ["--version"], 15000);
    available = true;
  } catch {
    available = false;
  }
  return available;
}

/**
 * 把 Office 原件转成 PDF。
 * @param {Buffer} buffer 原件字节
 * @param {string} ext    docx / xlsx / pptx / doc / xls / ppt
 * @param {string} cacheKey 文件 key（去掉扩展名），作为缓存名
 * @returns {Promise<Buffer>} PDF 字节
 */
async function toPdf(buffer, ext, cacheKey) {
  const cached = path.join(CACHE_DIR, `${cacheKey}.pdf`);
  const hit = await fs.readFile(cached).catch(() => null);
  if (hit && hit.length > 4) return hit;

  const job = queue.then(async () => {
    // 排队期间可能已经被别的请求转好了，再查一次缓存
    const again = await fs.readFile(cached).catch(() => null);
    if (again && again.length > 4) return again;

    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "erp-office-"));
    try {
      const src = path.join(dir, `source.${ext}`);
      const profile = path.join(dir, "profile");
      const home = path.join(dir, "home");
      await fs.writeFile(src, buffer, { mode: 0o600 });
      await fs.mkdir(home, { recursive: true });
      await run("soffice", [
        "--headless", "--norestore", "--nolockcheck", "--nodefault", "--nologo",
        `-env:UserInstallation=file://${profile}`,
        "--convert-to", "pdf", "--outdir", dir, src
      ], TIMEOUT, { cwd: dir, env: { HOME: home, TMPDIR: dir } });

      const pdf = await fs.readFile(path.join(dir, "source.pdf"));
      if (pdf.length <= 4) throw Object.assign(new Error("转换结果为空"), { code: "SOFFICE_FAILED" });

      // 缓存失败不影响本次预览：转换已经成功，写不进去只是下次还要再转
      await fs.mkdir(CACHE_DIR, { recursive: true })
        .then(() => fs.writeFile(cached, pdf))
        .catch(() => {});
      return pdf;
    } finally {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  });

  // 队列本身不能被失败卡住：失败也要让后面的任务继续排
  queue = job.then(() => {}, () => {});
  return job;
}

module.exports = { toPdf, hasLibreOffice, CACHE_DIR };
