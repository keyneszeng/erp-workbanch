"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { buildAliyunRequest, configured } = require("../server/lib/sms");
const { configureRuntime } = require("../server/lib/runtime");

const settings = {
  accessKeyId: "LTAI-CI-ONLY-ID",
  accessKeySecret: "CI-ONLY-SECRET",
  signName: "会规化",
  templateCode: "SMS_000000",
  region: "cn-hangzhou"
};
const FIXED_MS = Date.UTC(2026, 9, 31, 12, 0, 0);

test("阿里云短信：规范化查询串按参数名排序并做 RFC3986 编码", () => {
  const r = buildAliyunRequest(settings, "13800138000", "123456", FIXED_MS, "fixed-nonce");
  const keys = r.canonical.split("&").map(pair => pair.split("=")[0]);
  assert.deepEqual(keys, [...keys].sort(), "参数必须按 key 升序排列");
  assert.match(r.canonical, /Timestamp=2026-10-31T12%3A00%3A00Z/);
  assert.match(r.canonical, /TemplateParam=%7B%22code%22%3A%22123456%22%7D/);
  assert.match(r.canonical, /Action=SendSms/);
  assert.match(r.canonical, /Version=2017-05-25/);
  assert.match(r.canonical, /SignatureMethod=HMAC-SHA1/);
  assert.match(r.stringToSign, /^GET&%2F&/);
  assert.match(r.url, /^https:\/\/dysmsapi\.aliyuncs\.com\/\?Signature=/);
});

test("阿里云短信：签名对同一输入稳定，对验证码变化敏感", () => {
  const a = buildAliyunRequest(settings, "13800138000", "123456", FIXED_MS, "n1");
  const b = buildAliyunRequest(settings, "13800138000", "123456", FIXED_MS, "n1");
  const c = buildAliyunRequest(settings, "13800138000", "654321", FIXED_MS, "n1");
  assert.equal(a.signature, b.signature, "同样入参必须产生同样签名");
  assert.notEqual(a.signature, c.signature, "验证码不同签名必须不同");
  assert.equal(Buffer.from(a.signature, "base64").length, 20, "HMAC-SHA1 签名为 20 字节");
});

test("阿里云短信：手机号不带 +86 前缀，模板参数只含验证码", () => {
  const r = buildAliyunRequest(settings, "13800138000", "000000", FIXED_MS, "n2");
  assert.match(r.canonical, /PhoneNumbers=13800138000/);
  assert.doesNotMatch(r.canonical, /%2B86/, "阿里云国际号码才用 +86，国内直接 11 位");
});

test("阿里云短信：缺少任一凭据即视为未配置", () => {
  const full = {
    ERP_SMS_PROVIDER: "aliyun",
    ERP_ALIYUN_SMS_ACCESS_KEY_ID: "id",
    ERP_ALIYUN_SMS_ACCESS_KEY_SECRET: "secret",
    ERP_ALIYUN_SMS_SIGN_NAME: "签名",
    ERP_ALIYUN_SMS_TEMPLATE_CODE: "SMS_1"
  };
  configureRuntime(full);
  assert.equal(configured(), true);
  for (const key of ["ERP_ALIYUN_SMS_ACCESS_KEY_ID", "ERP_ALIYUN_SMS_ACCESS_KEY_SECRET",
    "ERP_ALIYUN_SMS_SIGN_NAME", "ERP_ALIYUN_SMS_TEMPLATE_CODE"]) {
    configureRuntime({ ...full, [key]: "" });
    assert.equal(configured(), false, "缺少 " + key + " 时不得视为已配置");
  }
});
