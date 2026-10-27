"use strict";
/**
 * 会务需求「确认即归档」回归测试
 *
 * 规则：需求单确认后即归档，不能再改、不能再重置；要改必须先撤销归档。
 * 归档的单子是核销第 3 步的费用对照基准 —— 记的是「当初答应花多少」。
 * 运行：node --test test/demand-archive.test.js
 */
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const PORT = 8820;
const BASE = `http://127.0.0.1:${PORT}`;
const DB = path.join(__dirname, "..", "data", "test-demand-archive.db");
let proc;

function cleanDb() {
  for (const f of [DB, DB + "-wal", DB + "-shm"]) if (fs.existsSync(f)) fs.renameSync(f, f + ".old");
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
  assert.equal(r.status, 200, `${username} 登录应成功`);
  return r.headers.get("set-cookie").split(";")[0];
}
function client(cookie) {
  return async (method, url, body) => {
    const r = await fetch(BASE + url, {
      method,
      headers: { "Content-Type": "application/json", cookie },
      body: body ? JSON.stringify(body) : undefined
    });
    const text = await r.text();
    let data = null; try { data = JSON.parse(text); } catch { data = text; }
    return { status: r.status, data };
  };
}

let admin, assoc, finance;
const PID = "MP-2026-001"; // 华东医学会年会，筹备中，种子带一份需求单

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
  admin = client(await login("admin"));
  assoc = client(await login("assoc"));
  finance = client(await login("finance"));
});
after(() => { if (proc) proc.kill("SIGTERM"); });

test("归档前：需求单可自由保存", async () => {
  const r = await assoc("PATCH", `/api/demand/${PID}`, {
    items: [
      { grp: "设计", item: "串场", need: "需要", budget: "3800" },
      { grp: "制作", item: "横幅", need: "需要", budget: "1200" },
      { grp: "其他", item: "代购酒水", need: "不需要", budget: "9999" }
    ]
  });
  assert.equal(r.status, 200);
  assert.equal(r.data.sheet.archived, false);
  // 标了「不需要」的 9999 不该进合计
  assert.equal(r.data.sheet.budgetTotal, 5000, "预算合计只算需要的条目");
});

test("确认即归档：归档后保存被拒（409 DEMAND_ARCHIVED）", async () => {
  const c = await assoc("POST", `/api/demand/${PID}/confirm`);
  assert.equal(c.status, 200);
  assert.equal(c.data.sheet.archived, true);
  assert.ok(c.data.sheet.confirmed_by, "应记录归档人");
  assert.ok(c.data.sheet.confirmed_at, "应记录归档时间");

  const r = await assoc("PATCH", `/api/demand/${PID}`, {
    items: [{ grp: "设计", item: "串场", need: "需要", budget: "9999" }]
  });
  assert.equal(r.status, 409);
  assert.equal(r.data.error.code, "DEMAND_ARCHIVED");
  assert.match(r.data.error.message, /撤销归档/);

  // 归档后条目没被这次被拒的请求改掉
  const d = await assoc("GET", `/api/demand/${PID}`);
  assert.equal(d.data.budgetTotal, 5000, "被拒的保存不应写入");
});

test("重复确认被拒（409），不会刷新归档时间", async () => {
  const before = (await assoc("GET", `/api/demand/${PID}`)).data.confirmed_at;
  const r = await assoc("POST", `/api/demand/${PID}/confirm`);
  assert.equal(r.status, 409);
  assert.equal(r.data.error.code, "DEMAND_ARCHIVED");
  const afterAt = (await assoc("GET", `/api/demand/${PID}`)).data.confirmed_at;
  assert.equal(afterAt, before, "重复确认不应改动归档时间");
});

test("归档后重置被拒：重置会删光条目，比修改更该拦", async () => {
  const r = await assoc("POST", `/api/demand/${PID}/reset`);
  assert.equal(r.status, 409);
  assert.equal(r.data.error.code, "DEMAND_ARCHIVED");
});

test("撤销归档后回到草稿，条目仍在（不是清空）", async () => {
  const un = await assoc("POST", `/api/demand/${PID}/unarchive`);
  assert.equal(un.status, 200);
  assert.equal(un.data.sheet.archived, false);
  assert.equal(un.data.sheet.confirmed_by, null);
  const total = Object.values(un.data.sheet.items).reduce((a, x) => a + x.length, 0);
  assert.equal(total, 3, "撤销归档只解锁，不删数据");
  assert.equal(un.data.sheet.budgetTotal, 5000);
});

test("未归档时撤销被拒（409 NOT_ARCHIVED）", async () => {
  const r = await assoc("POST", `/api/demand/${PID}/unarchive`);
  assert.equal(r.status, 409);
  assert.equal(r.data.error.code, "NOT_ARCHIVED");
});

test("财务无 demand:write，撤销归档同样被拒（403）", async () => {
  const r = await finance("POST", `/api/demand/${PID}/unarchive`);
  assert.equal(r.status, 403);
});

test("审计：归档与撤销各留一条，能追到是谁动的", async () => {
  // 前一步已撤销，这里再归档一次，让两条记录都在
  const c = await admin("POST", `/api/demand/${PID}/confirm`);
  assert.equal(c.status, 200);
  await admin("POST", `/api/demand/${PID}/unarchive`);

  const r = await admin("GET", `/api/audit?q=${encodeURIComponent(PID)}`);
  assert.equal(r.status, 200);
  const rows = Array.isArray(r.data) ? r.data : (r.data.rows || []);
  const archived = rows.filter((x) => x.action === "归档需求单");
  const unarchived = rows.filter((x) => x.action === "撤销归档");
  assert.ok(archived.length >= 1, "应有「归档需求单」审计");
  assert.ok(unarchived.length >= 1, "应有「撤销归档」审计");
  assert.match(archived[0].detail, /预算合计/, "归档审计应带预算合计");
});

test("核销接口带上归档需求单：预算合计与需求单一致", async () => {
  await admin("POST", `/api/demand/${PID}/confirm`);
  const v = (await admin("GET", `/api/projects/${PID}/verify`)).data;
  assert.ok(v.demand, "核销接口应带 demand");
  assert.equal(v.demand.archived, true);
  assert.equal(v.demand.needCount, 2, "需要项 2 条（酒水标了不需要）");
  assert.equal(v.demand.total, 3);
  assert.equal(v.demand.budgetTotal, 5000, "核销侧预算合计应与需求单一致");
  assert.ok(v.demand.items.every((x) => x.budget !== "9999"), "不需要的条目不进核对清单");

  const sheet = (await admin("GET", `/api/demand/${PID}`)).data;
  assert.equal(v.demand.budgetTotal, sheet.budgetTotal, "两处口径必须一致");
});

test("撤销归档后核销侧标记为未归档（判定人知道这份单子没定稿）", async () => {
  await admin("POST", `/api/demand/${PID}/unarchive`);
  const v = (await admin("GET", `/api/projects/${PID}/verify`)).data;
  assert.equal(v.demand.archived, false);
  assert.equal(v.demand.budgetTotal, 5000, "未归档也给出金额，供参考");
});

test("冻结优先：已结算的项目连归档都不许（先被 assertNotFrozen 拦住）", async () => {
  // MP-2026-006 已结算，结算单一生成即封账
  const r = await admin("POST", `/api/demand/MP-2026-006/confirm`);
  assert.equal(r.status, 409);
  assert.notEqual(r.data.error.code, "DEMAND_ARCHIVED", "应是冻结拦截，不是归档拦截");
  assert.match(r.data.error.message, /结算|冻结|封/);
});
