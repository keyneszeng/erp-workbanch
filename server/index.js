"use strict";
const http = require("node:http");
const path = require("node:path");
const { URL } = require("node:url");

const { migrate, DB_FILE } = require("./lib/db");
const { seed } = require("./lib/seed");
const { readBody, sendJson, sendText, parseCookies, serveStatic, Router } = require("./lib/http");
const { userByToken, pruneSessions, COOKIE } = require("./lib/auth");
const { HttpError } = require("./lib/util");
const { ROLES } = require("./lib/rbac");

const PORT = Number(process.env.ERP_PORT || 8787);
const HOST = process.env.ERP_HOST || "127.0.0.1";
const WEB_DIR = path.join(__dirname, "..", "web");

migrate();
const seeded = seed();

const router = new Router();
for (const mod of ["./api/auth", "./api/projects", "./api/verify", "./api/finance", "./api/system", "./api/demand"]) {
  require(mod).register(router);
}

const PUBLIC = new Set(["/api/auth/login", "/api/health", "/api/auth/me"]);

async function handler(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const pathname = url.pathname;
  const ip = (req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").toString().split(",")[0].trim();

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

const server = http.createServer(handler);

function startLocalServer() {
  server.listen(PORT, HOST, () => {
    const line = [
      "",
      "  协会会议执行 ERP  ·  v1.0.4",
      `  服务地址   http://${HOST}:${PORT}`,
      `  数据库     ${DB_FILE}`,
      `  种子数据   ${seeded.skipped ? "已存在，跳过" : `已初始化（${seeded.projects} 个项目 / ${seeded.users} 个账号）`}`,
      "  演示账号   admin / assoc / exec / finance / guest   密码均为 123456",
      ""
    ].join("\n");
    console.log(line);
  });

  pruneSessions();
  setInterval(pruneSessions, 30 * 60 * 1000).unref();

  for (const sig of ["SIGINT", "SIGTERM"]) {
    process.on(sig, () => {
      console.log("\n正在关闭服务…");
      server.close(() => process.exit(0));
    });
  }
}

if (require.main === module) {
  startLocalServer();
} else {
  pruneSessions();
}

module.exports = { server, handler, ROLES };
