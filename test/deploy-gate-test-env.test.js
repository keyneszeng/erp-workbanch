"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { check } = require("../scripts/check-aliyun-test.cjs");
const { check: checkProduction } = require("../scripts/check-aliyun-production.cjs");

const testEnv = Object.freeze({
  NODE_ENV: "production",
  ERP_DEPLOY_TARGET: "aliyun-ecs-test",
  ERP_DEMO_MODE: "0",
  ERP_PRODUCTION_DOMAIN: "",
  ERP_BOOTSTRAP_ADMIN_PHONE: "13800138000",
  ERP_SMS_PROVIDER: "console",
  ERP_TEST_FIXED_SMS_CODE: "654321",
  ERP_SECRET: "TestEnv-Only-High-Entropy-Secret-2026-ABCDEF",
  ERP_DB: "/var/lib/erp-test/erp.db",
  ERP_UPLOAD_DIR: "/var/lib/erp-test/uploads",
  ERP_HOST: "127.0.0.1",
  ERP_PORT: "8788",
  ERP_TRUST_PROXY: "1",
  ERP_SESSION_FALLBACK: "0"
});

test("测试环境接受无域名 + console 短信通道", () => {
  assert.deepEqual(check(testEnv), { target: "aliyun-ecs-test", domain: "(未配置，按 IP 访问)" });
  // 填了 IP 也应当接受
  assert.deepEqual(check({ ...testEnv, ERP_PRODUCTION_DOMAIN: "47.98.1.2" }),
    { target: "aliyun-ecs-test", domain: "47.98.1.2" });
  // 短信审核通过后换成阿里云通道，无需改代码
  assert.doesNotThrow(() => check({
    ...testEnv, ERP_SMS_PROVIDER: "aliyun", ERP_TEST_FIXED_SMS_CODE: "",
    ERP_ALIYUN_SMS_ACCESS_KEY_ID: "ak", ERP_ALIYUN_SMS_ACCESS_KEY_SECRET: "sk",
    ERP_ALIYUN_SMS_SIGN_NAME: "签名", ERP_ALIYUN_SMS_TEMPLATE_CODE: "SMS_1"
  }));
});

test("测试环境拒绝生产目标与演示模式", () => {
  for (const [patch, message] of [
    [{ ERP_DEPLOY_TARGET: "aliyun-ecs" }, /aliyun-ecs-test/],
    [{ ERP_DEPLOY_TARGET: "" }, /aliyun-ecs-test/],
    [{ ERP_DEMO_MODE: "1" }, /ERP_DEMO_MODE/],
    [{ NODE_ENV: "test" }, /NODE_ENV/],
    [{ ERP_SMS_TEST_MODE: "1" }, /模拟/],
    [{ ERP_DB_BACKEND: "do-sqlite" }, /模拟/]
  ]) {
    assert.throws(() => check({ ...testEnv, ...patch }), message);
  }
});

test("测试环境必须与生产数据库物理隔离", () => {
  for (const [patch, message] of [
    [{ ERP_DB: "/var/lib/erp/erp.db" }, /erp-test/],
    [{ ERP_UPLOAD_DIR: "/var/lib/erp/uploads" }, /erp-test/],
    [{ ERP_DB: "/tmp/erp.db" }, /erp-test/],
    [{ ERP_DB: "/var/lib/erp-test/erp.sqlite" }, /\.db/],
    [{ ERP_UPLOAD_DIR: "/var/lib/erp-test/erp.db/uploads" }, /重叠/],
    [{ ERP_HOST: "0.0.0.0" }, /127\.0\.0\.1/],
    [{ ERP_PORT: "8787" }, /8788/],
    [{ ERP_TRUST_PROXY: "0" }, /ERP_TRUST_PROXY/],
    [{ ERP_SESSION_FALLBACK: "1" }, /会话/],
    [{ ERP_SECRET: "short" }, /ERP_SECRET/],
    [{ ERP_BOOTSTRAP_ADMIN_PHONE: "admin" }, /手机号/]
  ]) {
    assert.throws(() => check({ ...testEnv, ...patch }), message);
  }
});

test("固定验证码只允许 console 通道且必须 6 位", () => {
  assert.throws(() => check({ ...testEnv, ERP_TEST_FIXED_SMS_CODE: "12345" }), /6 位/);
  assert.throws(() => check({ ...testEnv, ERP_TEST_FIXED_SMS_CODE: "abcdef" }), /6 位/);
  assert.throws(() => check({
    ...testEnv, ERP_SMS_PROVIDER: "aliyun", ERP_TEST_FIXED_SMS_CODE: "654321",
    ERP_ALIYUN_SMS_ACCESS_KEY_ID: "ak", ERP_ALIYUN_SMS_ACCESS_KEY_SECRET: "sk",
    ERP_ALIYUN_SMS_SIGN_NAME: "签名", ERP_ALIYUN_SMS_TEMPLATE_CODE: "SMS_1"
  }), /console/);
});

test("console 通道无法混入生产：生产门禁必须拒绝", () => {
  // 把测试环境配置整体搬到生产目标下，必须被生产门禁拦下
  assert.throws(() => checkProduction({
    ...testEnv, ERP_DEPLOY_TARGET: "aliyun-ecs",
    ERP_PRODUCTION_DOMAIN: "erp-prod.example.org", ERP_PORT: "8787"
  }), /ERP_SMS_PROVIDER|tencent/);
  // 生产也不能借用测试目录
  assert.throws(() => checkProduction({
    ...testEnv, ERP_DEPLOY_TARGET: "aliyun-ecs", ERP_SMS_PROVIDER: "aliyun",
    ERP_PRODUCTION_DOMAIN: "erp-prod.example.org", ERP_PORT: "8787",
    ERP_ALIYUN_SMS_ACCESS_KEY_ID: "ak", ERP_ALIYUN_SMS_ACCESS_KEY_SECRET: "sk",
    ERP_ALIYUN_SMS_SIGN_NAME: "签名", ERP_ALIYUN_SMS_TEMPLATE_CODE: "SMS_1"
  }), /erp-test|持久/);
});
