"use strict";
/**
 * 生产短信验证：腾讯云 SMS（TC3-HMAC-SHA256），验证码仅以带盐散列持久化。
 * 测试模式只有 NODE_ENV=test + 显式 ERP_SMS_TEST_MODE=1 才能启用，
 * 真实部署必须配置腾讯云密钥、签名、模板及应用 ID。
 */
const crypto = require("node:crypto");
const { db } = require("./db");
const { smsSettings } = require("./runtime");
const { HttpError, bad } = require("./util");
const { normalizePhone } = require("./phone-whitelist");
const TTL_MS = 5 * 60 * 1000;
const COOLDOWN_MS = 60 * 1000;
const DAILY_LIMIT = 10;
const MAX_ATTEMPTS = 5;

function configured() {
  const c = smsSettings();
  if (c.provider === "test") return process.env.NODE_ENV === "test" && c.testMode === "1";
  return c.provider === "tencent" && ["secretId", "secretKey", "sdkAppId", "signName", "templateId"]
    .every(k => !!c[k]);
}
function assertConfigured() {
  if (!configured()) throw new Error("生产系统未配置有效短信通道：ERP_SMS_PROVIDER=tencent 与腾讯云短信凭据、模板、签名均为必填");
}
function hmac(key, data, encoding) {
  return crypto.createHmac("sha256", key).update(data).digest(encoding);
}
async function sendTencent(phone, code) {
  const c = smsSettings();
  const body = JSON.stringify({
    SmsSdkAppId: c.sdkAppId,
    SignName: c.signName,
    TemplateId: c.templateId,
    TemplateParamSet: [code, "5"],
    PhoneNumberSet: ["+86" + phone]
  });
  const timestamp = Math.floor(Date.now() / 1000);
  const date = new Date(timestamp * 1000).toISOString().slice(0, 10);
  const host = "sms.tencentcloudapi.com";
  const hashed = crypto.createHash("sha256").update(body).digest("hex");
  const canonical = ["POST", "/", "", "content-type:application/json; charset=utf-8", "host:" + host,
    "x-tc-action:sendsms", "", "content-type;host;x-tc-action", hashed].join("\n");
  const scope = date + "/sms/tc3_request";
  const str = ["TC3-HMAC-SHA256", timestamp, scope, crypto.createHash("sha256").update(canonical).digest("hex")].join("\n");
  const secretDate = hmac("TC3" + c.secretKey, date);
  const secretService = hmac(secretDate, "sms");
  const secretSigning = hmac(secretService, "tc3_request");
  const signature = hmac(secretSigning, str, "hex");
  const authorization = "TC3-HMAC-SHA256 Credential=" + c.secretId + "/" + scope +
    ", SignedHeaders=content-type;host;x-tc-action, Signature=" + signature;
  const response = await fetch("https://" + host + "/", {
    method: "POST", headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Host": host,
      "X-TC-Action": "SendSms",
      "X-TC-Version": "2021-01-11",
      "X-TC-Region": c.region || "ap-guangzhou",
      "X-TC-Timestamp": String(timestamp),
      "Authorization": authorization
    }, body
  });
  if (!response.ok) throw new Error("腾讯云短信服务暂不可用");
  const data = await response.json();
  if (data.Response?.Error || data.Response?.SendStatusSet?.[0]?.Code !== "Ok") {
    throw new Error("短信服务拒绝发送，请检查签名、模板和额度");
  }
}
function digest(salt, phone, code) {
  return crypto.createHash("sha256").update(salt + ":" + phone + ":" + code).digest("hex");
}
async function sendPasswordCode(user) {
  assertConfigured();
  const phone = normalizePhone(user.phone);
  const id = Number(user.id);
  const old = db.prepare("SELECT * FROM sms_challenges WHERE user_id = ?").get(id);
  const ms = Date.now(), day = new Date(ms).toISOString().slice(0, 10);
  if (old && ms - Number(old.sent_ms) < COOLDOWN_MS)
    throw new HttpError(429, "SMS_COOLDOWN", "验证码发送过于频繁，请 60 秒后再试");
  const count = old && old.day_key === day ? Number(old.day_count) : 0;
  if (count >= DAILY_LIMIT) throw new HttpError(429, "SMS_DAILY_LIMIT", "今日验证码发送次数已达上限");
  const code = smsSettings().provider === "test" ? "654321" : String(crypto.randomInt(100000, 1000000));
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = digest(salt, phone, code);
  // 先占用本人的发送额度，避免并发重复调用供应商；发送失败仅移除本次挑战。
  db.prepare("INSERT INTO sms_challenges (user_id,phone,salt,code_hash,sent_ms,expires_ms,attempts,day_key,day_count) VALUES (?,?,?,?,?,?,0,?,?) ON CONFLICT(user_id) DO UPDATE SET phone=excluded.phone,salt=excluded.salt,code_hash=excluded.code_hash,sent_ms=excluded.sent_ms,expires_ms=excluded.expires_ms,attempts=0,day_key=excluded.day_key,day_count=excluded.day_count")
    .run(id, phone, salt, hash, ms, ms + TTL_MS, day, count + 1);
  try {
    if (smsSettings().provider === "tencent") await sendTencent(phone, code);
  } catch (e) {
    // 保留发送频次记录：供应商故障时也不能利用删除挑战无限重试。
    console.error("短信发送失败", e.message);
    throw new HttpError(503, "SMS_UNAVAILABLE", "验证码暂时无法发送，请稍后重试");
  }
  return { message: "验证码已发送至白名单登记的手机", expiresIn: 300, retryAfter: 60,
    maskedPhone: phone.slice(0, 3) + "****" + phone.slice(-4) };
}
function consumePasswordCode(user, value) {
  const code = String(value ?? "").trim();
  if (!/^\d{6}$/.test(code)) throw bad("请输入 6 位短信验证码");
  const r = db.prepare("SELECT * FROM sms_challenges WHERE user_id = ?").get(Number(user.id));
  if (!r || r.phone !== user.phone || Date.now() > Number(r.expires_ms))
    throw bad("验证码不存在或已过期，请重新获取");
  if (r.attempts >= MAX_ATTEMPTS) throw new HttpError(429, "SMS_ATTEMPTS", "验证码错误次数过多，请重新获取");
  db.prepare("UPDATE sms_challenges SET attempts = attempts + 1 WHERE user_id = ?").run(Number(user.id));
  const want = Buffer.from(r.code_hash, "hex");
  const got = Buffer.from(digest(r.salt, r.phone, code), "hex");
  if (want.length !== got.length || !crypto.timingSafeEqual(want, got)) throw bad("短信验证码错误");
  // 不删除记录，保留当天发送次数并让验证码立刻失效，禁止复用。
  db.prepare("UPDATE sms_challenges SET code_hash = '', expires_ms = 0 WHERE user_id = ?").run(Number(user.id));
}
module.exports = { configured, assertConfigured, sendPasswordCode, consumePasswordCode };
