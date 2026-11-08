"use strict";
// 前端纯逻辑隔离验证，无需浏览器、数据库或真实账号。
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

async function helpers() {
  const src = fs.readFileSync(
    path.join(__dirname, "../web/assets/js/lib/todo-target.js"), "utf8"
  );
  return import("data:text/javascript;base64," + Buffer.from(src).toString("base64"));
}

test("会务执行筹备待办直接定位当前项目详情，不再仅跳会议列表", async () => {
  const { targetForTodo, badgeForTodo } = await helpers();
  const item = { kind: "筹备", pid: "MP-2026-001", go: "projects" };
  assert.equal(targetForTodo(item), "projects/MP-2026-001");
  assert.equal(badgeForTodo(item), "待筹备");
});

test("财务核销、付款及结算待办准确跳到具体项目", async () => {
  const { targetForTodo, badgeForTodo } = await helpers();
  const pid="MP-2026-007";
  for(const kind of ["待核销","核销"]) {
    assert.equal(targetForTodo({kind,pid,go:"verify"}), "verify/"+pid);
    assert.equal(badgeForTodo({kind,pid}), "待核销");
  }
  assert.equal(targetForTodo({kind:"付款",pid}),"finance/"+pid);
  assert.equal(badgeForTodo({kind:"付款",pid}),"待付款");
  for(const kind of ["结算","归档","变更落账"]) assert.equal(targetForTodo({kind,pid}),"projects/"+pid);
});

test("审批单优先定位单号而不是项目号；其他待办保留后端目标", async () => {
  const { targetForTodo, badgeForTodo } = await helpers();
  assert.equal(targetForTodo({kind:"审批",pid:"MP-2026-001",ref:"AP-2026-012"}),"approvals/AP-2026-012");
  assert.equal(targetForTodo({kind:"审批",pid:"MP-2026-001"}),"approvals/MP-2026-001");
  assert.equal(targetForTodo({kind:"自定义",go:"materials"}),"materials");
  assert.equal(badgeForTodo({kind:"自定义"}),"待处理");
});
