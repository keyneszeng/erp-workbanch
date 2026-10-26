"use strict";
/**
 * 业务单号生成回归
 * 运行：node --test test/id-sequence.test.js
 *
 * 2026-10-26 实测出的坑：原实现用 slice(-width) 取序号，
 * 序号到 1000 时 "HT-2026-1000".slice(-3) === "000"，
 * max 回退成 999，于是又生成 HT-2026-1000 —— 与已有记录撞号，
 * UNIQUE 约束报错，接口直接 500。
 * 付款单一年上千笔对协会是常态，所以这条必须钉死。
 */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { DatabaseSync } = require("node:sqlite");
const { nextId } = require("../server/lib/util");

function freshDb() {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE t (id TEXT PRIMARY KEY)");
  return db;
}
const year = new Date().getFullYear();
const ins = (db) => db.prepare("INSERT INTO t VALUES (?)");

test("空表从 001 开始", () => {
  const db = freshDb();
  assert.equal(nextId(db, "t", "id", "PY"), `PY-${year}-001`);
});

test("连续生成不重复", () => {
  const db = freshDb();
  const put = ins(db);
  const seen = [];
  for (let i = 0; i < 5; i++) {
    const id = nextId(db, "t", "id", "HT");
    put.run(id);
    seen.push(id);
  }
  assert.deepEqual(seen, [1, 2, 3, 4, 5].map((n) => `HT-${year}-${String(n).padStart(3, "0")}`));
});

test("断号时取最大值 + 1", () => {
  const db = freshDb();
  const put = ins(db);
  put.run(`PY-${year}-003`);
  put.run(`PY-${year}-007`);
  assert.equal(nextId(db, "t", "id", "PY"), `PY-${year}-008`);
});

test("序号超过 999 不再撞号（核心回归）", () => {
  const db = freshDb();
  const put = ins(db);
  for (let i = 1; i <= 1000; i++) put.run(`HT-${year}-${String(i).padStart(3, "0")}`);

  // 修复前这里返回 HT-2026-1000（已存在），插入会抛 UNIQUE constraint
  const next = nextId(db, "t", "id", "HT");
  assert.equal(next, `HT-${year}-1001`);
  assert.doesNotThrow(() => put.run(next), "第 1001 条必须能插入");
});

test("千位以上连续递增 10 次都正确", () => {
  const db = freshDb();
  const put = ins(db);
  for (let i = 1; i <= 1000; i++) put.run(`PY-${year}-${String(i).padStart(3, "0")}`);
  for (let k = 1001; k <= 1010; k++) {
    const id = nextId(db, "t", "id", "PY");
    assert.equal(id, `PY-${year}-${k}`);
    put.run(id);
  }
});

test("只统计当年单号，跨年重新从 001 开始", () => {
  const db = freshDb();
  const put = ins(db);
  put.run(`HT-${year - 1}-500`);
  assert.equal(nextId(db, "t", "id", "HT"), `HT-${year}-001`);
  put.run(`HT-${year}-001`);
  assert.equal(nextId(db, "t", "id", "HT"), `HT-${year}-002`);
});

test("其它前缀互不干扰", () => {
  const db = freshDb();
  const put = ins(db);
  put.run(`HT-${year}-009`);
  put.run(`PY-${year}-020`);
  assert.equal(nextId(db, "t", "id", "HT"), `HT-${year}-010`);
  assert.equal(nextId(db, "t", "id", "PY"), `PY-${year}-021`);
  assert.equal(nextId(db, "t", "id", "ST"), `ST-${year}-001`);
});
