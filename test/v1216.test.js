"use strict";
/**
 * V1.2.16 回归：会务需求只属于「筹备中 / 执行中」
 * 运行：node --experimental-sqlite --test test/v1216.test.js
 *
 * 老板 2026-10-28 的修正：
 *   「会务需求 的逻辑应该是 会议项目在 筹备 和 执行 的阶段的需求，
 *     相关负责人填写后 确认 就归档到 项目详情页；
 *     所以不是 筹备期 和 执行期 的项目 不应该出现在 会务需求 会议项目 列表页面。」
 *
 * 验三件事：
 *   1. 列表页只列筹备中 / 执行中，别的状态一律不出现（哪怕它有已归档的需求单）；
 *   2. 详情接口不分阶段：归档记录、核销对照都要查得到，并明确告知当前阶段；
 *   3. 归档后核销第 3 步仍拿得到这份清单（不能因为列表过滤把依据弄丢）。
 */
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const PORT = 8825;
const BASE = `http://127.0.0.1:${PORT}`;
const DB = path.join(__dirname, "..", "data", "test25.db");
const UP = path.join(__dirname, "..", "data", "test25-uploads");
let proc;
let admin, assoc;

function clean() {
  for (const f of [DB, DB + "-wal", DB + "-shm"]) if (fs.existsSync(f)) fs.renameSync(f, f + ".old");
  if (fs.existsSync(UP)) fs.rmSync(UP, { recursive: true, force: true });
}
async function waitHealth(timeout = 40000) {
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
  clean();
  proc = spawn(process.execPath, ["--experimental-sqlite", "server/index.js"], {
    cwd: path.join(__dirname, ".."),
    env: { ...process.env, ERP_PORT: String(PORT), ERP_DB: DB, ERP_UPLOAD_DIR: UP },
    stdio: ["ignore", "pipe", "pipe"]
  });
  proc.stderr.on("data", (d) => {
    const s = d.toString();
    if (!s.includes("ExperimentalWarning") && !s.includes("trace-warnings")) process.stderr.write("[srv] " + s);
  });
  await waitHealth();
  admin = client(await login("admin"));
  assoc = client(await login("assoc"));
});

after(() => { if (proc) proc.kill("SIGTERM"); });

test("列表页只返回「筹备中 / 执行中」的项目", async () => {
  const r = await admin("GET", "/api/demand");
  assert.equal(r.status, 200);
  const bad = r.data.projects.filter((p) => !["筹备中", "执行中"].includes(p.status));
  assert.deepEqual(bad, [], `列表里混进了非筹备 / 执行阶段的项目：${JSON.stringify(bad.map((p) => `${p.id}:${p.status}`))}`);
  assert.ok(r.data.projects.length > 0, "列表不该是空的 —— 种子里有筹备中 / 执行中的项目");
});

test("待核销项目即使有已归档需求单，也不出现在列表里", async () => {
  // MP-2026-003 是「待核销」：先给它造一份已归档需求单
  const p = await admin("PATCH", "/api/demand/MP-2026-003", {
    items: [
      { grp: "设计", item: "串场", need: "需要", budget: "5000" },
      { grp: "其他", item: "代购酒水", need: "不需要", budget: "9999" }
    ]
  });
  assert.equal(p.status, 200, JSON.stringify(p.data));
  const c = await admin("POST", "/api/demand/MP-2026-003/confirm");
  assert.equal(c.status, 200, JSON.stringify(c.data));

  const list = await admin("GET", "/api/demand");
  assert.ok(!list.data.projects.some((x) => x.id === "MP-2026-003"),
    "待核销项目不该出现在会务需求列表（归档记录到项目详情页看）");

  // 已归档 / 已核销 / 已结算 这些更晚的阶段同样不该出现
  for (const pid of ["MP-2026-007", "MP-2026-008", "MP-2026-006"]) {
    assert.ok(!list.data.projects.some((x) => x.id === pid), `${pid} 不该出现在列表`);
  }
});

test("详情接口不分阶段：待核销项目仍能查到已归档清单，并标出当前阶段", async () => {
  const r = await admin("GET", "/api/demand/MP-2026-003");
  assert.equal(r.status, 200);
  assert.equal(r.data.confirmed, true, "已归档状态要能查到");
  assert.equal(r.data.projectStatus, "待核销");
  assert.equal(r.data.inDemandPhase, false, "不在筹备 / 执行阶段要明确标出来");
  assert.equal(r.data.needCount, 1, "只有 1 条标了需要");
  assert.equal(r.data.budgetTotal, 5000);
});

test("筹备中项目：inDemandPhase = true", async () => {
  const r = await admin("GET", "/api/demand/MP-2026-001");
  assert.equal(r.status, 200);
  assert.equal(r.data.projectStatus, "筹备中");
  assert.equal(r.data.inDemandPhase, true);
});

test("/api/meta 下发阶段口径，前端不各写一份", async () => {
  const r = await admin("GET", "/api/meta");
  assert.equal(r.status, 200);
  assert.deepEqual(r.data.demandStatuses, ["筹备中", "执行中"]);
});

test("归档后核销第 3 步仍拿得到这份清单（列表过滤不能把依据弄丢）", async () => {
  const v = await admin("GET", "/api/projects/MP-2026-003");
  assert.equal(v.status, 200);
  assert.ok(v.data.demand, "项目详情应带 demand 摘要");
  assert.equal(v.data.demand.archived, true);
  assert.equal(v.data.demand.needCount, 1);
});

test("协会管理员的数据范围仍然生效：非本协会项目 403", async () => {
  const r = await assoc("GET", "/api/demand/MP-2026-007"); // 肿瘤分会
  assert.equal(r.status, 403);
  const list = await assoc("GET", "/api/demand");
  assert.equal(list.status, 200);
  assert.ok(list.data.projects.every((p) => ["筹备中", "执行中"].includes(p.status)));
});
