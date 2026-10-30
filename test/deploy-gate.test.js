"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { check } = require("../scripts/check-aliyun-production.cjs");
const { parseJsonc, assertDemo } = require("../scripts/check-cloudflare-demo.cjs");

const root = path.resolve(__dirname, "..");
const read = file => fs.readFileSync(path.join(root, file), "utf8");
const production = Object.freeze({
  NODE_ENV: "production",
  ERP_DEPLOY_TARGET: "aliyun-ecs",
  ERP_DEMO_MODE: "0",
  ERP_PRODUCTION_DOMAIN: "erp-prod.example.org",
  ERP_BOOTSTRAP_ADMIN_PHONE: "13800138000",
  ERP_SMS_PROVIDER: "tencent",
  ERP_TENCENT_SECRET_ID: "CI-ONLY-ID",
  ERP_TENCENT_SECRET_KEY: "CI-ONLY-SECRET-KEY",
  ERP_TENCENT_SMS_APP_ID: "CI-ONLY-APP",
  ERP_TENCENT_SMS_SIGN: "CI-ONLY-SIGN",
  ERP_TENCENT_SMS_TEMPLATE_ID: "CI-ONLY-TEMPLATE",
  ERP_SECRET: "CI-Only-Fake-Secret-Not-For-Real-Use-2026!",
  ERP_DB: "/var/lib/erp/erp.db",
  ERP_UPLOAD_DIR: "/var/lib/erp/uploads",
  ERP_HOST: "127.0.0.1",
  ERP_PORT: "8787",
  ERP_TRUST_PROXY: "1",
  ERP_SESSION_FALLBACK: "0"
});

test("Alibaba ECS production preflight accepts only isolated production configuration", () => {
  assert.deepEqual(check(production), { target: "aliyun-ecs", domain: "erp-prod.example.org" });
  const result = spawnSync(process.execPath, ["scripts/check-aliyun-production.cjs"], {
    cwd: root, encoding: "utf8", env: { ...process.env, ...production }, timeout: 10000
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /阿里云 ECS 生产环境预检通过/);
});

test("Alibaba ECS refuses wrong deployment target, demo mode, and demo domain", () => {
  for (const [patch, message] of [
    [{ ERP_DEPLOY_TARGET: "cloudflare" }, /aliyun-ecs/],
    [{ ERP_DEPLOY_TARGET: "vercel" }, /aliyun-ecs/],
    [{ ERP_DEMO_MODE: "1" }, /ERP_DEMO_MODE/],
    [{ ERP_DEMO_MODE: "" }, /ERP_DEMO_MODE/],
    [{ NODE_ENV: "test" }, /NODE_ENV/],
    [{ ERP_PRODUCTION_DOMAIN: "erp.aibuild.work" }, /演示版/],
    [{ ERP_PRODUCTION_DOMAIN: "not-a-domain" }, /域名/]
  ]) {
    assert.throws(() => check({ ...production, ...patch }), message);
  }
});

test("Alibaba ECS refuses invalid admin phone, missing SMS, and unsafe secrets", () => {
  for (const [patch, message] of [
    [{ ERP_BOOTSTRAP_ADMIN_PHONE: "admin" }, /手机号/],
    [{ ERP_SMS_PROVIDER: "test" }, /tencent/],
    [{ ERP_SMS_TEST_MODE: "1" }, /模拟/],
    [{ ERP_TENCENT_SECRET_KEY: "" }, /ERP_TENCENT_SECRET_KEY/],
    [{ ERP_SECRET: "123456" }, /ERP_SECRET/],
    [{ ERP_DB_BACKEND: "do-sqlite" }, /模拟/]
  ]) {
    assert.throws(() => check({ ...production, ...patch }), message);
  }
});

test("Alibaba ECS requires persistent local SQLite and localhost Nginx", () => {
  for (const [patch, message] of [
    [{ ERP_DB: "/tmp/erp.db" }, /持久/],
    [{ ERP_DB: "./data/erp.db" }, /持久/],
    [{ ERP_UPLOAD_DIR: "/tmp/uploads" }, /持久/],
    [{ ERP_UPLOAD_DIR: "/var/lib/erp/demo/uploads" }, /演示/],
    [{ ERP_HOST: "0.0.0.0" }, /127.0.0.1/],
    [{ ERP_PORT: "9999" }, /8787/],
    [{ ERP_TRUST_PROXY: "0" }, /ERP_TRUST_PROXY/],
    [{ ERP_SESSION_FALLBACK: "1" }, /会话/]
  ]) {
    assert.throws(() => check({ ...production, ...patch }), message);
  }
});

test("Cloudflare checked-in deployment config is strictly demo only", () => {
  const conf = parseJsonc(read("wrangler.jsonc"));
  assert.doesNotThrow(() => assertDemo(conf));
  assert.throws(() => assertDemo({ ...conf, vars: { ERP_DEMO_MODE: "0" } }), /ERP_DEMO_MODE/);
  assert.throws(() => assertDemo({ ...conf, routes: [{ pattern: "erp-prod.example.org", custom_domain: true }] }), /Cloudflare/);
  assert.throws(() => assertDemo({ ...conf, vars: { ERP_DEMO_MODE: "1", ERP_BOOTSTRAP_ADMIN_PHONE: "13800138000" } }), /生产变量/);
});

test("Cloudflare production deploy entry always rejects even with production-looking vars", () => {
  const result = spawnSync(process.execPath, ["scripts/check-production-deploy.cjs"], {
    cwd: root, encoding: "utf8", env: { ...process.env, ...production }, timeout: 10000
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /不能部署到 Cloudflare/);
  const pkg = JSON.parse(read("package.json"));
  assert.equal(pkg.scripts["cf:deploy"], "node scripts/check-production-deploy.cjs");
});

test("Cloudflare worker code refuses non-demo mode; GitHub workflow never deploys", () => {
  assert.match(read("worker/index.mjs"), /ERP_DEMO_MODE/);
  assert.match(read("worker/do.mjs"), /Cloudflare 只允许演示模式/);
  const workflow = read(".github/workflows/cloudflare-deploy.yml");
  assert.doesNotMatch(workflow, /wrangler-action|command:\s*deploy|wrangler\s+deploy\b/);
  assert.match(workflow, /No deployment performed/);
});

test("Alibaba ECS unit and Nginx are linked to production guard and persistent paths", () => {
  const unit = read("deploy/aliyun/erp.service");
  const nginx = read("deploy/aliyun/nginx-erp.conf.example");
  assert.match(unit, /ExecStartPre=.*check-aliyun-production.cjs/);
  assert.match(unit, /EnvironmentFile=\/etc\/erp-workbanch\/production.env/);
  assert.match(unit, /User=erp/);
  assert.match(nginx, /listen 443 ssl/);
  assert.match(nginx, /proxy_pass http:\/\/127\.0\.0\.1:8787/);
  assert.doesNotMatch(unit + nginx, /server_name\s+erp\.aibuild\.work/);
});
