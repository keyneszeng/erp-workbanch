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

const PUBLIC = new Set(["/api/auth/login", "/api/health", "/api/auth/me", "/api/public/prep-invitation", "/api/public/prep-invitation-pdf", "/api/public/prep-invitation/respond"]);

/**
 * 安全响应头 —— V1.2.17 SEC-03。
 *
 * 测试报告实测：除了 Cloudflare 自己加的 server / cf-ray，一个安全头都没有。
 * 演示环境能容忍，但这是「上线前必配项」，而且改动成本几乎为零。
 *
 * ⚠️ X-Frame-Options 用 SAMEORIGIN 而不是报告建议的 DENY：
 * 合同详情弹窗是用 iframe 内嵌同源的 PDF 原件（V1.2.14），DENY 会把它一起毙掉。
 * SAMEORIGIN 同样能挡住第三方站点套壳点击劫持，这是这个应用真正的威胁模型。
 *
 * CSP 先上 Report-Only：页面里还有内联样式（style="..."）与内联 SVG，
 * 直接强制会白屏；先观察一段时间报告，再决定是否转 enforce。
 */
const SECURITY_HEADERS = {
  "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "SAMEORIGIN",
  "Referrer-Policy": "same-origin",
  "Permissions-Policy": "geolocation=(), microphone=(), camera=()",
  "Content-Security-Policy-Report-Only":
    "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; " +
    "script-src 'self'; frame-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'"
};

/** 请求是不是走的 https —— 决定 Cookie 要不要加 Secure */
function isSecureRequest(req, url) {
  const proto = String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim();
  if (proto) return proto === "https";
  return url.protocol === "https:";
}

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
    require("../api/files"),
    require("../api/archive-pdf"),
    require("../api/prep-invitations"),
    require("../api/prep-admin"),
    require("../api/project-ledger")
  ];
  for (const mod of modules) mod.register(router);
  return router;
}

const router = buildRouter();

async function handle(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const pathname = url.pathname;
  const ip = (req.headers["x-forwarded-for"] || req.socket?.remoteAddress || "").toString().split(",")[0].trim();

  // 每个响应都带安全头（setHeader 与后续 writeHead 的 headers 会合并，writeHead 优先）
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);

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
    /**
     * V1.2.17 API-01：路径在、方法不对 → 405 + Allow。
     * 原来一律 404 NO_ROUTE，客户端拿到「接口不存在」会去怀疑地址写错了，
     * 实际只是方法用错（PUT 而不是 PATCH）。
     */
    const allow = router.allowedMethods(pathname);
    if (allow.length) {
      sendJson(res, 405, { error: { code: "METHOD_NOT_ALLOWED", message: `${pathname} 不支持 ${req.method}，允许：${allow.join(" / ")}` } }, { Allow: allow.join(", ") });
      return;
    }
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
    const ctx = { req, res, params: match.params, query: Object.fromEntries(url.searchParams), body, user, token, ip, secure: isSecureRequest(req, url) };
    const out = await match.handler(ctx);

    if (out && out.__file !== undefined) {
      const f = out.__file;
      sendBinary(res, 200, f.buffer, { mime: f.mime, name: f.name,
        cache: f.cache || "private, max-age=86400", disposition: f.download ? "attachment" : "inline" });
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
