"use strict";
/**
 * V1.2.19 回归：材料 8 类齐备才能开启核销
 * 运行：node --experimental-sqlite --test test/v1219.test.js
 *
 * 老板 2026-10-28：「必须完成 材料 8 项录入，才能开启 核销功能。
 *                   所以项目详情页里 材料 应该在 核销 前面。」
 *
 * 这条规则落在三个地方，缺一处就能绕过去：
 *   1. 提交核销（执行中 → 待核销）：材料不齐直接拦 —— 这是「开启核销」的入口；
 *   2. 单步判定：再拦一次 —— 防历史数据（门禁是这一版才加的）与判定后删材料；
 *   3. 核销通过：6 步判完但材料被删，仍然不许通过。
 *
 * 另外验一条「没有被削弱」的：归档仍然要求材料 8/8。
 */
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { fillMaterials } = require("./helpers/materials");
const { MATERIAL_KINDS } = require("../server/lib/constants");

const PORT = 8828;
const BASE = `http://127.0.0.1:${PORT}`;
const DB = path.join(__dirname, "..", "data", "test28.db");
const UP = path.join(__dirname, "..", "data", "test28-uploads");
let proc;
let admin;

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

/** 造一个「执行中」项目：材料一类都没登记 */
async function execProject(name) {
  const mk = await admin("POST", "/api/projects", {
    name: `${name}-${Date.now()}`, assoc: "华东医学会", form: "线下",
    date: "2027-12-12", budget: 30000, people: 20, owner: "王敏", agenda: "09:00 开幕"
  });
  assert.equal(mk.status, 200, JSON.stringify(mk.data));
  const pid = mk.data.project.id;
  for (const action of ["submit", "approve", "prep", "exec"]) {
    const r = await admin("POST", `/api/projects/${pid}/transition`, { action });
    assert.equal(r.status, 200, `${action} 失败：${JSON.stringify(r.data)}`);
  }
  return pid;
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
});

after(() => { if (proc) proc.kill("SIGTERM"); });

test("材料不齐：提交核销被拦，并说清缺哪几类", async () => {
  const pid = await execProject("材料门禁-提交核销");
  const r = await admin("POST", `/api/projects/${pid}/transition`, { action: "request_verify" });
  assert.equal(r.status, 409, `应 409，实际 ${r.status}`);
  assert.equal(r.data.error.code, "MATERIAL_GATE");
  assert.match(r.data.error.message, /还缺 8 类/);
  // 8 类名字要点出来，否则用户不知道该补什么
  for (const k of MATERIAL_KINDS) assert.ok(r.data.error.message.includes(k), `提示里应包含「${k}」`);

  // 状态没有被推走
  const d = await admin("GET", `/api/projects/${pid}`);
  assert.equal(d.data.project.status, "执行中");
});

test("补到 7 类仍然拦，补满 8 类才放行", async () => {
  const pid = await execProject("材料门禁-补到 7 类");
  for (const kind of MATERIAL_KINDS.slice(0, 7)) {
    const r = await admin("POST", `/api/projects/${pid}/materials`, { kind, name: `${kind}.pdf` });
    assert.equal(r.status, 200);
  }
  const seven = await admin("POST", `/api/projects/${pid}/transition`, { action: "request_verify" });
  assert.equal(seven.status, 409, "差一类也不该放行");
  assert.equal(seven.data.error.code, "MATERIAL_GATE");
  assert.match(seven.data.error.message, /还缺 1 类/);

  const last = MATERIAL_KINDS[7];
  await admin("POST", `/api/projects/${pid}/materials`, { kind: last, name: `${last}.pdf` });
  const ok = await admin("POST", `/api/projects/${pid}/transition`, { action: "request_verify" });
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  assert.equal(ok.data.project.status, "待核销");
});

test("已提交核销但材料被删（历史数据）：判定仍被拦", async () => {
  const pid = await execProject("材料门禁-判定兜底");
  await fillMaterials(admin, pid);
  const rv = await admin("POST", `/api/projects/${pid}/transition`, { action: "request_verify" });
  assert.equal(rv.status, 200);

  // 模拟「门禁上线前就已提交核销、材料却缺」的历史项目
  const d = await admin("GET", `/api/projects/${pid}`);
  const target = d.data.materials.find((m) => m.kind === "现场照片");
  const del = await admin("DELETE", `/api/materials/${target.id}`);
  assert.equal(del.status, 200, JSON.stringify(del.data));

  const judge = await admin("POST", `/api/projects/${pid}/verify/steps/1`, { result: "通过" });
  assert.equal(judge.status, 409, `缺料不该能判定，实际 ${judge.status}`);
  assert.equal(judge.data.error.code, "MATERIAL_GATE");
  assert.match(judge.data.error.message, /现场照片/);

  // 补回来就能判定
  await admin("POST", `/api/projects/${pid}/materials`, { kind: "现场照片", name: "现场照片-补.pdf" });
  const judge2 = await admin("POST", `/api/projects/${pid}/verify/steps/1`, { result: "通过" });
  assert.equal(judge2.status, 200, JSON.stringify(judge2.data));
});

test("6 步判完但材料被删：核销通过被拦", async () => {
  const pid = await execProject("材料门禁-核销通过");
  await fillMaterials(admin, pid);
  await admin("POST", `/api/projects/${pid}/transition`, { action: "request_verify" });
  for (let no = 1; no <= 6; no++) {
    const r = await admin("POST", `/api/projects/${pid}/verify/steps/${no}`, { result: "通过" });
    assert.equal(r.status, 200, `第 ${no} 步失败：${JSON.stringify(r.data)}`);
  }

  const d = await admin("GET", `/api/projects/${pid}`);
  const target = d.data.materials.find((m) => m.kind === "发票");
  await admin("DELETE", `/api/materials/${target.id}`);

  const pass = await admin("POST", `/api/projects/${pid}/transition`, { action: "verify_pass" });
  assert.equal(pass.status, 409, `缺料不该能核销通过，实际 ${pass.status}`);
  assert.match(pass.data.error.message, /发票/);

  await admin("POST", `/api/projects/${pid}/materials`, { kind: "发票", name: "发票-补.pdf" });
  const pass2 = await admin("POST", `/api/projects/${pid}/transition`, { action: "verify_pass" });
  assert.equal(pass2.status, 200, JSON.stringify(pass2.data));
  assert.equal(pass2.data.project.status, "已核销");
});

test("归档门禁没被削弱：结算前删掉一类材料，归档仍被拦", async () => {
  const pid = await execProject("材料门禁-归档仍生效");
  await fillMaterials(admin, pid);
  await admin("POST", `/api/projects/${pid}/transition`, { action: "request_verify" });
  for (let no = 1; no <= 6; no++) {
    await admin("POST", `/api/projects/${pid}/verify/steps/${no}`, { result: "通过" });
  }
  await admin("POST", `/api/projects/${pid}/transition`, { action: "verify_pass" });

  // 核销通过后、结算之前删掉一类材料（结算后材料就冻结了，删不动）
  const d = await admin("GET", `/api/projects/${pid}`);
  const target = d.data.materials.find((m) => m.kind === "签到表");
  assert.equal((await admin("DELETE", `/api/materials/${target.id}`)).status, 200);

  const st = await admin("POST", `/api/projects/${pid}/transition`, {
    action: "settle", payee_bank: "中国银行北京分行", payee_account: "3210987654321098"
  });
  assert.equal(st.status, 200, "结算不检查材料（材料是核销与归档的门槛）");

  const ar = await admin("POST", `/api/projects/${pid}/transition`, { action: "archive" });
  assert.equal(ar.status, 409, `材料缺一类不该能归档，实际 ${ar.status}`);
  assert.match(ar.data.error.message, /归档材料缺/);

  await admin("POST", `/api/projects/${pid}/materials`, { kind: "签到表", name: "签到表-补.pdf" });
  const ar2 = await admin("POST", `/api/projects/${pid}/transition`, { action: "archive" });
  assert.equal(ar2.status, 200, JSON.stringify(ar2.data));
});

test("接口把材料状态一并给前端，项目详情与核销看板同源", async () => {
  const pid = await execProject("材料状态同源");
  const d1 = await admin("GET", `/api/projects/${pid}`);
  const d2 = await admin("GET", `/api/projects/${pid}/verify`);
  assert.deepEqual(d1.data.materialsStatus, d2.data.materialsStatus, "两个接口的材料齐备度必须一致");
  assert.equal(d1.data.materialsStatus.ok, false);

  await fillMaterials(admin, pid);
  const d3 = await admin("GET", `/api/projects/${pid}`);
  assert.equal(d3.data.materialsStatus.ok, true);
  assert.deepEqual(d3.data.materialsStatus.missing, []);
});
