"use strict";
/**
 * ECS deployment preflight. Fail closed; DO NOT log secrets.
 * Invoked by systemd ExecStartPre and can be invoked manually before release.
 */
const path = require("node:path");
function fail(message) { throw new Error("阿里云 ECS 生产部署拒绝：" + message); }
function required(env, key) {
  const v = String(env[key] ?? "").trim();
  if (!v) fail("缺少 " + key);
  return v;
}
function check(env = process.env) {
  if (env.ERP_DEPLOY_TARGET !== "aliyun-ecs") fail("ERP_DEPLOY_TARGET 必须为 aliyun-ecs");
  if (env.ERP_DEMO_MODE !== "0") fail("正式部署必须显式 ERP_DEMO_MODE=0");
  if (env.NODE_ENV !== "production") fail("NODE_ENV 必须为 production");
  if (env.ERP_SMS_TEST_MODE === "1" || env.ERP_DB_BACKEND === "do-sqlite")
    fail("禁止启用任何短信或数据库模拟模式");

  const domain = required(env, "ERP_PRODUCTION_DOMAIN").toLowerCase();
  if (!/^(?=.{4,253}$)[a-z0-9]+(?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9]+(?:[a-z0-9-]*[a-z0-9])?)+$/.test(domain))
    fail("生产域名格式不正确");
  if (domain === "erp.aibuild.work") fail("erp.aibuild.work 永远是演示版，不得作为生产域名");
  if (!/^1[3-9]\d{9}$/.test(required(env, "ERP_BOOTSTRAP_ADMIN_PHONE")))
    fail("ERP_BOOTSTRAP_ADMIN_PHONE 必须是有效的中国大陆手机号");

  if (env.ERP_SMS_PROVIDER !== "tencent") fail("正式短信提供商必须配置 ERP_SMS_PROVIDER=tencent");
  for (const key of ["ERP_TENCENT_SECRET_ID","ERP_TENCENT_SECRET_KEY","ERP_TENCENT_SMS_APP_ID",
    "ERP_TENCENT_SMS_SIGN","ERP_TENCENT_SMS_TEMPLATE_ID"]) required(env, key);
  // WeChat is optional until Mini Program launch; enabling it requires actual credentials.
  if (env.ERP_MINIPROGRAM_ENABLED === "1") {
    if (!/^wx[0-9a-f]{16}$/i.test(required(env, "ERP_WECHAT_APP_ID")))
      fail("ERP_WECHAT_APP_ID 不是有效微信小程序 AppID");
    required(env, "ERP_WECHAT_APP_SECRET");
    if (env.ERP_WECHAT_TEST_MODE === "1") fail("生产环境不可启用微信测试身份");
  } else if (env.ERP_MINIPROGRAM_ENABLED && env.ERP_MINIPROGRAM_ENABLED !== "0") {
    fail("ERP_MINIPROGRAM_ENABLED 必须为 0 或 1");
  }
  const secret = required(env, "ERP_SECRET");
  if (secret.length < 32 || new Set(secret).size < 8) fail("ERP_SECRET 必须是独立的高熵随机长密钥，至少 32 字符");

  const file = required(env, "ERP_DB");
  const uploads = required(env, "ERP_UPLOAD_DIR");
  for (const [name, value] of [["ERP_DB",file],["ERP_UPLOAD_DIR",uploads]]) {
    if (!path.isAbsolute(value) || path.normalize(value) !== value)
      fail(name + " 必须是规范化的绝对持久化路径");
    if (!value.startsWith("/var/lib/erp/")) fail(name + " 必须在 /var/lib/erp/ 持久数据目录下");
    if (/\/(?:tmp|test|demo)(?:\/|$)/i.test(value)) fail(name + " 禁止使用临时或演示目录");
  }
  if (path.extname(file) !== ".db") fail("ERP_DB 必须指向 SQLite .db 数据库文件");
  if (uploads === file || uploads.startsWith(file + "/")) fail("附件目录与数据库路径不得重叠");
  if (env.ERP_HOST !== "127.0.0.1") fail("ERP_HOST 必须为 127.0.0.1，仅供本机 Nginx 反向代理访问");
  if (String(env.ERP_PORT) !== "8787") fail("ERP_PORT 必须为 8787，与 Nginx 配置保持一致");
  if (env.ERP_TRUST_PROXY !== "1") fail("ERP_TRUST_PROXY 必须为 1（只信任本机 Nginx）");
  if (env.ERP_SESSION_FALLBACK === "1") fail("正式持久化 SQLite 不允许无状态会话回退");
  if(env.ERP_REQUIRE_VERIFIED_PAYEES && !["0","1"].includes(env.ERP_REQUIRE_VERIFIED_PAYEES))
    fail("ERP_REQUIRE_VERIFIED_PAYEES 必须为 0 或 1");
  if(env.ERP_FINANCIAL_DATA_KEY && !/^[0-9a-f]{64}$/i.test(env.ERP_FINANCIAL_DATA_KEY))
    fail("ERP_FINANCIAL_DATA_KEY 必须为独立 32 字节随机密钥（64 位十六进制）");
  if(env.ERP_REQUIRE_VERIFIED_PAYEES==="1" && !/^[0-9a-f]{64}$/i.test(String(env.ERP_FINANCIAL_DATA_KEY||"")))
    fail("启用强制核销收款人选择必须先配置 ERP_FINANCIAL_DATA_KEY");
  if (env.ERP_OCR_ENABLED && !["0","1"].includes(env.ERP_OCR_ENABLED))
    fail("ERP_OCR_ENABLED 必须为 0 或 1");
  if (env.ERP_OCR_ENABLED === "1") {
    const { spawnSync } = require("node:child_process");
    for(const cmd of ["tesseract","pdfinfo","pdftotext","pdftoppm"]){
      const args = cmd === "tesseract" ? ["--list-langs"] : ["-v"];
      const res=spawnSync(cmd,args,{encoding:"utf8",timeout:5000,maxBuffer:65536});
      if(res.error || res.status!==0)fail("已启用 OCR 但缺少可执行依赖 "+cmd+"，请先安装 tesseract-ocr 和 poppler-utils");
      if(cmd==="tesseract") {
        const langs=(String(res.stdout||"")+"\n"+String(res.stderr||"")).split(/\s+/);
        if(!langs.includes("chi_sim") || !langs.includes("eng"))
          fail("OCR 必须安装 chi_sim 和 eng 两种语言模型");
      }
    }
  }
  return { target: "aliyun-ecs", domain };
}
if (require.main === module) {
  try {
    const result = check();
    console.log("阿里云 ECS 生产环境预检通过：" + result.domain + "（未执行实际部署）");
  } catch (err) {
    console.error(err.message);
    process.exitCode = 1;
  }
}
module.exports = { check };
