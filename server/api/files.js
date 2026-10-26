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
 *   3) 下载时按材料所属项目校验数据范围，不是登录就能看任意 key。
 */
const { db } = require("../lib/db");
const { now, bad, notFound, forbidden } = require("../lib/util");
const { assertCan, assertProjectVisible, can } = require("../lib/rbac");
const { logAudit } = require("../lib/audit");
const { getProject } = require("../lib/workflow");
const { HttpError } = require("../lib/util");
const { storage, newKey, checkMime, sniffMime, safeName, MAX_BYTES } = require("../lib/storage");

const EXT_MIME = {
  jpg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  gif: "image/gif",
  pdf: "application/pdf"
};

/** key 必须严格匹配自己生成的格式，避免 ../ 之类的路径穿越 */
const KEY_RE = /^[a-f0-9]{32}\.(jpg|png|webp|gif|pdf)$/;

function register(router) {
  router.post("/api/uploads", async (ctx) => {
    assertCan(ctx.user, "material:write", "当前角色无文件上传权限");

    const buf = ctx.body;
    if (!Buffer.isBuffer(buf) || buf.length === 0) throw bad("未收到文件内容");
    if (buf.length > MAX_BYTES) {
      throw new HttpError(413, "PAYLOAD_TOO_LARGE", `单个文件不能超过 ${Math.round(MAX_BYTES / 1024 / 1024)} MB`);
    }

    // 以文件头为准，不信客户端声明的 Content-Type
    const mime = sniffMime(buf);
    if (!mime) throw bad("无法识别文件类型，仅支持 JPG / PNG / WebP / GIF / PDF");
    checkMime(mime);

    const rawName = ctx.req.headers["x-file-name"] || "";
    let name = "未命名文件";
    try { name = safeName(decodeURIComponent(rawName)); } catch { name = safeName(rawName); }

    const key = newKey(mime);
    await storage().put(key, buf, { mime });

    const pid = ctx.query.pid || null;
    logAudit({
      user: ctx.user, module: "材料中心", action: "上传文件",
      target: pid || key, detail: `${name}（${(buf.length / 1024).toFixed(0)} KB）`, ip: ctx.ip
    });

    return { key, name, size: buf.length, mime, url: `/api/uploads/${key}` };
  });

  /** 上传能力探测：前端据此决定是否显示上传按钮（R2 未绑定时 Worker 上会返回 false） */
  router.get("/api/uploads/capability", async () => {
    const st = storage();
    return { enabled: st.name === "fs" || st.name === "r2", backend: st.name, maxBytes: MAX_BYTES };
  });

  router.get("/api/uploads/:key", async (ctx) => {
    const key = String(ctx.params.key || "");
    if (!KEY_RE.test(key)) throw bad("文件标识不合法");

    // 已关联材料的文件，按材料所属项目校验数据范围；
    // 尚未关联的（刚上传、还没提交材料登记）只要求登录，key 本身是 32 位随机串。
    const m = db.prepare("SELECT * FROM materials WHERE file_key = ?").get(key);
    if (m) {
      const p = getProject(m.pid);
      assertProjectVisible(ctx.user, p);
    }

    const obj = await storage().get(key);
    if (!obj) throw notFound("文件不存在或已删除");

    const ext = key.split(".").pop();
    return { __file: { buffer: obj.buffer, mime: EXT_MIME[ext] || "application/octet-stream", name: key } };
  });

  return router;
}

module.exports = { register };
