"use strict";
/**
 * 列表分页回归
 * 运行：node --test test/paging.test.js
 *
 * 重点不是「能翻页」，而是三件容易错的事：
 *   1) 不传 page 时必须完全退回旧行为（全量返回），否则旧调用方会静默丢数据；
 *   2) 汇总数字（预算 / 已付 / 付款状态分布）必须是全量，不能只算当前页；
 *   3) 材料齐备度必须用独立聚合，不能拿分页后的 rows 去推。
 */
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const PORT = 8807;
const BASE = `http://127.0.0.1:${PORT}`;
const DB = path.join(__dirname, "..", "data", "test7.db");
let proc;
let adminCookie;

function cleanDb() {
  for (const f of [DB, DB + "-wal", DB + "-shm"]) if (fs.existsSync(f)) fs.unlinkSync(f);
}
async function waitHealth(timeout = 15000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    try { const r = await fetch(`${BASE}/api/health`); if (r.ok) return; } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("测试服务启动超时");
}
async function login(username, password = "123456") {
  const r = await fetch(`${BASE}/api/auth/login`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password })
  });
  assert.equal(r.status, 200, `${username} 登录失败`);
  return r.headers.get("set-cookie").split(";")[0];
}
function client(cookie) {
  return async (method, url, body) => {
    const r = await fetch(BASE + url, {
      method, headers: { "Content-Type": "application/json", cookie },
      body: body ? JSON.stringify(body) : undefined
    });
    const text = await r.text();
    let data = null; try { data = JSON.parse(text); } catch { data = text; }
    return { status: r.status, data };
  };
}

before(async () => {
  cleanDb();
  proc = spawn(process.execPath, ["--experimental-sqlite", "server/index.js"], {
    cwd: path.join(__dirname, ".."),
    env: { ...process.env, ERP_PORT: String(PORT), ERP_DB: DB },
    stdio: ["ignore", "pipe", "pipe"]
  });
  proc.stderr.on("data", (d) => {
    const s = d.toString();
    if (!s.includes("ExperimentalWarning") && !s.includes("trace-warnings")) process.stderr.write("[srv] " + s);
  });
  await waitHealth();
  adminCookie = await login("admin");

  // 造够材料：8 类 × 4 个项目 = 32 条，足以跨多页
  const c = client(adminCookie);
  const list = await c("GET", "/api/projects");
  const targets = list.data.rows.filter((p) => p.status !== "已归档").slice(0, 4);
  assert.ok(targets.length >= 2, "需要至少 2 个可写项目");
  for (const p of targets) {
    for (const k of ["议程", "课件", "签到表", "发票"]) {
      const r = await c("POST", `/api/projects/${p.id}/materials`, { kind: k, name: `分页测试-${k}.pdf` });
      assert.equal(r.status, 200, `造数据失败 ${p.id} ${k}`);
    }
  }
});
after(() => { if (proc) proc.kill("SIGTERM"); });

test("不传 page 时保持全量返回（向后兼容）", async () => {
  const c = client(adminCookie);
  const r = await c("GET", "/api/materials");
  assert.equal(r.status, 200);
  assert.equal(r.data.paged, false);
  assert.ok(r.data.rows.length >= 16, `应返回全量，实际 ${r.data.rows.length}`);
  assert.equal(r.data.total, r.data.rows.length, "不分页时 total 应等于行数");
  assert.equal(r.data.pages, 1);
});

test("传 page 时按 size 切片，total 是全量", async () => {
  const c = client(adminCookie);
  const all = await c("GET", "/api/materials");
  const total = all.data.total;

  const p1 = await c("GET", "/api/materials?page=1&size=5");
  assert.equal(p1.data.paged, true);
  assert.equal(p1.data.rows.length, Math.min(5, total));
  assert.equal(p1.data.total, total, "total 必须是全量条数");
  assert.equal(p1.data.page, 1);
  assert.equal(p1.data.size, 5);
  assert.equal(p1.data.pages, Math.ceil(total / 5));

  const p2 = await c("GET", "/api/materials?page=2&size=5");
  assert.equal(p2.data.page, 2);
  // 两页不能有重复条目
  const ids1 = new Set(p1.data.rows.map((x) => x.id));
  const overlap = p2.data.rows.filter((x) => ids1.has(x.id));
  assert.equal(overlap.length, 0, "第二页不应与第一页重复");
});

test("材料齐备度不受分页影响（用独立聚合而非当前页推断）", async () => {
  const c = client(adminCookie);
  const full = await c("GET", "/api/materials");
  const paged = await c("GET", "/api/materials?page=1&size=2");

  const key = (d) => d.projects.map((p) => `${p.id}:${p.missing.length}:${p.missing.join("|")}`).sort().join(";");
  assert.equal(key(paged.data), key(full.data), "分页后的齐备度必须与全量一致");
});

test("size 越界与非法 page 被兜底", async () => {
  const c = client(adminCookie);
  const big = await c("GET", "/api/materials?page=1&size=9999");
  assert.equal(big.data.size, 200, "size 上限应为 200");

  const bad = await c("GET", "/api/materials?page=abc&size=xyz");
  assert.equal(bad.data.page, 1, "非法 page 应回退为 1");
  assert.equal(bad.data.size, 50, "非法 size 应回退为默认 50");

  const neg = await c("GET", "/api/materials?page=-3");
  assert.equal(neg.data.page, 1, "负数 page 应回退为 1");
});

test("项目列表分页：summary 为全量预算与已付款", async () => {
  const c = client(adminCookie);
  const full = await c("GET", "/api/projects");
  const paged = await c("GET", "/api/projects?page=1&size=3");

  assert.equal(paged.data.paged, true);
  assert.equal(paged.data.rows.length, Math.min(3, full.data.total));
  assert.equal(paged.data.total, full.data.total);

  const fullBudget = full.data.rows.reduce((s, r) => s + r.budget, 0);
  const fullPaid = full.data.rows.reduce((s, r) => s + (r.paid_amt || 0), 0);
  assert.equal(paged.data.summary.budget, fullBudget, "预算合计应为全量");
  assert.equal(paged.data.summary.paid, fullPaid, "已付款合计应为全量");
});

test("付款列表分页：状态分布汇总为全量", async () => {
  const c = client(adminCookie);
  const full = await c("GET", "/api/payments");
  const paged = await c("GET", "/api/payments?page=1&size=2");

  assert.equal(paged.data.paged, true);
  assert.equal(paged.data.total, full.data.total);

  const countBy = (rows, st) => rows.filter((r) => r.status === st).length;
  for (const st of ["待审批", "已审批", "已付款"]) {
    assert.equal(
      paged.data.summary[{ 待审批: "pending", 已审批: "approved", 已付款: "paid" }[st]],
      countBy(full.data.rows, st),
      `${st} 笔数汇总应为全量`
    );
  }
  const sumBy = (rows, st) => rows.filter((r) => r.status === st).reduce((s, r) => s + r.amount, 0);
  assert.equal(paged.data.summary.pendingAmount, sumBy(full.data.rows, "待审批"));
  assert.equal(paged.data.summary.paidAmount, sumBy(full.data.rows, "已付款"));
});

test("审计日志分页：total 与不分页时的上限行为", async () => {
  const c = client(adminCookie);
  const paged = await c("GET", "/api/audit?page=1&size=10");
  assert.equal(paged.data.paged, true);
  assert.ok(paged.data.rows.length <= 10);
  assert.ok(paged.data.total >= paged.data.rows.length);

  const full = await c("GET", "/api/audit");
  assert.equal(full.data.paged, false);
  assert.ok(full.data.rows.length <= 500, "不分页时沿用 LIMIT 500 的旧行为");
});

test("分页不绕过数据范围隔离", async () => {
  const guest = client(await login("guest"));
  const r = await guest("GET", "/api/projects?page=1&size=5");
  assert.equal(r.status, 200);
  const all = await client(adminCookie)("GET", "/api/projects");
  assert.ok(r.data.total <= all.data.total, "guest 的 total 不应超过管理员可见总数");
});
