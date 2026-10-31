"use strict";

// Cloudflare Durable Object binds env explicitly; Node uses process.env by default.
let config = {
  demo: process.env.ERP_DEMO_MODE === "1",
  bootstrapPhone: process.env.ERP_BOOTSTRAP_ADMIN_PHONE || "",
  sms: smsFrom(process.env)
};
function smsFrom(env) {
  const provider = String(env.ERP_SMS_PROVIDER || "");
  const aliyun = provider === "aliyun";
  return {
    provider,
    // 腾讯云 SMS
    secretId: String(env.ERP_TENCENT_SECRET_ID || ""),
    secretKey: String(env.ERP_TENCENT_SECRET_KEY || ""),
    sdkAppId: String(env.ERP_TENCENT_SMS_APP_ID || ""),
    templateId: String(env.ERP_TENCENT_SMS_TEMPLATE_ID || ""),
    // 阿里云短信（Dysmsapi）
    accessKeyId: String(env.ERP_ALIYUN_SMS_ACCESS_KEY_ID || ""),
    accessKeySecret: String(env.ERP_ALIYUN_SMS_ACCESS_KEY_SECRET || ""),
    templateCode: String(env.ERP_ALIYUN_SMS_TEMPLATE_CODE || ""),
    // 签名两家共用同一个语义，按 provider 取值，避免混用两边配置
    signName: String(aliyun ? (env.ERP_ALIYUN_SMS_SIGN_NAME || "")
      : (env.ERP_TENCENT_SMS_SIGN || "")),
    region: String((aliyun ? env.ERP_ALIYUN_SMS_REGION : env.ERP_TENCENT_SMS_REGION)
      || (aliyun ? "cn-hangzhou" : "ap-guangzhou")),
    testMode: String(env.ERP_SMS_TEST_MODE || "")
  };
}
function configureRuntime(env = {}) {
  config = {
    demo: String(env.ERP_DEMO_MODE || "") === "1",
    bootstrapPhone: String(env.ERP_BOOTSTRAP_ADMIN_PHONE || ""),
    sms: smsFrom(env)
  };
}
function isDemoMode() { return config.demo; }
function bootstrapAdminPhone() { return config.bootstrapPhone; }
function smsSettings() { return config.sms; }
module.exports = { configureRuntime, isDemoMode, bootstrapAdminPhone, smsSettings };
