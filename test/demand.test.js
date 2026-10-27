"use strict";
/**
 * 会务需求模块回归测试 —— 列表 / 详情(种子+模板) / 保存 / 确认 / 重置 / 导出 / 权限
 * 运行：node --test test/demand.test.js
 */
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const PORT = 8804;
const BASE = `http://127.0.0.1:${PORT}`;
const DB = path.join(__dirname, "..", "data", "test4.db");
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
    return { status: r.status, data, headers: r.headers };
  };
}

let admin, assoc, exec, finance;

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
  exec = client(await login("exec"));
  finance = client(await login("finance"));
});
after(() => { if (proc) proc.kill("SIGTERM"); });

test("列表：协会管理员仅看到本协会项目且 MP-2026-001 已建需求单", async () => {
  const r = await assoc("GET", "/api/demand");
  assert.equal(r.status, 200);
  assert.ok(r.data.projects.length > 0 && r.data.projects.length < 18, "协会管理员应只看到本协会项目");
  const seeded = r.data.projects.find((p) => p.id === "MP-2026-001");
  assert.ok(seeded && seeded.demandBuilt, "MP-2026-001 应有种子需求单");
  assert.equal(seeded.needCount, 19, "需要项应为 19");
});

test("详情：MP-2026-001 种子数据四组齐全", async () => {
  const r = await assoc("GET", "/api/demand/MP-2026-001");
  assert.equal(r.status, 200);
  assert.deepEqual(r.data.groups, ["设计", "制作", "现场执行", "其他"]);
  assert.equal(r.data.items["设计"].length, 5);
  assert.equal(r.data.items["制作"].length, 9);
  assert.equal(r.data.items["现场执行"].length, 4);
  assert.equal(r.data.items["其他"].length, 5);
  assert.equal(r.data.confirmed, false);
});

test("数据范围：协会管理员访问非本协会项目返回 403", async () => {
  const r = await assoc("GET", "/api/demand/MP-2026-007"); // 肿瘤分会
  assert.equal(r.status, 403);
});

test("模板：未建单项目返回四组模板(23 项)且不落库", async () => {
  const r = await admin("GET", "/api/demand/MP-2026-002");
  assert.equal(r.status, 200);
  assert.equal(r.data.isTemplate, true);
  const total = Object.values(r.data.items).reduce((a, x) => a + x.length, 0);
  assert.equal(total, 23, "模板共 23 项");
  // 确认未落库：再次以列表核对 MP-2026-002 仍未被标记已建
  const list = await admin("GET", "/api/demand");
  const p = list.data.projects.find((x) => x.id === "MP-2026-002");
  assert.equal(p.demandBuilt, false);
});

test("保存：整单替换(PATCH)后明细被完全覆盖", async () => {
  const items = [
    { grp: "设计", item: "串场", need: "需要", spec: "主视觉", owner: "王敏", due: "2026-09-05", budget: "3800" },
    { grp: "其他", item: "垫付", need: "需要", spec: "", owner: "陈静", due: "", budget: "" }
  ];
  const p1 = await admin("PATCH", "/api/demand/MP-2026-002", { items });
  assert.equal(p1.status, 200);
  const d = await admin("GET", "/api/demand/MP-2026-002");
  const total = Object.values(d.data.items).reduce((a, x) => a + x.length, 0);
  assert.equal(total, 2, "保存后仅剩提交的 2 项（整单替换）");
  assert.equal(d.data.items["设计"][0].spec, "主视觉");
  assert.equal(d.data.items["设计"][0].budget, "3800", "预算金额按填写值保存");
  assert.equal(d.data.budgetTotal, 3800, "预算合计只算填了金额的条目");
  // 附件与执行状态已从业务上取消，接口不应再回吐这两个字段
  assert.equal("attach" in d.data.items["设计"][0], false, "不应再返回 attach");
  assert.equal("status" in d.data.items["设计"][0], false, "不应再返回 status");
});

test("新增一行：自定义条目（不在模板里）能存下来并回读", async () => {
  const r = await admin("PATCH", "/api/demand/MP-2026-002", {
    items: [
      { grp: "设计", item: "串场", need: "需要", budget: "3800" },
      { grp: "设计", item: "指引牌（临时加）", need: "需要", spec: "2 块 A2", budget: "260.5" }
    ]
  });
  assert.equal(r.status, 200);
  const d = await admin("GET", "/api/demand/MP-2026-002");
  const names = d.data.items["设计"].map((x) => x.item);
  assert.deepEqual(names, ["串场", "指引牌（临时加）"], "自定义条目应保留");
  assert.equal(d.data.items["设计"][1].budget, "260.5");
  assert.equal(d.data.budgetTotal, 4060.5, "3800 + 260.5");
});

test("权限：财务(无 demand:write)保存返回 403", async () => {
  const r = await finance("PATCH", "/api/demand/MP-2026-002", { items: [] });
  assert.equal(r.status, 403);
});

test("校验：预算金额填文字返回 400，且指出是哪一条", async () => {
  const r = await admin("PATCH", "/api/demand/MP-2026-002", {
    items: [{ grp: "设计", item: "串场", need: "需要", budget: "会务预算" }]
  });
  assert.equal(r.status, 400);
  assert.match(r.data.error.message, /串场/);
  assert.match(r.data.error.message, /数字/);
});

test("校验：预算金额超过两位小数返回 400", async () => {
  const r = await admin("PATCH", "/api/demand/MP-2026-002", {
    items: [{ grp: "设计", item: "串场", need: "需要", budget: "12.345" }]
  });
  assert.equal(r.status, 400);
});

test("校验：同一分组重名返回 400 DUPLICATE_ITEM", async () => {
  const r = await admin("PATCH", "/api/demand/MP-2026-002", {
    items: [
      { grp: "设计", item: "台卡", need: "需要" },
      { grp: "设计", item: "台卡 ", need: "需要" }
    ]
  });
  assert.equal(r.status, 400);
  assert.equal(r.data.error.code, "DUPLICATE_ITEM");
});

test("校验：保存空数组被拒，且不会把已建单抹回模板态", async () => {
  // 先确保这份单有内容
  await admin("PATCH", "/api/demand/MP-2026-002", {
    items: [{ grp: "设计", item: "串场", need: "需要", budget: "100" }]
  });
  const r = await admin("PATCH", "/api/demand/MP-2026-002", { items: [] });
  assert.equal(r.status, 400, "空数组应被拒，否则整单替换会把条目删光");
  assert.equal(r.data.error.code, "EMPTY_SHEET");
  // 被拒后原数据必须还在
  const d = await admin("GET", "/api/demand/MP-2026-002");
  const total = Object.values(d.data.items).reduce((a, x) => a + x.length, 0);
  assert.equal(total, 1, "被拒的请求不应改动数据");
  assert.equal(d.data.isTemplate, false, "不应退回模板态");
  const list = await admin("GET", "/api/demand");
  const p = list.data.projects.find((x) => x.id === "MP-2026-002");
  assert.equal(p.demandBuilt, true, "列表页仍应显示已建单");
});

test("校验：条目名按 trim 后的长度算，前后空格不会误拒", async () => {
  const name = "长".repeat(40);
  const r = await admin("PATCH", "/api/demand/MP-2026-002", {
    items: [{ grp: "设计", item: `  ${name}  `, need: "需要" }]
  });
  assert.equal(r.status, 200, "trim 后正好 40 字，应通过");
  const d = await admin("GET", "/api/demand/MP-2026-002");
  assert.equal(d.data.items["设计"][0].item, name, "入库的应是 trim 后的名字");
  // 超过 40 字仍然要拒
  const r2 = await admin("PATCH", "/api/demand/MP-2026-002", {
    items: [{ grp: "设计", item: "长".repeat(41), need: "需要" }]
  });
  assert.equal(r2.status, 400);
});

test("确认即归档：归档后重置被拒，撤销归档后才能重置", async () => {
  const c = await admin("POST", "/api/demand/MP-2026-002/confirm");
  assert.equal(c.status, 200);
  assert.equal(c.data.sheet.confirmed, true);
  assert.equal(c.data.sheet.archived, true, "确认即归档");
  // 归档后重置会删光条目，必须拦住
  const blocked = await admin("POST", "/api/demand/MP-2026-002/reset");
  assert.equal(blocked.status, 409);
  assert.equal(blocked.data.error.code, "DEMAND_ARCHIVED");
  // 撤销归档 → 重置
  const un = await admin("POST", "/api/demand/MP-2026-002/unarchive");
  assert.equal(un.status, 200);
  assert.equal(un.data.sheet.archived, false);
  const rst = await admin("POST", "/api/demand/MP-2026-002/reset");
  assert.equal(rst.status, 200);
  assert.equal(rst.data.sheet.isTemplate, true);
  const total = Object.values(rst.data.sheet.items).reduce((a, x) => a + x.length, 0);
  assert.equal(total, 23);
});

test("导出：返回带 BOM 的 CSV 且含表头", async () => {
  const res = await fetch(`${BASE}/api/demand/MP-2026-001/export`, { headers: { cookie: await login("admin") } });
  assert.equal(res.status, 200);
  assert.ok(res.headers.get("content-type").includes("text/csv"));
  const buf = Buffer.from(await res.arrayBuffer());
  assert.deepEqual([buf[0], buf[1], buf[2]], [0xef, 0xbb, 0xbf], "应有 UTF-8 BOM");
  const text = buf.toString("utf8");
  assert.ok(text.includes("分组") && text.includes("是否需要"));
  assert.ok(text.includes("串场"));
});
