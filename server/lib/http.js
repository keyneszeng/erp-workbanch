"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { URL } = require("node:url");
const { HttpError } = require("./util");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
  ".csv": "text/csv; charset=utf-8"
};

function readBody(req, limit = 2 * 1024 * 1024, { raw = false } = {}) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let settled = false;
    const chunks = [];
    const fail = (err) => {
      if (settled) return;
      settled = true;
      chunks.length = 0;
      reject(err);
    };
    req.on("data", (c) => {
      if (settled) return;
      size += c.length;
      if (size > limit) {
        // 继续把剩余字节读完（丢弃），否则直接断开会让客户端收到 ECONNRESET 而非 413
        req.resume();
        fail(new HttpError(413, "PAYLOAD_TOO_LARGE", `请求体超过上限（${Math.round(limit / 1024 / 1024)} MB）`));
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      if (settled) return;
      settled = true;
      const buf = Buffer.concat(chunks);
      // raw 模式：原样返回二进制，不做任何编码转换（照片 / PDF 走这条路）
      if (raw) return resolve(buf);
      const rawText = buf.toString("utf8");
      if (!rawText) return resolve({});
      const type = req.headers["content-type"] || "";
      try {
        if (type.includes("application/json")) return resolve(JSON.parse(rawText));
        if (type.includes("application/x-www-form-urlencoded")) {
          return resolve(Object.fromEntries(new URLSearchParams(rawText)));
        }
        return resolve(JSON.parse(rawText));
      } catch {
        return resolve({});
      }
    });
    req.on("error", (err) => fail(err));
  });
}

/** 二进制响应（文件下载） */
function sendBinary(res, status, buffer, { mime = "application/octet-stream", name = "", cache = "private, max-age=86400" } = {}) {
  const headers = {
    "Content-Type": mime,
    "Content-Length": buffer.length,
    "Cache-Control": cache,
    // 图片是用户上传的内容，禁止浏览器猜类型，避免把 HTML 当图片执行
    "X-Content-Type-Options": "nosniff"
  };
  if (name) {
    headers["Content-Disposition"] = `inline; filename="${encodeURIComponent(name)}"; filename*=UTF-8''${encodeURIComponent(name)}`;
  }
  res.writeHead(status, headers);
  res.end(buffer);
}

function sendJson(res, status, data, headers = {}) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
    ...headers
  });
  res.end(body);
}

function sendText(res, status, text, type = "text/plain; charset=utf-8", headers = {}) {
  const body = Buffer.from(text, "utf8");
  res.writeHead(status, { "Content-Type": type, "Content-Length": body.length, ...headers });
  res.end(body);
}

function parseCookies(header = "") {
  const out = {};
  for (const part of String(header).split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  }
  return out;
}

function cookieHeader(name, value, { maxAge = 0, httpOnly = true, sameSite = "Lax", path: p = "/" } = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`, `Path=${p}`, `SameSite=${sameSite}`];
  if (httpOnly) parts.push("HttpOnly");
  if (maxAge) parts.push(`Max-Age=${maxAge}`);
  return parts.join("; ");
}

/** 静态资源服务（带目录穿越防护） */
function serveStatic(res, rootDir, urlPath) {
  let rel = decodeURIComponent(urlPath.split("?")[0]);
  if (rel === "/" || rel === "") rel = "/index.html";
  const file = path.join(rootDir, path.normalize(rel).replace(/^(\.\.[/\\])+/, ""));
  if (!file.startsWith(path.resolve(rootDir))) {
    res.writeHead(403).end("Forbidden");
    return true;
  }
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return false;
  const ext = path.extname(file).toLowerCase();
  const body = fs.readFileSync(file);
  res.writeHead(200, {
    "Content-Type": MIME[ext] || "application/octet-stream",
    "Content-Length": body.length,
    "Cache-Control": ext === ".html" ? "no-store" : "public, max-age=60"
  });
  res.end(body);
  return true;
}

/** 极简路由器：/api/projects/:id/verify/steps/:no */
class Router {
  constructor() {
    this.routes = [];
  }
  add(method, pattern, handler) {
    const keys = [];
    const rx = new RegExp(
      "^" + pattern.replace(/\/:([A-Za-z_]\w*)/g, (_, k) => { keys.push(k); return "/([^/]+)"; }) + "/?$"
    );
    this.routes.push({ method, rx, keys, handler });
    return this;
  }
  get(p, h) { return this.add("GET", p, h); }
  post(p, h) { return this.add("POST", p, h); }
  patch(p, h) { return this.add("PATCH", p, h); }
  put(p, h) { return this.add("PUT", p, h); }
  delete(p, h) { return this.add("DELETE", p, h); }
  match(method, pathname) {
    for (const r of this.routes) {
      if (r.method !== method) continue;
      const m = r.rx.exec(pathname);
      if (!m) continue;
      const params = {};
      r.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); });
      return { handler: r.handler, params };
    }
    return null;
  }
}

module.exports = { readBody, sendJson, sendText, sendBinary, parseCookies, cookieHeader, serveStatic, Router, MIME };
