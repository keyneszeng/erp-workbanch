"use strict";

// Cloudflare Durable Object binds env explicitly; Node uses process.env by default.
let config = {
  demo: process.env.ERP_DEMO_MODE === "1",
  bootstrapPhone: process.env.ERP_BOOTSTRAP_ADMIN_PHONE || "",
  sms: smsFrom(process.env)
};
function smsFrom(env) {
  return { provider: String(env.ERP_SMS_PROVIDER || ""), secretId: String(env.ERP_TENCENT_SECRET_ID || ""),
    secretKey: String(env.ERP_TENCENT_SECRET_KEY || ""), sdkAppId: String(env.ERP_TENCENT_SMS_APP_ID || ""),
    signName: String(env.ERP_TENCENT_SMS_SIGN || ""), templateId: String(env.ERP_TENCENT_SMS_TEMPLATE_ID || ""),
    region: String(env.ERP_TENCENT_SMS_REGION || "ap-guangzhou"), testMode: String(env.ERP_SMS_TEST_MODE || "") };
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
