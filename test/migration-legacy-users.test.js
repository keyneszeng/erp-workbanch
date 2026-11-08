"use strict";
/**
 * 从 main 线升级到本分支时的迁移回归。
 *
 * 背景：本分支把「材料替换」从 users.material_file_replace 迁到独立的
 * user_permission_grants 表。迁移代码原先先跑 INSERT...WHERE material_file_replace=1，
 * 再补这一列——但 main 线建的库根本没有该字段，于是启动即
 * 「no such column: material_file_replace」，服务直接起不来。
 *
 * 这个用例把「旧库缺列」的状态造出来，再跑一次 migrate()，
 * 确保补列排在授权迁移之前。
 */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "erp-migrate-"));
const file = path.join(dir, "legacy.db");
process.env.ERP_DB = file;

const { migrate, db } = require("../server/lib/db");

test("旧库缺 users.material_file_replace 时，migrate 先补列再跑授权迁移", () => {
  // 1) 先建出当前完整 schema
  migrate();
  const cols = () => db.prepare("PRAGMA table_info(users)").all().map(c => c.name);
  assert.ok(cols().includes("material_file_replace"), "初始 schema 应含该列");

  // 2) 还原成 main 线旧库的形态：没有这一列，也没有迁移标记
  db.exec("ALTER TABLE users DROP COLUMN material_file_replace");
  db.exec("DELETE FROM settings WHERE k='explicit_grants_migration_v1'");
  assert.ok(!cols().includes("material_file_replace"), "已模拟出缺列状态");

  // 3) 再跑迁移：修复前这里抛 no such column，修复后应正常补列
  assert.doesNotThrow(() => migrate());
  assert.ok(cols().includes("material_file_replace"), "迁移后该列应被补回");
  assert.equal(
    db.prepare("SELECT v FROM settings WHERE k=?").get("explicit_grants_migration_v1")?.v,
    "done",
    "授权迁移标记应写入"
  );

  fs.rmSync(dir, { recursive: true, force: true });
});
