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
 * Office 另走一条路：docx/xlsx/pptx 是 ZIP 包，通用重打包压不动多少，
 * 但体积几乎都压在嵌入的位图上 —— 解包、把 media 里的大图重压、再打包，
 * 效果等同于 PowerPoint 自带的「压缩图片」。矢量图（emf/wmf）和嵌入对象
 * 一律原样保留：它们重压会变形，宁可压不动也不能弄坏原件。
 * 旧版 .ppt（CFB 二进制）没有可靠的无损改写手段，直接拒绝。
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

function run(program, args, opts = TIMEOUT) {
  // 第三个参数既可以是超时毫秒数，也可以是 { timeout, cwd }：
  // zip 需要在解包目录里执行，否则会把绝对路径打进压缩包。
  const o = typeof opts === "number" ? { timeout: opts } : (opts || {});
  return new Promise((resolve, reject) => {
    execFile(program, args, {
      timeout: o.timeout || TIMEOUT, cwd: o.cwd,
      maxBuffer: 4 * 1024 * 1024, windowsHide: true, shell: false
    },
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
const OFFICE_HINT = "该格式无法自动压缩，请先在本地压缩后再上传";
/** 能通过「重压内嵌图片」瘦身的 OOXML 格式（旧版 .ppt 是 CFB，不在此列） */
const OOXML_MIME = {
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": "pptx"
};
/** media 里值得重压的位图；emf/wmf/wdp 是矢量或特殊编码，动了就坏 */
const RASTER_RE = /\.(jpe?g|png|webp|gif|bmp|tiff?)$/i;

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

/** 递归列出目录下所有文件 */
async function walk(dir) {
  const out = [];
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...await walk(full));
    else if (e.isFile()) out.push(full);
  }
  return out;
}

/**
 * 重压 media 目录里的位图。只动位图：
 * emf/wmf 是矢量、wdp 是 JPEG-XR，重压要么变形要么直接坏，一律跳过。
 * 小于 150KB 的图也不动 —— 压下来省不了多少，却要多受一次有损。
 */
async function shrinkMedia(root, pass) {
  let changed = 0;
  for (const file of await walk(root)) {
    if (!/[\\/]media[\\/]/i.test(file) || !RASTER_RE.test(file)) continue;
    const st = await fs.stat(file).catch(() => null);
    if (!st || st.size < 150 * 1024) continue;
    const ext = path.extname(file).toLowerCase();
    const tmp = `${file}.shrink${ext}`;
    const args = [file, "-strip", "-resize", `${pass.dim}x${pass.dim}>`];
    if (ext === ".png") args.push("-define", "png:compression-level=9");
    else args.push("-quality", String(pass.quality));
    args.push(tmp);
    try {
      await run("convert", args);
      const after = await fs.stat(tmp).catch(() => null);
      // 只在小了才替换：有些图重压反而更大，不能为了压而压
      if (after && after.size > 0 && after.size < st.size) {
        await fs.rename(tmp, file);
        changed++;
      } else {
        await fs.rm(tmp, { force: true }).catch(() => {});
      }
    } catch {
      await fs.rm(tmp, { force: true }).catch(() => {});
    }
  }
  return changed;
}

/** 两档：先 1600px/q80，不够再 1200px/q70 */
const OOXML_PASSES = [
  { dim: 1600, quality: 80 },
  { dim: 1200, quality: 70 }
];

/**
 * OOXML（docx/xlsx/pptx）瘦身：解包 → 重压 media 位图 → 重新打包 → 结构校验。
 * 结构与原件一一对应，只换掉体积大的位图，等同于 PowerPoint 的「压缩图片」。
 */
async function shrinkOoxml(buffer, ext, limit, dir) {
  for (const tool of ["unzip", "zip", "convert"]) {
    if (!(await has(tool, [tool === "convert" ? "-version" : "-v"]))) return null;
  }
  const { detectOoxml } = require("./ooxml");
  const src = path.join(dir, `in.${ext}`);
  await fs.writeFile(src, buffer, { mode: 0o600 });

  for (const [i, pass] of OOXML_PASSES.entries()) {
    const work = path.join(dir, `work-${i}`);
    await fs.mkdir(work, { recursive: true });
    await run("unzip", ["-q", "-o", src, "-d", work]);
    const changed = await shrinkMedia(work, pass);
    // 没有可压的位图（全是矢量图 / 图都很小）：这不是失败，是「这文件压不动」
    if (!changed) return { none: true };

    const out = path.join(dir, `out-${i}.${ext}`);
    await fs.rm(out, { force: true }).catch(() => {});
    await run("zip", ["-q", "-r", "-X", "-9", out, "."], { cwd: work });
    await run("unzip", ["-tq", out]);

    const data = await fs.readFile(out);
    // 结构必须仍然是合法的 OOXML，否则宁可放弃压缩也不能交一个打不开的原件
    if (detectOoxml(data) && data.length <= limit) {
      return { buffer: data, engine: `ooxml-media/${pass.dim}px-q${pass.quality}（重压 ${changed} 张图）` };
    }
    await fs.rm(work, { recursive: true, force: true }).catch(() => {});
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
  const supported = mime === "application/pdf" || !!IMAGE_EXT[mime] || !!OOXML_MIME[mime];
  if (!supported) return { ok: false, reason: "unsupported" };

  const job = queue.then(async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "erp-shrink-"));
    try {
      await fs.chmod(dir, 0o700);
      let out = null;
      try {
        out = mime === "application/pdf"
          ? await shrinkPdf(buffer, limit, dir)
          : OOXML_MIME[mime]
            ? await shrinkOoxml(buffer, OOXML_MIME[mime], limit, dir)
            : await shrinkImage(buffer, mime, limit, dir);
      } catch {
        // 文件损坏、加密、或工具中途被杀：一律当成「压不了」，
        // 由调用方给出可读提示，绝不能让上传变成 500。
        return { ok: false, reason: "failed" };
      }
      if (out && out.none) return { ok: false, reason: "unsupported" };
      if (!out) {
        // 工具没装 与 压完还超标 要分开报，否则用户不知道该换文件还是找运维
        const need = mime === "application/pdf" ? ["gs"]
          : OOXML_MIME[mime] ? ["unzip", "zip", "convert"]
            : ["convert"];
        let missing = false;
        for (const t of need) {
          const args = t === "gs" ? ["--version"] : t === "convert" ? ["-version"] : ["-v"];
          if (!(await has(t, args))) missing = true;
        }
        return { ok: false, reason: missing ? "tool-missing" : "still-large" };
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
