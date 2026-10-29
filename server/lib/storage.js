"use strict";
/**
 * 文件存储层 —— 双后端，接口完全一致（都是 async）
 *
 * 1) Node / 境内服务器：本地磁盘（默认 data/uploads，可用 ERP_UPLOAD_DIR 覆盖）
 * 2) Cloudflare Workers：R2 bucket 绑定
 *
 * 为什么接口是 async 而数据库是 sync：
 *   R2 的 API 本身是异步的，本地 fs 也统一成 async 才能保持一套调用代码。
 *   数据库那边之所以能用 sync，是因为 DO 的 SQL 恰好是同步的，与这里无关。
 *
 * key 设计：<32位hex>.<ext>
 *   磁盘上按 key 前两位分子目录（uploads/a3/a3f9...jpg），避免单目录堆几万个文件。
 *   key 里不带 /，这样能直接放进 URL 路径 /api/uploads/<key>。
 */
const path = require("node:path");
const { MIME: OFFICE_MIME, detectOoxml } = require("./ooxml");

const HERE = typeof __dirname === "string" ? __dirname : "";
const DATA_DIR = path.join(HERE, "..", "..", "data");
const DEFAULT_DIR =
  (typeof process !== "undefined" && process.env && process.env.ERP_UPLOAD_DIR) ||
  path.join(DATA_DIR, "uploads");

/** 图片/PDF 与 Office OOXML 白名单：只接受有合法 ZIP 目录的无宏 DOCX/PPTX/XLSX */
const ALLOWED_MIME = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
  "application/pdf": "pdf",
  [OFFICE_MIME.docx]: "docx",
  [OFFICE_MIME.pptx]: "pptx",
  [OFFICE_MIME.xlsx]: "xlsx"
};

const MAX_BYTES = 8 * 1024 * 1024; // 单文件 8 MB
const MAX_FILES_PER_MATERIAL = 1;

/* ---------------------------------------------------------------- 本地磁盘 */

function nodeStorage(dir = DEFAULT_DIR) {
  const fs = process.getBuiltinModule("node:fs");
  const fsp = process.getBuiltinModule("node:fs/promises");

  const abs = (key) => {
    const safe = String(key).replace(/[^a-zA-Z0-9._-]/g, "");
    return path.join(dir, safe.slice(0, 2), safe);
  };

  return {
    name: "fs",
    dir,
    async put(key, buffer) {
      const file = abs(key);
      await fsp.mkdir(path.dirname(file), { recursive: true });
      await fsp.writeFile(file, buffer);
      return { size: buffer.length };
    },
    async get(key) {
      const file = abs(key);
      if (!fs.existsSync(file)) return null;
      return { buffer: await fsp.readFile(file) };
    },
    async del(key) {
      const file = abs(key);
      try { await fsp.unlink(file); } catch { /* 文件已不存在视为成功 */ }
    },
    async stat(key) {
      const file = abs(key);
      try {
        const st = await fsp.stat(file);
        return { size: st.size };
      } catch {
        return null;
      }
    }
  };
}

/* ---------------------------------------------------------------- R2 */

function r2Storage(bucket) {
  return {
    name: "r2",
    dir: "(R2 bucket)",
    async put(key, buffer, meta = {}) {
      await bucket.put(key, buffer, {
        httpMetadata: {
          contentType: meta.mime || "application/octet-stream",
          cacheControl: "private, max-age=31536000"
        }
      });
      return { size: buffer.length };
    },
    async get(key) {
      const obj = await bucket.get(key);
      if (!obj) return null;
      return { buffer: Buffer.from(await obj.arrayBuffer()) };
    },
    async del(key) {
      try { await bucket.delete(key); } catch { /* 已不存在视为成功 */ }
    },
    async stat(key) {
      const obj = await bucket.head(key);
      return obj ? { size: obj.size } : null;
    }
  };
}

/* ---------------------------------------------------------------- 对外接口 */

let backend = null;

function useBackend(b) {
  backend = b;
  return b;
}

function ensure() {
  if (!backend) {
    // 测试用：模拟「未配置存储」的部署（Cloudflare 未绑 R2 时的状态）
    const forced =
      typeof process !== "undefined" && process.env && process.env.ERP_STORAGE === "unavailable";
    backend = forced ? unavailableStorage() : nodeStorage();
  }
  return backend;
}

/** 由 Cloudflare Worker 在 DO 构造时调用；未绑定 R2 时保持本地后端（Worker 上会报错，属预期） */
function attachR2(bucket) {
  if (!bucket) return backend;
  return useBackend(r2Storage(bucket));
}

/**
 * 不可用后端：Cloudflare 上没绑 R2 时用它兜底。
 * 直接报明确错误，而不是让 nodeStorage 去调用不存在的 fs 抛一个看不懂的栈。
 */
function unavailableStorage(reason = "当前部署未配置文件存储，请联系管理员绑定 R2 存储桶") {
  const fail = () => {
    throw Object.assign(new Error(reason), { status: 503, code: "STORAGE_UNAVAILABLE" });
  };
  return { name: "unavailable", dir: "(未配置)", put: fail, get: fail, del: async () => {}, stat: async () => null };
}

/** 测试用：注入自定义后端 */
function attachStorage(b) {
  return useBackend(b);
}

function storage() {
  return ensure();
}

/* ---------------------------------------------------------------- 工具 */

const crypto = process.getBuiltinModule("node:crypto");

function newKey(mime) {
  const ext = ALLOWED_MIME[mime] || "bin";
  return `${crypto.randomBytes(16).toString("hex")}.${ext}`;
}

function checkMime(mime) {
  const m = String(mime || "").split(";")[0].trim().toLowerCase();
  if (!ALLOWED_MIME[m]) {
    throw Object.assign(new Error(`不支持的文件类型：${m || "未识别"}（仅支持 JPG / PNG / WebP / GIF / PDF / DOCX / PPTX / XLSX）`), {
      status: 415, code: "UNSUPPORTED_MEDIA"
    });
  }
  return m;
}

/** 从文件头判断真实类型，防止把可执行文件改名成 .jpg 上传 */
function sniffMime(buf) {
  if (!buf || buf.length < 4) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return "image/png";
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x38) return "image/gif";
  if (buf.length >= 12 && buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WEBP") return "image/webp";
  if (buf.toString("ascii", 0, 4) === "%PDF") return "application/pdf";
  return detectOoxml(buf);
}

function safeName(name) {
  const n = String(name || "").replace(/[\r\n\t]/g, "").trim();
  return (n || "未命名文件").slice(0, 120);
}

module.exports = {
  storage, useBackend, attachR2, attachStorage, unavailableStorage,
  nodeStorage, r2Storage,
  newKey, checkMime, sniffMime, safeName,
  ALLOWED_MIME, MAX_BYTES, MAX_FILES_PER_MATERIAL, DEFAULT_DIR
};
