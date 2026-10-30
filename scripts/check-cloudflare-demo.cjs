"use strict";
const fs = require("node:fs");
const path = require("node:path");
function parseJsonc(text) {
  return JSON.parse(text.replace(/"(?:\\.|[^"\\])*"|\/\*[\s\S]*?\*\/|\/\/[^\r\n]*/g, x =>
    x.startsWith('"') ? x : ""));
}
function assertDemo(config) {
  if (config.name !== "erp-workbanch") throw new Error("演示 Worker 名称不可更改");
  if (!Array.isArray(config.routes) || config.routes.length !== 1 ||
      config.routes[0].pattern !== "erp.aibuild.work" || config.routes[0].custom_domain !== true)
    throw new Error("Cloudflare 只能绑定 erp.aibuild.work 演示域名");
  if (config.vars?.ERP_DEMO_MODE !== "1") throw new Error("Cloudflare 必须显式 ERP_DEMO_MODE=1");
  const forbidden = ["ERP_BOOTSTRAP_ADMIN_PHONE", "ERP_TENCENT_SECRET_KEY", "ERP_TENCENT_SECRET_ID",
    "ERP_SECRET", "ERP_PRODUCTION_DOMAIN", "ERP_SMS_PROVIDER"];
  for (const key of forbidden) if (key in (config.vars || {})) throw new Error("禁止在 Cloudflare 演示配置包含生产变量：" + key);
}
try {
  const file = process.env.ERP_WRANGLER_CONFIG || path.join(__dirname, "..", "wrangler.jsonc");
  assertDemo(parseJsonc(fs.readFileSync(file, "utf8")));
  console.log("Cloudflare 演示配置检查通过（仅检查，不执行部署）");
} catch (err) {
  console.error("Cloudflare 演示配置错误：" + err.message);
  process.exitCode = 1;
}
module.exports = { parseJsonc, assertDemo };
