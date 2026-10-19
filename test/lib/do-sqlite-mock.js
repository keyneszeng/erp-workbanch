"use strict";
/**
 * 用 node:sqlite 模拟 Durable Object 的 ctx.storage.sql 接口。
 *
 * 存在的理由：本机 macOS 12.7.6 跑不了 workerd（最低要求 13.5），
 * 无法用 wrangler dev 预览。但 CF 分支的 SQL 语义（同步游标、多语句 exec、
 * transactionSync）必须验证，否则只能盲部署。
 *
 * 这个 mock 让 130 条既有测试可以在「DO 后端」下原样重跑：
 *   ERP_DB_BACKEND=do-sqlite npm test
 *
 * 它只实现 server/lib/db.js 里 durableBackend() 真正用到的那几个接口：
 *   sql.exec(query, ...bindings) -> { toArray(), rowsWritten, rowsRead, columnNames }
 *   storage.transactionSync(fn)
 */
const path = require("node:path");
const fs = require("node:fs");
// 动态取，避免打包器把 node:sqlite 提升成顶层 import（Workers 里它是空壳）
const { DatabaseSync } = process.getBuiltinModule("node:sqlite");

function makeCursor(rows, changes) {
  return {
    toArray: () => rows,
    one() {
      if (rows.length !== 1) throw new Error(`Expected exactly 1 row, got ${rows.length}`);
      return rows[0];
    },
    raw: () => rows.map((r) => Object.values(r)),
    columnNames: rows.length ? Object.keys(rows[0]) : [],
    rowsRead: rows.length,
    rowsWritten: changes
  };
}

function createStorage(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const raw = new DatabaseSync(file);

  const sql = {
    exec(query, ...bindings) {
      const q = String(query);
      // 与 DO 一致：无绑定参数且含多条语句时，整段执行（用于 SCHEMA）
      const multi = bindings.length === 0 && /;\s*\S/.test(q.trim());
      if (multi) {
        raw.exec(q);
        return makeCursor([], 0);
      }
      const stmt = raw.prepare(q);
      const rows = stmt.all(...bindings);
      const changes = raw.prepare("SELECT changes() AS c").get().c;
      return makeCursor(rows, changes);
    }
  };

  return {
    sql,
    transactionSync(fn) {
      raw.exec("BEGIN");
      try {
        const r = fn();
        raw.exec("COMMIT");
        return r;
      } catch (e) {
        try {
          raw.exec("ROLLBACK");
        } catch {
          /* ignore */
        }
        throw e;
      }
    },
    _raw: raw
  };
}

module.exports = { createStorage };
