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
 *   2) 单文件 50 MB 上限（统一由 storage.MAX_BYTES 限制）；
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
  doc: "application/msword",
  xls: "application/vnd.ms-excel",
  csv: "text/csv",
  txt: "text/plain",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
};

/** key 必须严格匹配自己生成的格式，避免 ../ 之类的路径穿越 */
const KEY_RE = /^[a-f0-9]{32}\.(jpg|png|webp|gif|pdf|ppt|doc|docx|xls|xlsx|pptx|csv|txt)$/;

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

    // 以文件头/容器结构为准。CSV/TXT 属于纯文本，还须检查原始扩展名和控制字符。
    let declaredName=String(ctx.req.headers["x-file-name"] || "");
    try { declaredName=decodeURIComponent(declaredName); } catch {}
    const mime = sniffMime(buf,declaredName);
    if (!mime) throw bad("无法识别文件类型，支持图片、PDF、DOC/DOCX、PPT/PPTX、XLS/XLSX、CSV、TXT");
    checkMime(mime);
    // 旧版/新版 Office、CSV、TXT 都必须与真实识别类型对应，防止扩展名伪造。
    const recognizedExt=ALLOWED_MIME[mime];
    if (["ppt","doc","xls","docx","pptx","xlsx","csv","txt"].includes(recognizedExt) &&
        !declaredName.toLowerCase().endsWith("."+recognizedExt))
      throw bad("文件扩展名与识别类型不符，请使用真实的 "+recognizedExt.toUpperCase()+" 文件");

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
    if (!KEY_RE.test(key)) throw bad("文件标识不合法");

    // 已关联业务单据的文件，按单据所属项目校验数据范围。
    // 一个 key 理论上只属于一处，但材料与合同分表存，两处都要查。
    // 尚未关联的（刚上传、还没提交单据）只要求登录，key 本身是 32 位随机串。
    const m = db.prepare("SELECT pid, file_name FROM materials WHERE file_key = ?").get(key);
    const c = m ? null : db.prepare("SELECT pid, file_name FROM contracts WHERE file_key = ?").get(key);
    const sponsor=c||m?null:db.prepare("SELECT pid,file_name FROM meeting_sponsor_contracts WHERE file_key=?").get(key);
    const receipt=c||m||sponsor?null:db.prepare("SELECT pid,file_name FROM meeting_sponsor_receipts WHERE file_key=?").get(key);
    const invoice=c||m||sponsor||receipt?null:db.prepare("SELECT pid,file_name FROM meeting_sponsor_invoices WHERE file_key=?").get(key);
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

    const obj = await storage().get(key);
    if (!obj) throw notFound("文件不存在或已删除");

    const ext = key.split(".").pop();
    return { __file: {
      buffer: obj.buffer,
      mime: EXT_MIME[ext] || "application/octet-stream",
      name: owner?.file_name ? safeName(owner.file_name) : key,
      download: ["ppt","doc","xls","docx","pptx","xlsx","csv","txt"].includes(ext)
    } };
  });

  return router;
}

module.exports = { register };
