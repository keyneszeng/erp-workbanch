"use strict";
/**
 * 超大附件自动瘦身
 *
 * 业务上单份原件限制 20 MB，但实际扫描件经常 30~80 MB（300dpi 彩色扫描、
 * 手机直出照片、几十页的议程）。让用户自己找工具压一遍，最后往往是
 * 「随便截个图传上来」，反而更难核对。
 *
 * 这里在服务端做一次有损但可控的压缩，只处理两类：
 *   PDF  → Ghostscript 重新编码 + 降采样（扫描件的体积几乎全在图片里）
 *   图片 → ImageMagick 限制长边 + 降质量
 * Office（docx/xlsx/pptx/ppt）本身就是 ZIP 包，里面是大图，重新打包压不动多少，
 * 强行处理还可能把文件弄坏 —— 直接告诉用户「请先本地压缩或转 PDF」。
 *
 * 压缩是有损的，所以：
 *   - 只压到刚好低于上限就停，不做无意义的二次劣化；
 *   - 返回原始大小与压缩后大小，调用方要写进审计，事后能追。
 */
const { execFile } = require("node:child_process");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const TIMEOUT = Number(process.env.ERP_SHRINK_TIMEOUT_MS || 180000);
/** 探测结果缓存：装没装只在第一次问一次 */
const probes = new Map();
/** 串行化：gs / convert 都是吃内存的进程，1C2G 上并发跑两个容易被 OOM 杀掉 */
let queue = Promise.resolve();

function run(program, args, timeout = TIMEOUT) {
  return new Promise((resolve, reject) => {
    execFile(program, args, { timeout, maxBuffer: 4 * 1024 * 1024, windowsHide: true, shell: false },
      (e, stdout, stderr) => {
        if (!e) return resolve(String(stdout || ""));
        const err = new Error(String(stderr || e.message || "压缩失败").slice(0, 300));
        err.code = e.code === "ENOENT" ? "TOOL_MISSING" : (e.killed ? "TIMEOUT" : "FAILED");
        reject(err);
      });
  });
}

async function has(program, args = ["-version"]) {
  if (probes.has(program)) return probes.get(program);
  try {
    await run(program, args, 15000);
    probes.set(program, true);
  } catch {
    probes.set(program, false);
  }
  return probes.get(program);
}

/** PDF 的压缩档位：从「够用」到「能看」，逐级降，压到低于上限就停 */
const PDF_LADDER = [
  { preset: "ebook", dpi: 150 },
  { preset: "screen", dpi: 110 },
  { preset: "screen", dpi: 80 }
];
/** 图片档位：先限长边保质量，再逐级降 */
const IMAGE_LADDER = [
  { dim: 2600, quality: 82 },
  { dim: 2000, quality: 72 },
  { dim: 1600, quality: 62 }
];

const IMAGE_EXT = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" };
const OFFICE_HINT = "Office 文件本身是压缩包，系统无法安全地再压小；请先在本地压缩图片，或导出为 PDF 后再上传";

async function shrinkPdf(buffer, limit, dir) {
  if (!(await has("gs", ["--version"]))) return null;
  const src = path.join(dir, "in.pdf");
  await fs.writeFile(src, buffer, { mode: 0o600 });
  for (const step of PDF_LADDER) {
    const out = path.join(dir, `out-${step.preset}-${step.dpi}.pdf`);
    await run("gs", [
      "-q", "-dNOPAUSE", "-dBATCH", "-dSAFER",
      "-sDEVICE=pdfwrite", "-dCompatibilityLevel=1.5",
      `-dPDFSETTINGS=/${step.preset}`,
      "-dDownsampleColorImages=true", `-dColorImageResolution=${step.dpi}`,
      "-dDownsampleGrayImages=true", `-dGrayImageResolution=${step.dpi}`,
      "-dDownsampleMonoImages=true", `-dMonoImageResolution=${Math.min(step.dpi * 2, 300)}`,
      "-dEmbedAllFonts=true", "-dSubsetFonts=true",
      `-sOutputFile=${out}`, src
    ]);
    const data = await fs.readFile(out).catch(() => null);
    await fs.rm(out, { force: true }).catch(() => {});
    if (data && data.length <= limit && data.length > 1024) {
      return { buffer: data, engine: `ghostscript/${step.preset}@${step.dpi}dpi` };
    }
  }
  return null;
}

async function shrinkImage(buffer, mime, limit, dir) {
  if (!(await has("convert", ["-version"]))) return null;
  const ext = IMAGE_EXT[mime];
  const src = path.join(dir, `in.${ext}`);
  await fs.writeFile(src, buffer, { mode: 0o600 });
  for (const step of IMAGE_LADDER) {
    const out = path.join(dir, `out-${step.dim}-${step.quality}.${ext}`);
    const args = [src, "-strip", "-resize", `${step.dim}x${step.dim}>`];
    // PNG 是无损格式，quality 对它没意义，改用压缩级别 + 调色板
    if (ext === "png") args.push("-define", "png:compression-level=9");
    else args.push("-quality", String(step.quality));
    args.push(out);
    await run("convert", args);
    const data = await fs.readFile(out).catch(() => null);
    await fs.rm(out, { force: true }).catch(() => {});
    if (data && data.length <= limit && data.length > 512) {
      return { buffer: data, engine: `imagemagick/${step.dim}px-q${step.quality}` };
    }
  }
  return null;
}

/**
 * 把文件压到 limit 字节以内。
 * @returns {Promise<{buffer:Buffer, engine:string, originalSize:number}|null>}
 *          null 表示「压不了」或「压了还是超标」，由调用方给出可读提示
 */
async function shrinkToLimit(buffer, mime, limit) {
  if (!Buffer.isBuffer(buffer) || buffer.length <= limit) return { ok: false, reason: "not-needed" };
  const supported = mime === "application/pdf" || !!IMAGE_EXT[mime];
  if (!supported) return { ok: false, reason: "unsupported" };

  const job = queue.then(async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "erp-shrink-"));
    try {
      await fs.chmod(dir, 0o700);
      let out = null;
      try {
        out = mime === "application/pdf"
          ? await shrinkPdf(buffer, limit, dir)
          : await shrinkImage(buffer, mime, limit, dir);
      } catch {
        // 文件损坏、加密、或工具中途被杀：一律当成「压不了」，
        // 由调用方给出可读提示，绝不能让上传变成 500。
        return { ok: false, reason: "failed" };
      }
      if (!out) {
        // 工具没装 与 压完还超标 要分开报，否则用户不知道该换文件还是找运维
        const tool = mime === "application/pdf" ? "gs" : "convert";
        const installed = await has(tool, [mime === "application/pdf" ? "--version" : "-version"]);
        return { ok: false, reason: installed ? "still-large" : "tool-missing" };
      }
      return { ok: true, ...out, originalSize: buffer.length };
    } finally {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  });
  queue = job.then(() => {}, () => {});
  return job;
}

module.exports = { shrinkToLimit, has, OFFICE_HINT };
