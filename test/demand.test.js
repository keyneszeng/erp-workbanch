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
    { grp: "设计", item: "串场", need: "需要", spec: "主视觉", owner: "王敏", due: "2026-09-05", budget: "会务预算", attach: "", status: "已完成" },
    { grp: "其他", item: "垫付", need: "需要", spec: "", owner: "陈静", due: "", budget: "", attach: "", status: "进行中" }
  ];
  const p1 = await admin("PATCH", "/api/demand/MP-2026-002", { items });
  assert.equal(p1.status, 200);
  const d = await admin("GET", "/api/demand/MP-2026-002");
  const total = Object.values(d.data.items).reduce((a, x) => a + x.length, 0);
  assert.equal(total, 2, "保存后仅剩提交的 2 项（整单替换）");
  assert.equal(d.data.items["设计"][0].spec, "主视觉");
  assert.equal(d.data.items["其他"][0].status, "进行中");
});

test("权限：财务(无 demand:write)保存返回 403", async () => {
  const r = await finance("PATCH", "/api/demand/MP-2026-002", { items: [] });
  assert.equal(r.status, 403);
});

test("校验：非法执行状态取值返回 400", async () => {
  const r = await admin("PATCH", "/api/demand/MP-2026-002", {
    items: [{ grp: "设计", item: "串场", need: "需要", status: "搞错了" }]
  });
  assert.equal(r.status, 400);
});

test("确认与重置：确认后不可重复清空，重置回到模板", async () => {
  const c = await admin("POST", "/api/demand/MP-2026-002/confirm");
  assert.equal(c.status, 200);
  assert.equal(c.data.sheet.confirmed, true);
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
