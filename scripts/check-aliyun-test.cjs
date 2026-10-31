"use strict";
/**
 * 云服务器测试环境预检（ERP_DEPLOY_TARGET=aliyun-ecs-test）。
 *
 * 与生产门禁 check-aliyun-production.cjs 的差异，只有两处，都是被现实条件逼出来的：
 *   1. 允许 ERP_SMS_PROVIDER=console —— 短信签名/模板未审核通过，验证码写服务器日志；
 *   2. 不强制 ERP_PRODUCTION_DOMAIN —— 域名未备案，只能先用 IP:8080 访问。
 *
 * 其余一律与生产同等严格：真实数据库、强 Secret、独立持久化目录、只监听本机。
 * 这是「测试环境」，不是「宽松环境」：它绝不能承载真实业务数据。
 * Fail closed，且不打印任何密钥。
 */
const path = require("node:path");
const DATA_ROOT = "/var/lib/erp-test/";
function fail(message) { throw new Error("云服务器测试环境拒绝：" + message); }
function required(env, key) {
  const v = String(env[key] ?? "").trim();
  if (!v) fail("缺少 " + key);
  return v;
}
function check(env = process.env) {
  if (env.ERP_DEPLOY_TARGET !== "aliyun-ecs-test")
    fail("ERP_DEPLOY_TARGET 必须为 aliyun-ecs-test（生产用 aliyun-ecs，两者不可混用）");
  if (env.ERP_DEMO_MODE !== "0") fail("测试环境同样必须显式 ERP_DEMO_MODE=0，不得复用演示数据");
  if (env.NODE_ENV !== "production") fail("NODE_ENV 必须为 production");
  if (env.ERP_SMS_TEST_MODE === "1" || env.ERP_DB_BACKEND === "do-sqlite")
    fail("禁止启用任何短信或数据库模拟模式");

  // 域名可空（未备案阶段先用 IP 访问），但一旦填了就必须是合法主机名或 IP
  const domain = String(env.ERP_PRODUCTION_DOMAIN || "").trim().toLowerCase();
  if (domain) {
    const isIp = /^(\d{1,3}\.){3}\d{1,3}$/.test(domain);
    const isHost = /^(?=.{4,253}$)[a-z0-9]+(?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9]+(?:[a-z0-9-]*[a-z0-9])?)+$/.test(domain);
    if (!isIp && !isHost) fail("ERP_PRODUCTION_DOMAIN 格式不正确（可留空，或填合法域名/IP）");
    if (domain === "erp.aibuild.work") fail("erp.aibuild.work 是 Cloudflare 演示版，不得占用");
  }
  if (!/^1[3-9]\d{9}$/.test(required(env, "ERP_BOOTSTRAP_ADMIN_PHONE")))
    fail("ERP_BOOTSTRAP_ADMIN_PHONE 必须是有效的中国大陆手机号");

  const provider = required(env, "ERP_SMS_PROVIDER");
  if (provider === "console") {
    // 允许：验证码只写服务器日志，不发真实短信
  } else if (provider === "aliyun") {
    for (const key of ["ERP_ALIYUN_SMS_ACCESS_KEY_ID", "ERP_ALIYUN_SMS_ACCESS_KEY_SECRET",
      "ERP_ALIYUN_SMS_SIGN_NAME", "ERP_ALIYUN_SMS_TEMPLATE_CODE"]) required(env, key);
  } else if (provider === "tencent") {
    for (const key of ["ERP_TENCENT_SECRET_ID", "ERP_TENCENT_SECRET_KEY", "ERP_TENCENT_SMS_APP_ID",
      "ERP_TENCENT_SMS_SIGN", "ERP_TENCENT_SMS_TEMPLATE_ID"]) required(env, key);
  } else {
    fail("ERP_SMS_PROVIDER 只能是 console（测试）、aliyun 或 tencent");
  }
  const fixed = String(env.ERP_TEST_FIXED_SMS_CODE || "").trim();
  if (fixed && !/^\d{6}$/.test(fixed)) fail("ERP_TEST_FIXED_SMS_CODE 必须是 6 位数字或留空");
  if (fixed && provider !== "console") fail("ERP_TEST_FIXED_SMS_CODE 仅可与 console 通道同时使用");

  const secret = required(env, "ERP_SECRET");
  if (secret.length < 32 || new Set(secret).size < 8) fail("ERP_SECRET 必须是独立的高熵随机长密钥，至少 32 字符");

  const file = required(env, "ERP_DB");
  const uploads = required(env, "ERP_UPLOAD_DIR");
  for (const [name, value] of [["ERP_DB", file], ["ERP_UPLOAD_DIR", uploads]]) {
    if (!path.isAbsolute(value) || path.normalize(value) !== value)
      fail(name + " 必须是规范化的绝对持久化路径");
    if (!value.startsWith(DATA_ROOT)) fail(name + " 必须在 " + DATA_ROOT + " 下（与生产库物理隔离）");
    if (/\/(?:tmp|test|demo)(?:\/|$)/i.test(value)) fail(name + " 禁止使用临时或演示目录");
  }
  if (path.extname(file) !== ".db") fail("ERP_DB 必须指向 SQLite .db 数据库文件");
  if (uploads === file || uploads.startsWith(file + "/")) fail("附件目录与数据库路径不得重叠");
  if (env.ERP_HOST !== "127.0.0.1") fail("ERP_HOST 必须为 127.0.0.1，只经本机 Nginx 反向代理对外");
  if (String(env.ERP_PORT) !== "8788") fail("ERP_PORT 必须为 8788，与测试 Nginx 配置保持一致");
  if (env.ERP_TRUST_PROXY !== "1") fail("ERP_TRUST_PROXY 必须为 1（只信任本机 Nginx）");
  if (env.ERP_SESSION_FALLBACK === "1") fail("持久化 SQLite 不允许无状态会话回退");
  return { target: "aliyun-ecs-test", domain: domain || "(未配置，按 IP 访问)" };
}
if (require.main === module) {
  try {
    const result = check();
    console.log("云服务器测试环境预检通过：" + result.domain + "（未执行实际部署）");
    console.log("提示：本环境仅供功能验证，禁止录入真实业务数据。");
  } catch (err) {
    console.error(err.message);
    process.exitCode = 1;
  }
}
module.exports = { check };
