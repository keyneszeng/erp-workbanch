"use strict";
const fs = require("node:fs");
const path = require("node:path");

/**
 * Fail closed before deploying a production Worker.
 *
 * The checked-in Wrangler configuration still targets the legacy demo URL.
 * This guard refuses to run there, or to run without a real R2 binding.
 * Tests can point ERP_WRANGLER_CONFIG at an isolated fixture.
 */
function parseJsonc(s) {
  // A string token (including URLs) is left untouched; only comments are stripped.
  return JSON.parse(s.replace(/"(?:\\.|[^"\\])*"|\/\*[\s\S]*?\*\/|\/\/[^\r\n]*/g, (token) =>
    token.startsWith('"') ? token : ""));
}
function error(message) {
  throw new Error("部署被阻断：" + message);
}
function requireString(name) {
  const value = String(process.env[name] || "").trim();
  if (!value) error("缺少环境变量 " + name);
  return value;
}
function verify() {
  const domain = requireString("ERP_PRODUCTION_DOMAIN").toLowerCase();
  const health = requireString("ERP_HEALTHCHECK_URL");
  if (!/^[a-z0-9.-]+$/.test(domain) || domain.startsWith(".") || domain.endsWith(".")) {
    error("ERP_PRODUCTION_DOMAIN 必须是准确的域名");
  }
  if (domain === "erp.aibuild.work") error("历史演示域名不可作为本次正式生产发布目标");
  let check;
  try { check = new URL(health); } catch { error("ERP_HEALTHCHECK_URL 必须是有效的 HTTPS URL"); }
  if (check.protocol !== "https:" || check.hostname !== domain ||
      check.pathname !== "/api/health" || check.search || check.hash ||
      check.username || check.password || check.port) {
    error("健康检查必须严格匹配 https://" + domain + "/api/health");
  }

  const configPath = process.env.ERP_WRANGLER_CONFIG ||
    path.resolve(__dirname, "../wrangler.jsonc");
  const conf = parseJsonc(fs.readFileSync(configPath, "utf8"));
  const routes = Array.isArray(conf.routes) ? conf.routes : [];
  if (conf.name === "erp-workbanch") {
    error("仍在使用历史演示 Worker 名称 erp-workbanch");
  }
  if (!routes.some((r) => r.pattern === domain && r.custom_domain === true) || routes.length !== 1) {
    error("wrangler.jsonc 的唯一自定义域名必须匹配 ERP_PRODUCTION_DOMAIN");
  }
  if (!conf.durable_objects?.bindings?.some((b) =>
    b.name === "ERP_DB" && b.class_name === "ErpDatabase")) {
    error("缺少 ERP_DB Durable Object SQLite 绑定");
  }
  if (!conf.r2_buckets?.some((b) => b.binding === "ERP_FILES" &&
    typeof b.bucket_name === "string" && b.bucket_name.length > 0)) {
    error("缺少真实的 ERP_FILES R2 持久化附件桶绑定");
  }
  if (conf.vars?.ERP_DEMO_MODE === "1" || conf.env?.production?.vars?.ERP_DEMO_MODE === "1") {
    error("禁止将演示数据模式部署到生产资源");
  }
  if (!conf.assets?.run_worker_first?.includes("/api/*")) {
    error("API 路由必须先于静态资源进入 Worker");
  }
  console.log("生产部署预检通过：" + domain);
}
try { verify(); } catch (e) {
  console.error(e.message);
  process.exitCode = 1;
}
