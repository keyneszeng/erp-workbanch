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

const { readBody, sendJson, sendText, parseCookies, serveStatic, Router } = require("./http");
const { userByToken, COOKIE } = require("./auth");
const { HttpError } = require("./util");

// __dirname 在 Cloudflare Worker 的 ESM 产物里不存在（静态资源走 Assets 绑定）
const HERE = typeof __dirname === "string" ? __dirname : "";
const WEB_DIR = path.join(HERE, "..", "..", "web");

const PUBLIC = new Set(["/api/auth/login", "/api/health", "/api/auth/me"]);

function buildRouter() {
  const router = new Router();
  for (const mod of ["./../api/auth", "./../api/projects", "./../api/verify", "./../api/finance", "./../api/system", "./../api/demand"]) {
    require(mod).register(router);
  }
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
    const body = ["POST", "PATCH", "PUT", "DELETE"].includes(req.method) ? await readBody(req) : {};
    const ctx = { req, res, params: match.params, query: Object.fromEntries(url.searchParams), body, user, token, ip };
    const out = await match.handler(ctx);

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
    console.error("[500]", req.method, pathname, err);
    sendJson(res, 500, { error: { code: "INTERNAL", message: "服务器内部错误：" + err.message } });
  }
}

module.exports = { handle, router, PUBLIC, WEB_DIR };
