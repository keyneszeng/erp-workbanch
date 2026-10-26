"use strict";
/**
 * 请求处理核心 —— Node（http.createServer）与 Cloudflare Worker 共用。
 *
 * 两个运行时都往 handle() 传「node 风格的 req/res」：
 * - Node：原生 IncomingMessage / ServerResponse
 * - Cloudflare：worker 里用最小适配器伪造（见 worker/cloudflare.js），
 *   这样 5000 行既有业务代码一行都不用改。
 */
const path = require("node:path");
const { URL } = require("node:url");

const { readBody, sendJson, sendText, sendBinary, parseCookies, serveStatic, Router } = require("./http");
const { userByToken, COOKIE } = require("./auth");
const { HttpError } = require("./util");

// __dirname 在 Cloudflare Worker 的 ESM 产物里不存在（静态资源走 Assets 绑定）
const HERE = typeof __dirname === "string" ? __dirname : "";
const WEB_DIR = path.join(HERE, "..", "..", "web");

const PUBLIC = new Set(["/api/auth/login", "/api/health", "/api/auth/me"]);

/**
 * 二进制上传通道：POST /api/uploads
 * 照片走这条路，不经过 JSON 解析——3 MB 的 JPEG 转成 JSON base64 会膨胀到 4 MB 且毫无必要。
 */
const UPLOAD_PATH = "/api/uploads";
const UPLOAD_LIMIT = 10 * 1024 * 1024;

function buildRouter() {
  const router = new Router();
  // 必须写成静态 require：动态拼接路径（require(mod)）在 ESM 产物里会变成
  // "Dynamic require is not supported"，Worker 启动即失败。
  const modules = [
    require("../api/auth"),
    require("../api/projects"),
    require("../api/verify"),
    require("../api/finance"),
    require("../api/system"),
    require("../api/demand"),
    require("../api/files")
  ];
  for (const mod of modules) mod.register(router);
  return router;
}

const router = buildRouter();

async function handle(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const pathname = url.pathname;
  const ip = (req.headers["x-forwarded-for"] || req.socket?.remoteAddress || "").toString().split(",")[0].trim();

  if (req.method === "OPTIONS") {
    res.writeHead(204, { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET,POST,PATCH,DELETE", "Access-Control-Allow-Headers": "Content-Type" }).end();
    return;
  }

  if (!pathname.startsWith("/api/")) {
    if (pathname === "/favicon.ico") { res.writeHead(204).end(); return; }
    if (serveStatic(res, WEB_DIR, pathname)) return;
    if (!path.extname(pathname) && serveStatic(res, WEB_DIR, "/index.html")) return;
    sendText(res, 404, "Not Found");
    return;
  }

  const match = router.match(req.method, pathname);
  if (!match) {
    sendJson(res, 404, { error: { code: "NO_ROUTE", message: `接口不存在：${req.method} ${pathname}` } });
    return;
  }

  const cookies = parseCookies(req.headers.cookie || "");
  const token = cookies[COOKIE];
  const user = userByToken(token);

  if (!PUBLIC.has(pathname) && !user) {
    sendJson(res, 401, { error: { code: "UNAUTHORIZED", message: "登录状态已失效，请重新登录" } });
    return;
  }

  try {
    let body;
    if (req.method === "POST" && pathname === UPLOAD_PATH) {
      body = await readBody(req, UPLOAD_LIMIT, { raw: true });
    } else if (["POST", "PATCH", "PUT", "DELETE"].includes(req.method)) {
      body = await readBody(req);
    } else {
      body = {};
    }
    const ctx = { req, res, params: match.params, query: Object.fromEntries(url.searchParams), body, user, token, ip };
    const out = await match.handler(ctx);

    if (out && out.__file !== undefined) {
      const f = out.__file;
      sendBinary(res, 200, f.buffer, { mime: f.mime, name: f.name });
      return;
    }
    if (out && out.__csv !== undefined) {
      sendText(res, 200, out.__csv, "text/csv; charset=utf-8", {
        "Content-Disposition": `attachment; filename="${encodeURIComponent(out.__filename)}"; filename*=UTF-8''${encodeURIComponent(out.__filename)}`,
        "Cache-Control": "no-store"
      });
      return;
    }
    if (out && out.__cookie) {
      const { __cookie, ...payload } = out;
      sendJson(res, 200, payload, { "Set-Cookie": __cookie });
      return;
    }
    sendJson(res, 200, out ?? { ok: true });
  } catch (err) {
    if (err instanceof HttpError) {
      sendJson(res, err.status, {
        error: { code: err.code, message: err.message, ...(err.extra ? { detail: err.extra } : {}) }
      });
      return;
    }
    /**
     * 存储层等基础设施模块抛的是普通 Error（storage.js 不想反向依赖 util.js 的 HttpError），
     * 但会带上 status + code。这类错误语义明确、消息是给用户看的，要原样返回，
     * 否则「未绑定 R2」会变成一句没用的「服务器内部错误」。
     * 只放行明确带 code 的，避免把未预期的异常细节泄露出去。
     */
    if (Number.isInteger(err.status) && err.status >= 400 && err.status < 600 && err.code) {
      sendJson(res, err.status, { error: { code: err.code, message: err.message } });
      return;
    }
    console.error("[500]", req.method, pathname, err);
    sendJson(res, 500, { error: { code: "INTERNAL", message: "服务器内部错误：" + err.message } });
  }
}

module.exports = { handle, router, PUBLIC, WEB_DIR };
