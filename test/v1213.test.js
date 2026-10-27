"use strict";
/**
 * V1.2.13 回归：合同类别 / 材料自定义类别 / 例外单自定义步骤
 * 运行：node --experimental-sqlite --test test/v1213.test.js
 *
 * 老板 2026-10-27 报的三个问题：
 *   1. MP-2026-012 第 5 步「劳务与专家费核对」里列出了 HT-2026-008「会场租赁及餐饮」
 *      —— 合同没有类别字段，第 5 步只能把项目下所有合同都摆上来；
 *   2. 提交例外单的「对应步骤」下拉只有 6 个选项，不在 6 步里的问题没法登记；
 *   3. 登记材料的「材料类别」写死 8 类，会议纪要 / 专家简历这类东西进不了卷宗。
 *
 * 用例隔离：每个用例新建项目，不复用种子项目 —— 例外单会改核销状态，
 * 材料登记会改齐备度，共用项目会让用例互相污染。
 */
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const PORT = 8821;
const BASE = `http://127.0.0.1:${PORT}`;
const DB = path.join(__dirname, "..", "data", "test21.db");
const UP = path.join(__dirname, "..", "data", "test21-uploads");
let proc;
let admin, assoc, exec, finance;
let seq = 0;

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

/** 造一个四人都看得见、已到「已立项」的项目 */
async function freshProject({ budget = 80000 } = {}) {
  const c = client(exec);
  const r = await c("POST", "/api/projects", {
    name: `V1.2.13 用例项目 ${Date.now()}-${++seq}`,
    assoc: "华东医学会", form: "线下", date: "2027-07-01",
    budget, people: 80, owner: "陈静", agenda: "09:00 开幕 / 13:30 分论坛"
  });
  assert.equal(r.status, 200, `建项目失败：${JSON.stringify(r.data)}`);
  const pid = r.data.project.id;
  assert.equal((await c("POST", `/api/projects/${pid}/transition`, { action: "submit" })).status, 200);
  assert.equal((await client(assoc)("POST", `/api/projects/${pid}/transition`, { action: "approve" })).status, 200);
  return pid;
}

/** 已立项 → 筹备中 → 执行中 → 待核销（例外单只能在这两个阶段提） */
async function toPendingVerify(pid) {
  const c = client(exec);
  for (const action of ["prep", "exec", "request_verify"]) {
    const r = await c("POST", `/api/projects/${pid}/transition`, { action });
    assert.equal(r.status, 200, `${action} 失败：${JSON.stringify(r.data)}`);
  }
}

async function detail(pid) {
  const r = await client(admin)("GET", `/api/projects/${pid}`);
  assert.equal(r.status, 200, `读取项目 ${pid} 失败`);
  return r.data;
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
  exec = await login("exec");
  finance = await login("finance");
});
after(() => {
  if (proc) proc.kill("SIGTERM");
  if (fs.existsSync(UP)) fs.rmSync(UP, { recursive: true, force: true });
});

/* ---------------- 问题 1：合同类别 ---------------- */

test("合同没填类别时按名称推断，不再一律空着", async () => {
  const pid = await freshProject();
  const c = client(exec);
  const cases = [
    ["专家劳务协议（讲者）", "劳务专家"],
    ["会场租赁及餐饮服务", "场地餐饮"],
    ["主视觉与物料制作", "物料搭建"],
    ["直播平台技术服务", "设备技术"],
    ["第三方审计服务费", "其他"]
  ];
  for (const [name, want] of cases) {
    const r = await c("POST", "/api/contracts", { pid, name, vendor: "某供应商", amount: 1000, status: "草稿" });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.equal(r.data.contract.category, want, `「${name}」应归为「${want}」`);
  }
});

test("合同类别可以显式指定，非法值被拒", async () => {
  const pid = await freshProject();
  const c = client(exec);
  const ok = await c("POST", "/api/contracts", {
    pid, name: "某个不好判断的服务", vendor: "某供应商", amount: 2000, status: "草稿", category: "物料搭建"
  });
  assert.equal(ok.status, 200);
  assert.equal(ok.data.contract.category, "物料搭建", "显式指定的类别应压过名称推断");

  const bad = await c("POST", "/api/contracts", {
    pid, name: "x", vendor: "y", amount: 100, status: "草稿", category: "随便写一个"
  });
  assert.equal(bad.status, 400, "不在类别表里的值应被拒");
});

test("项目详情里每份合同都带类别 —— 第 5 步据此筛「劳务专家」", async () => {
  const pid = await freshProject();
  const c = client(exec);
  await c("POST", "/api/contracts", { pid, name: "会场租赁及餐饮", vendor: "成都天府会议中心", amount: 152000, status: "待签署" });
  await c("POST", "/api/contracts", { pid, name: "专家劳务协议", vendor: "某医学会", amount: 36000, status: "待签署" });

  const d = await detail(pid);
  assert.equal(d.contracts.length, 2);
  assert.ok(d.contracts.every((x) => x.category), "每份合同都该有类别，否则第 5 步筛不出东西");
  const labor = d.contracts.filter((x) => x.category === "劳务专家");
  assert.equal(labor.length, 1, "只有专家劳务协议该进第 5 步");
  assert.equal(labor[0].name, "专家劳务协议");
});

test("种子数据的历史合同都补上了类别", async () => {
  // 老库升级时按名称补；新库走 seed 时直接写。两条路径都得有值，
  // 否则第 5 步会显示「没有劳务专家类合同」，比原来「全都列出来」更误导人。
  const r = await client(admin)("GET", "/api/contracts");
  assert.equal(r.status, 200);
  const empty = r.data.rows.filter((c) => !c.category);
  assert.equal(empty.length, 0, `还有 ${empty.length} 份合同没有类别：${empty.map((x) => x.id).join("、")}`);
});

/* ---------------- 问题 3：材料自定义类别 ---------------- */

test("材料可以自定义类别，但不顶替必备 8 类", async () => {
  const pid = await freshProject();
  const before = (await detail(pid)).materialsStatus.missing.length;

  const r = await client(exec)("POST", `/api/projects/${pid}/materials`, { kind: "会议纪要", name: "会后纪要.pdf" });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.materialsStatus.missing.length, before, "自定义类别不应减少必备 8 类的缺口");
  assert.ok(r.data.materialsStatus.have.includes("会议纪要"), "自定义类别应能查到");

  const d = await detail(pid);
  assert.ok(d.materials.some((m) => m.kind === "会议纪要"), "材料列表里应出现自定义类别");
});

test("材料类别为空 / 超长仍要拒", async () => {
  const pid = await freshProject();
  const c = client(exec);
  assert.equal((await c("POST", `/api/projects/${pid}/materials`, { kind: "  ", name: "x.pdf" })).status, 400);
  assert.equal((await c("POST", `/api/projects/${pid}/materials`, { kind: "长".repeat(21), name: "x.pdf" })).status, 400);
});

/* ---------------- 问题 2：例外单自定义步骤 ---------------- */

test("例外单自定义步骤：不写事项被拒", async () => {
  const pid = await freshProject();
  await toPendingVerify(pid);
  const c = client(exec);
  assert.equal((await c("POST", `/api/projects/${pid}/exceptions`, { step_no: 0, reason: "专家临时换人" })).status, 400);
  assert.equal(
    (await c("POST", `/api/projects/${pid}/exceptions`, { step_no: 0, step_label: "   ", reason: "专家临时换人" })).status,
    400
  );
});

test("例外单自定义步骤：写了事项能提交，事项名落库并进审批标题", async () => {
  const pid = await freshProject();
  await toPendingVerify(pid);
  const r = await client(exec)("POST", `/api/projects/${pid}/exceptions`, {
    step_no: 0, step_label: "专家临时换人", reason: "原定讲者临时替换为同科室副主任，劳务表按新人重签"
  });
  assert.equal(r.status, 200, JSON.stringify(r.data));

  const ex = r.data.exceptions.find((x) => x.step_no === 0);
  assert.ok(ex, "应生成一张 step_no = 0 的例外单");
  assert.equal(ex.step_label, "专家临时换人");
  assert.equal(ex.status, "待审批");

  const d = await detail(pid);
  const ap = d.approvals.find((a) => a.ref_id === ex.id);
  assert.ok(ap, "例外单应同步生成审批单");
  assert.ok(ap.title.includes("专家临时换人"), `审批标题应带事项名，实际：${ap.title}`);
});

test("自定义例外单批准后不再阻塞核销，也不会乱标某一步", async () => {
  const pid = await freshProject();
  await toPendingVerify(pid);
  const r = await client(exec)("POST", `/api/projects/${pid}/exceptions`, {
    step_no: 0, step_label: "场地临时变更", reason: "原场地消防整改，临时换到同层 B 厅"
  });
  assert.equal(r.status, 200);
  const exId = r.data.exceptions.find((x) => x.step_no === 0).id;

  let d = await detail(pid);
  assert.equal(d.verification.openExceptions, 1, "待审批时应有 1 张未决例外单");

  const ap = await client(finance)("POST", `/api/exceptions/${exId}/decide`, { approve: true, comment: "知悉，同意" });
  assert.equal(ap.status, 200, JSON.stringify(ap.data));

  d = await detail(pid);
  assert.equal(d.verification.openExceptions, 0, "批准后不该再阻塞核销");
  const ex = d.verification.exceptions.find((x) => x.id === exId);
  assert.equal(ex.status, "已通过");
  // 关键：不针对某一步，就不该把任何一步标成「已解例外」——
  // 否则等于用一张「场地变更」的单子替第 1~6 步中的某一步背了书。
  assert.ok(
    d.verification.steps.every((s) => s.result !== "已解例外"),
    "自定义例外单不应解除任何步骤的判定"
  );
});
