"use strict";
/**
 * 冻结状态回归。
 * 运行：node --test test/freeze.test.js
 *
 * 这一组最早是 2026-10-26 实测出来的三个洞：
 *   1) assoc 能改「已结算」项目资料（原来只拦了「已归档」）
 *   2) 已结算项目能删材料（核销凭证被销毁）
 *   3) 超管改「已结算」项目预算无任何门槛（结算单 income 取自 budget，改完永久对不上）
 *
 * 2026-11-02 老板补了一条：「处于历史冻结状态的内容，总管理员也有权限修改，必须放行」。
 * 所以本文件的断言改成**双轨**：
 *   · 非总管理员：冻结照旧拦住（冻结的意义还在）
 *   · 总管理员：一律放行，但每次放行都必须写「冻结放行」审计（纠错必须可追溯）
 */
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

// 端口必须与其它测试文件唯一：node --test 默认并行跑多个文件，
// 两个文件抢同一个端口会随机 EADDRINUSE（曾经和 business-rules 都用了 8812）。
const PORT = 8813;
const BASE = `http://127.0.0.1:${PORT}`;
const DB = path.join(__dirname, "..", "data", "test12.db");
const UP = path.join(__dirname, "..", "data", "test12-uploads");
let proc;
let admin, assoc;

function clean() {
  for (const f of [DB, DB + "-wal", DB + "-shm"]) if (fs.existsSync(f)) fs.renameSync(f, f + ".old");
  if (fs.existsSync(UP)) fs.rmSync(UP, { recursive: true, force: true });
}
async function waitHealth(t = 40000) {
  const t0 = Date.now();
  while (Date.now() - t0 < t) {
    try { const r = await fetch(`${BASE}/api/health`); if (r.ok) return; } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("测试服务启动超时");
}
async function login(u, p = "123456") {
  const r = await fetch(`${BASE}/api/auth/login`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: u, password: p })
  });
  assert.equal(r.status, 200, `${u} 登录失败`);
  return r.headers.get("set-cookie").split(";")[0];
}
function client(cookie) {
  return async (m, u, b) => {
    const r = await fetch(BASE + u, {
      method: m, headers: { "Content-Type": "application/json", cookie },
      body: b === undefined ? undefined : JSON.stringify(b)
    });
    const t = await r.text();
    let d = null; try { d = JSON.parse(t); } catch { d = t; }
    return { status: r.status, data: d, code: d?.error?.code, msg: d?.error?.message || "" };
  };
}

/** 种子里已结算的项目：MP-2026-006（对应结算单 ST-2026-001） */
const SETTLED = "MP-2026-006";
const ARCHIVED = "MP-2026-007";
/** 未冻结的项目，用来造「历史冻结材料」 */
const OPEN = "MP-2026-001";

/** 审计里必须能查到这一次放行 */
async function assertBypassAudited(target, hint) {
  const d = (await client(admin)("GET", `/api/audit?page=1&size=300`)).data;
  const rows = Array.isArray(d) ? d : d.rows || [];
  const hit = rows.find((x) => x.action === "冻结放行" && String(x.target) === String(target) && (!hint || String(x.detail || "").includes(hint)));
  assert.ok(hit, `总管理员放行 ${target} 必须写「冻结放行」审计，否则事后查不到谁在封账后动过账`);
  assert.match(String(hit.detail || ""), /总管理员/);
}

/** 让 assoc 能看到这个项目：数据范围在冻结判断之前，不改协会会先被 403 挡掉 */
async function shareWithAssoc(pid) {
  await client(admin)("PATCH", `/api/projects/${pid}`, { assoc: "华东医学会" });
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
  admin = await login("admin");
  assoc = await login("assoc");
});
after(() => {
  if (proc) proc.kill("SIGTERM");
  if (fs.existsSync(UP)) fs.rmSync(UP, { recursive: true, force: true });
});

test("前置：种子里的 MP-2026-006 确为已结算且有结算单", async () => {
  const d = (await client(admin)("GET", `/api/projects/${SETTLED}`)).data;
  assert.equal(d.project.status, "已结算");
  assert.ok(d.settlement, "应有结算单");
  assert.equal(Number(d.settlement.income), Number(d.project.budget), "结算单 income 取自项目预算");
});

test("总管理员改已结算项目预算：直接放行，不再要求 force，并留痕", async () => {
  const c = client(admin);
  const before = (await c("GET", `/api/projects/${SETTLED}`)).data.project.budget;

  const r = await c("PATCH", `/api/projects/${SETTLED}`, { budget: 9999999 });
  assert.equal(r.status, 200, "总管理员改冻结项目预算应放行：" + JSON.stringify(r.data));

  const after = (await c("GET", `/api/projects/${SETTLED}`)).data.project.budget;
  assert.equal(Number(after), 9999999);
  await assertBypassAudited(SETTLED, "预算");

  // 收尾：改回去，不影响后续用例
  await c("PATCH", `/api/projects/${SETTLED}`, { budget: before });
});

test("已结算项目改非金额字段（避免误伤）", async () => {
  const r = await client(admin)("PATCH", `/api/projects/${SETTLED}`, { people: 320 });
  assert.equal(r.status, 200, JSON.stringify(r.data));
});

test("assoc 不能改已结算项目（原来只拦了已归档）", async () => {
  await shareWithAssoc(SETTLED);
  const r = await client(assoc)("PATCH", `/api/projects/${SETTLED}`, { budget: 1 });
  assert.equal(r.status, 409, JSON.stringify(r.data));
  assert.equal(r.code, "FROZEN");
  assert.match(r.msg, /已结算/);
});

test("已结算项目：assoc 新增/删除材料仍被冻结，总管理员可放行", async () => {
  const a = client(admin), s = client(assoc);
  const before = (await a("GET", "/api/materials")).data.rows.filter((m) => m.pid === SETTLED);

  const blocked = await s("POST", `/api/projects/${SETTLED}/materials`, { kind: "发票", name: "结算后补录凭证" });
  assert.equal(blocked.status, 409, JSON.stringify(blocked.data));
  assert.equal(blocked.code, "FROZEN");

  if (before.length) {
    const del = await s("DELETE", `/api/materials/${before[0].id}`);
    assert.equal(del.status, 409, JSON.stringify(del.data));
    assert.equal(del.code, "FROZEN");
  }

  // 总管理员：加得进去，也删得掉
  const added = await a("POST", `/api/projects/${SETTLED}/materials`, { kind: "发票", name: "总管理员补录凭证" });
  assert.equal(added.status, 200, JSON.stringify(added.data));
  await assertBypassAudited(SETTLED, "材料登记");

  const rows = (await a("GET", "/api/materials")).data.rows.filter((m) => m.pid === SETTLED);
  const mine = rows.find((m) => m.name === "总管理员补录凭证");
  assert.ok(mine, "总管理员补录的材料应出现在清单里");
  const removed = await a("DELETE", `/api/materials/${mine.id}`);
  assert.equal(removed.status, 200, JSON.stringify(removed.data));
  await assertBypassAudited(SETTLED, "材料删除");
});

test("已归档项目：assoc 仍不能删材料，总管理员可放行", async () => {
  await shareWithAssoc(ARCHIVED);
  const mats = (await client(admin)("GET", "/api/materials")).data.rows.filter((m) => m.pid === ARCHIVED);
  assert.ok(mats.length, "归档项目应有材料");

  const blocked = await client(assoc)("DELETE", `/api/materials/${mats[0].id}`);
  assert.equal(blocked.status, 409);
  assert.match(blocked.msg, /已归档/);

  const ok = await client(admin)("DELETE", `/api/materials/${mats[0].id}`);
  assert.equal(ok.status, 200, "总管理员删归档项目材料应放行：" + JSON.stringify(ok.data));
  await assertBypassAudited(ARCHIVED, "材料删除");
});

test("已归档项目改预算：assoc 被拒，总管理员放行", async () => {
  const before = (await client(admin)("GET", `/api/projects/${ARCHIVED}`)).data.project.budget;

  const blocked = await client(assoc)("PATCH", `/api/projects/${ARCHIVED}`, { budget: before + 1000 });
  assert.equal(blocked.status, 409, JSON.stringify(blocked.data));
  assert.ok(["FROZEN", "ARCHIVED"].includes(blocked.code), `实际 code=${blocked.code}`);
  assert.match(blocked.msg, /已归档/);

  const ok = await client(admin)("PATCH", `/api/projects/${ARCHIVED}`, { budget: before + 1000 });
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  await assertBypassAudited(ARCHIVED, "项目资料");
  await client(admin)("PATCH", `/api/projects/${ARCHIVED}`, { budget: before });
});

test("核销结论：已结算项目连超管也不能改", async () => {
  const r = await client(admin)("POST", `/api/projects/${SETTLED}/verify/steps/1`, { result: "不通过", remark: "事后篡改" });
  assert.ok(r.status >= 400, `应被拒，实际 ${r.status}`);
  assert.ok(["FROZEN", "ILLEGAL_STATE"].includes(r.code), `实际 code=${r.code}`);
});

test("已结算项目：assoc 不能提例外单，总管理员不再被「冻结」拦住", async () => {
  const blocked = await client(assoc)("POST", `/api/projects/${SETTLED}/exceptions`, { step_no: 3, reason: "事后补例外" });
  assert.equal(blocked.status, 409);
  assert.equal(blocked.code, "FROZEN");

  // 总管理员放行的是「冻结」，不是「状态机」：已结算阶段本来就没有核销步骤可提例外，
  // 这时应该给 ILLEGAL_STATE（流程规则），而不是 FROZEN（封账规则）。
  const r = await client(admin)("POST", `/api/projects/${SETTLED}/exceptions`, { step_no: 3, reason: "总管理员事后补例外" });
  assert.notEqual(r.code, "FROZEN", "总管理员不应再被冻结拦住：" + JSON.stringify(r.data));
});

/**
 * 历史冻结材料 = 软删（deleted_at 非空）。
 * 软删的本意是保留证据不销毁，但默认视图里看不见 —— 误删一份发票原件，
 * 归档齐备度和核销第 6 步就再也补不回来。总管理员必须能把它解冻。
 */
test("历史冻结材料：默认清单看不到，总管理员可单列出来并恢复", async () => {
  const a = client(admin);
  const created = await a("POST", `/api/projects/${OPEN}/materials`, { kind: "发票", name: "误删的发票原件" });
  assert.equal(created.status, 200, JSON.stringify(created.data));

  const row = (await a("GET", "/api/materials")).data.rows.find((m) => m.pid === OPEN && m.name === "误删的发票原件");
  assert.ok(row, "材料应登记成功");

  const del = await a("DELETE", `/api/materials/${row.id}`);
  assert.equal(del.status, 200, JSON.stringify(del.data));

  const live = (await a("GET", "/api/materials")).data.rows.some((m) => m.id === row.id);
  assert.equal(live, false, "冻结后默认清单不应再出现");

  const frozen = (await a("GET", "/api/materials?frozen=1")).data.rows;
  assert.ok(frozen.some((m) => m.id === row.id), "总管理员应能在历史冻结视图里找到它");

  // 重复删除没有意义，谁都不放行
  const again = await a("DELETE", `/api/materials/${row.id}`);
  assert.equal(again.status, 409);
  assert.equal(again.code, "ALREADY_DELETED");

  const restored = await a("POST", `/api/materials/${row.id}/restore`, {});
  assert.equal(restored.status, 200, JSON.stringify(restored.data));
  const back = (await a("GET", "/api/materials")).data.rows.some((m) => m.id === row.id);
  assert.equal(back, true, "恢复后应重新出现在清单里");
});

test("历史冻结材料：非总管理员看不到冻结视图", async () => {
  const r = await client(assoc)("GET", "/api/materials?frozen=1");
  assert.equal(r.status, 403, JSON.stringify(r.data));
});
