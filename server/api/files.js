"use strict";
/**
 * 文件上传 / 下载
 *
 * 上传走「原始二进制」而不是 multipart：
 *   multipart 解析器要自己写几百行、边界情况多（分块、引号、文件名编码），
 *   而这里的需求只是「一次传一个文件」，Content-Type + 裸 body 已经足够，
 *   出错面小得多。前端用 fetch + Blob 直接发，不需要 FormData。
 *
 * 安全上有三道：
 *   1) 类型白名单 + 文件头嗅探（不信 Content-Type，防改名上传可执行文件）；
 *   2) 单文件 8 MB 上限；
 *   3) 下载时按文件所属单据（材料 / 合同）的项目校验数据范围，不是登录就能看任意 key。
 */
const { db } = require("../lib/db");
const { now, bad, notFound, forbidden } = require("../lib/util");
const { assertProjectVisible, can } = require("../lib/rbac");
const { logAudit } = require("../lib/audit");
const { getProject } = require("../lib/workflow");
const { HttpError } = require("../lib/util");
const { storage, newKey, checkMime, sniffMime, safeName, MAX_BYTES, ALLOWED_MIME } = require("../lib/storage");

const EXT_MIME = {
  jpg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  gif: "image/gif",
  pdf: "application/pdf",
  ppt: "application/vnd.ms-powerpoint",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
};

/** key 必须严格匹配自己生成的格式，避免 ../ 之类的路径穿越 */
const KEY_RE = /^[a-f0-9]{32}\.(jpg|png|webp|gif|pdf|ppt|docx|pptx|xlsx)$/;

/** 需要先转 PDF 才能预览的 Office 格式（下载路由里它们仍是 attachment） */
const OFFICE_EXT = ["doc", "docx", "xls", "xlsx", "ppt", "pptx"];

/** 在线预览渲染的 PDF 页数上限，防止超大文档把临时目录撑爆 */
const PREVIEW_MAX_PAGES = 300;
/** 预览渲染宽度（像素）：A4 竖版约等于 150 dpi，合同小字能看清 */
const PREVIEW_WIDTH = 1500;

/**
 * 校验「这个用户能不能读这个 key」，并返回文件归属信息。
 * 下载与在线预览必须用同一套规则，否则会出现「不能下载但能预览」的绕过。
 */
function authorizeUpload(ctx, key) {
  if (!KEY_RE.test(key)) throw bad("文件标识不合法");

  // 已关联业务单据的文件，按单据所属项目校验数据范围。
  // 一个 key 理论上只属于一处，但材料与合同分表存，两处都要查。
  // 尚未关联的（刚上传、还没提交单据）只要求登录，key 本身是 32 位随机串。
  const m = db.prepare("SELECT pid, file_name FROM materials WHERE file_key = ?").get(key);
  const c = m ? null : db.prepare("SELECT pid, file_name FROM contracts WHERE file_key = ?").get(key);
  const sponsor = c || m ? null : db.prepare("SELECT pid,file_name FROM meeting_sponsor_contracts WHERE file_key=?").get(key);
  const receipt = c || m || sponsor ? null : db.prepare("SELECT pid,file_name FROM meeting_sponsor_receipts WHERE file_key=?").get(key);
  const invoice = c || m || sponsor || receipt ? null : db.prepare("SELECT pid,file_name FROM meeting_sponsor_invoices WHERE file_key=?").get(key);
  const owner = m || c || sponsor || receipt || invoice;
  if (owner) {
    assertProjectVisible(ctx.user, getProject(owner.pid));
    // 单纯是项目成员的嘉宾并不自动获得合同和财务凭证的读取权限。
    if (!can(ctx.user, "material:write") && !can(ctx.user, "contract:write") &&
        !can(ctx.user, "verify:check") && !can(ctx.user, "archive:write")) {
      throw forbidden("当前角色无权查看内部业务附件");
    }
  } else {
    // 未关联单据时只允许上传者或总管理员读取，不能把随机 key 当作授权。
    const pending = db.prepare("SELECT user_id FROM uploaded_files WHERE file_key = ?").get(key);
    if (!pending) throw notFound("文件不存在或尚未登记");
    if (Number(pending.user_id) !== Number(ctx.user.id) && ctx.user.role !== "admin") {
      throw forbidden("该文件不属于当前用户");
    }
  }
  return { owner, ext: key.split(".").pop() };
}

/** 跑一个本地命令（poppler 渲染用）。ENOENT 说明依赖没装，转成可读的 503。 */
function runTool(program, args, timeout) {
  const { execFile } = require("node:child_process");
  return new Promise((resolve, reject) => {
    execFile(program, args, { timeout, maxBuffer: 8 * 1024 * 1024, windowsHide: true, shell: false }, (e, stdout) => {
      if (!e) return resolve(String(stdout || ""));
      if (e.code === "ENOENT") {
        return reject(new HttpError(503, "PREVIEW_UNAVAILABLE", "服务端未安装 PDF 预览依赖（poppler-utils）"));
      }
      if (e.killed || e.code === "ETIMEDOUT") {
        return reject(new HttpError(422, "PREVIEW_TIMEOUT", "原件渲染超时，请下载后用本地软件查看"));
      }
      reject(new HttpError(422, "PREVIEW_FAILED", "原件无法渲染（可能已加密或文件损坏），请下载后查看"));
    });
  });
}

function register(router) {
  router.post("/api/uploads", async (ctx) => {
    // 上传是所有附件类操作的公共入口，材料登记和合同录入都要用。
    // 只卡 material:write 会让「能录合同但不能登记材料」的角色传不了合同原件。
    if (!can(ctx.user, "material:write") && !can(ctx.user, "contract:write")) {
      throw forbidden("当前角色无文件上传权限");
    }

    const buf = ctx.body;
    if (!Buffer.isBuffer(buf) || buf.length === 0) throw bad("未收到文件内容");
    if (buf.length > MAX_BYTES) {
      throw new HttpError(413, "PAYLOAD_TOO_LARGE", `单个文件不能超过 ${Math.round(MAX_BYTES / 1024 / 1024)} MB`);
    }

    // 以文件头为准，不信客户端声明的 Content-Type
    const mime = sniffMime(buf);
    if (!mime) throw bad("无法识别文件类型，仅支持 JPG / PNG / WebP / GIF / PDF / PPT / DOCX / PPTX / XLSX");
    checkMime(mime);
    // Office 附件必须与原始文件名扩展名一致，禁止把可识别的 PPTX 冒充 EXE 等格式展示。
    const officeExt = ALLOWED_MIME[mime];
    if (["ppt","docx", "pptx", "xlsx"].includes(officeExt)) {
      const declared = String(ctx.req.headers["x-file-name"] || "");
      let decoded = declared;
      try { decoded = decodeURIComponent(declared); } catch {}
      if (!decoded.toLowerCase().endsWith("." + officeExt)) {
        throw bad("Office 文件扩展名与实际格式不符");
      }
    }

    const rawName = ctx.req.headers["x-file-name"] || "";
    let name = "未命名文件";
    try { name = safeName(decodeURIComponent(rawName)); } catch { name = safeName(rawName); }

    const pid = ctx.query.pid || null;
    if (pid) {
      const p = getProject(pid);
      if (!p) throw notFound("会议项目不存在");
      assertProjectVisible(ctx.user, p);
    }
    const key = newKey(mime);
    await storage().put(key, buf, { mime });
    try {
      db.prepare("INSERT INTO uploaded_files (file_key,user_id,pid,created_at) VALUES (?,?,?,?)")
        .run(key, ctx.user.id, pid, now());
    } catch (e) {
      try { await storage().del(key); } catch {}
      throw e;
    }
    logAudit({
      user: ctx.user, module: "材料中心", action: "上传文件",
      target: pid || key, detail: `${name}（${(buf.length / 1024).toFixed(0)} KB）`, ip: ctx.ip
    });

    return { key, name, size: buf.length, mime, url: `/api/uploads/${key}` };
  });

  /** 上传能力探测：前端据此决定是否显示上传按钮（R2 未绑定时 Worker 上会返回 false） */
  router.get("/api/uploads/capability", async () => {
    const st = storage();
    return { enabled: st.name === "fs" || st.name === "r2", backend: st.name, maxBytes: MAX_BYTES, allowedMime: Object.keys(ALLOWED_MIME) };
  });

  router.get("/api/uploads/:key", async (ctx) => {
    const key = String(ctx.params.key || "");
    const { owner, ext } = authorizeUpload(ctx, key);

    const obj = await storage().get(key);
    if (!obj) throw notFound("文件不存在或已删除");

    return { __file: {
      buffer: obj.buffer,
      mime: EXT_MIME[ext] || "application/octet-stream",
      name: owner?.file_name ? safeName(owner.file_name) : key,
      download: ["ppt","docx", "pptx", "xlsx"].includes(ext)
    } };
  });

  /**
   * 在线预览：把原件变成浏览器一定能显示的东西。
   *
   * 为什么不能只靠 <a target="_blank">：
   *   PDF 能不能在标签页里直接打开，取决于浏览器设置（很多国产浏览器默认下载），
   *   Office 文件（课件、串场 PPT、劳务表 Excel）浏览器更是完全没有渲染能力。
   *   核销时点「查看原件」是要核对内容，落到下载就是把核对动作打断了。
   *
   * 做法：
   *   图片 → 原样返回；
   *   PDF  → poppler 按页渲染成 PNG（与 OCR 同一套依赖）；
   *   Office → LibreOffice 无头转 PDF，再走同一条 PDF 渲染链路（结果按 key 缓存）。
   */
  router.get("/api/uploads/:key/preview", async (ctx) => {
    const key = String(ctx.params.key || "");
    const { owner, ext } = authorizeUpload(ctx, key);

    const obj = await storage().get(key);
    if (!obj) throw notFound("文件不存在或已删除");
    const name = owner?.file_name ? safeName(owner.file_name) : key;

    if (["jpg", "png", "webp", "gif"].includes(ext)) {
      return { __file: { buffer: obj.buffer, mime: EXT_MIME[ext], name, download: false } };
    }

    let pdf = obj.buffer;
    if (OFFICE_EXT.includes(ext)) {
      const { toPdf, hasLibreOffice } = require("../lib/office-preview");
      if (!(await hasLibreOffice())) {
        throw new HttpError(415, "PREVIEW_UNSUPPORTED",
          `服务器未安装 LibreOffice，${ext.toUpperCase()} 无法在线预览，请下载后用本地软件打开`);
      }
      try {
        pdf = await toPdf(obj.buffer, ext, key.replace(/\.[^.]+$/, ""));
      } catch (e) {
        const timeout = e.code === "SOFFICE_TIMEOUT";
        throw new HttpError(422, timeout ? "PREVIEW_TIMEOUT" : "PREVIEW_CONVERT_FAILED",
          timeout
            ? "原件转换超时（文件可能过大），请下载后查看"
            : "原件无法转换（可能已加密或损坏），请下载后查看");
      }
    } else if (ext !== "pdf") {
      throw new HttpError(415, "PREVIEW_UNSUPPORTED",
        `该格式（${ext.toUpperCase()}）无法在线预览，请下载后用本地软件打开`);
    }

    const fs = require("node:fs/promises");
    const os = require("node:os");
    const path = require("node:path");
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "erp-preview-"));
    try {
      await fs.chmod(dir, 0o700);
      const file = path.join(dir, "original.pdf");
      await fs.writeFile(file, pdf, { mode: 0o600 });

      const info = await runTool("pdfinfo", [file], 10000);
      const pages = Number((/^Pages:\s+(\d+)/im.exec(info) || [])[1] || 0);
      if (!pages) throw new HttpError(422, "PREVIEW_FAILED", "PDF 页数无效或文件已加密，请下载后查看");

      const wanted = Number(ctx.query.page) || 1;
      const page = Math.min(Math.max(1, Math.trunc(wanted)), Math.min(pages, PREVIEW_MAX_PAGES));

      const prefix = path.join(dir, "page");
      await runTool("pdftoppm", [
        "-f", String(page), "-l", String(page),
        "-scale-to", String(PREVIEW_WIDTH), "-png", "-r", "150", file, prefix
      ], 30000);

      const produced = (await fs.readdir(dir)).filter((s) => /^page-?\d*\.png$/.test(s));
      if (!produced.length) throw new HttpError(422, "PREVIEW_FAILED", "原件未能渲染成图片，请下载后查看");
      const buffer = await fs.readFile(path.join(dir, produced[0]));

      return { __file: {
        buffer,
        mime: "image/png",
        name: `${name.replace(/\.[^.]+$/, "")}-第${page}页.png`,
        download: false,
        headers: { "X-Preview-Pages": String(pages), "X-Preview-Page": String(page) }
      } };
    } finally {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  });

  return router;
}

module.exports = { register };
