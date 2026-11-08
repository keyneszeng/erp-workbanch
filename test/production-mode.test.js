"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const script = [
  'const { migrate, db } = require("./server/lib/db");',
  'const { seed } = require("./server/lib/seed");',
  'migrate();',
  'const result = seed();',
  'const users = db.prepare("SELECT COUNT(*) AS c FROM users").get().c;',
  'const projects = db.prepare("SELECT COUNT(*) AS c FROM projects").get().c;',
  'console.log(JSON.stringify({ result, users, projects }));'
].join("\n");

function withDatabase(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "erp-production-"));
  try { return fn(path.join(dir, "erp.db")); }
  finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

function boot(file, { demo = false, phone } = {}) {
  const env = {
    ...process.env,
    ERP_DB: file,
    ERP_DB_BACKEND: "",
    ERP_DEMO_MODE: demo ? "1" : "0",
    ERP_SESSION_FALLBACK: "0",
    NODE_ENV: "test", ERP_SMS_PROVIDER: "test", ERP_SMS_TEST_MODE: "1"
  };
  if (phone === undefined) delete env.ERP_BOOTSTRAP_ADMIN_PHONE;
  else env.ERP_BOOTSTRAP_ADMIN_PHONE = phone;
  return spawnSync(process.execPath, ["--experimental-sqlite", "-e", script], {
    cwd: path.resolve(__dirname, ".."), env, encoding: "utf8", timeout: 20000
  });
}

const adminPhone = "13800138000";

test("生产空库未配置总管理员手机号时拒绝自动初始化", () => withDatabase((file) => {
  const r = boot(file);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /ERP_BOOTSTRAP_ADMIN_PHONE/);
}));

test("生产只创建一个管理员，不带演示项目，重启无需重播种", () => withDatabase((file) => {
  const first = boot(file, { phone: adminPhone });
  assert.equal(first.status, 0, first.stderr);
  const data = JSON.parse(first.stdout.trim().split("\n").pop());
  assert.equal(data.users, 1);
  assert.equal(data.projects, 0);
  assert.equal(data.result.users, 1);
  assert.equal(data.result.mode, "production");
  const second = boot(file);
  assert.equal(second.status, 0, second.stderr);
  assert.equal(JSON.parse(second.stdout.trim().split("\n").pop()).users, 1);
  assert.match(second.stdout, /"skipped":true/);
  const reverse = boot(file, { demo: true });
  assert.notEqual(reverse.status, 0);
  assert.match(reverse.stderr, /禁止在生产数据库/);
}));

test("演示数据保留八个账号，但禁止用生产模式接管演示库", () => withDatabase((file) => {
  const demo = boot(file, { demo: true });
  assert.equal(demo.status, 0, demo.stderr);
  const data = JSON.parse(demo.stdout.trim().split("\n").pop());
  assert.equal(data.users, 8);
  assert.ok(data.projects > 0);
  const prod = boot(file, { phone: adminPhone });
  assert.notEqual(prod.status, 0);
  assert.match(prod.stderr, /演示数据/);
}));
