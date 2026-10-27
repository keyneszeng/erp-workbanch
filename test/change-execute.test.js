"use strict";
/**
 * 变更落账（双人复核）回归
 * 运行：node --experimental-sqlite --test test/change-execute.test.js
 *
 * 老板 2026-10-27 拍板：变更审批通过后**不自动改预算**，必须人工再改一次，
 * 且执行人不能是审批人、也不能是申请人。这里把这条规则钉死：
 *   1. 审批通过后项目预算一动不动（审批 ≠ 生效）
 *   2. 审批人自己不能落账（409 NEED_SECOND_PERSON）
 *   3. 申请人自己不能落账（409 NEED_SECOND_PERSON）
 *   4. 换一个人落账 → 预算写回、状态「已执行」、审计留痕
 *   5. 重复落账 / 非变更单落账 / 变更后预算低于已占用 全部拦掉
 *
 * 用例隔离说明：每个用例都**新建一个项目**，不复用种子项目。
 * 原因有二 ——
 *   a) 「已批未落账」拦截是按项目算的，共用项目会让前一个用例的残留单挡住后一个用例；
 *   b) 数据范围是按协会 / 负责人 / 成员算的，种子项目里 exec 与 assoc 未必同时可见，
 *      拿种子项目跑会得到「该项目不在你的数据范围内」这种与规则无关的 403。
 */
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const PORT = 8815;
const BASE = `http://127.0.0.1:${PORT}`;
const DB = path.join(__dirname, "..", "data", "test15.db");
const UP = path.join(__dirname, "..", "data", "test15-uploads");
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

async function projectOf(cookie, pid) {
  const r = await client(cookie)("GET", `/api/projects/${pid}`);
  assert.equal(r.status, 200, `读取项目 ${pid} 失败：${JSON.stringify(r.data)}`);
  return r.data.project;
}
async function approvalOf(cookie, pid, aid) {
  const r = await client(cookie)("GET", `/api/projects/${pid}`);
  assert.equal(r.status, 200, `读取项目 ${pid} 失败`);
  return r.data.approvals.find((a) => a.id === aid);
}

/**
 * 造一个「可提交变更」的干净项目：草稿 → 待审批 → 已立项。
 *
 * 由 exec 创建（有 project:create），负责人写成「陈静」，
 * 这样四个人都看得见：exec 是创建人（成员）、finance 是负责人、
 * assoc 靠协会匹配、admin 是总管理员。少一个人就会撞数据范围，测不到真正要测的规则。
 */
async function freshProject({ budget = 50000, owner = "陈静" } = {}) {
  const c = client(exec);
  const r = await c("POST", "/api/projects", {
    name: `双人复核用例项目 ${Date.now()}-${++seq}`,
    assoc: "华东医学会", form: "线下", date: "2027-06-01",
    budget, people: 60, owner, agenda: "09:00 开幕致辞 / 13:30 分论坛"
  });
  assert.equal(r.status, 200, `建项目失败：${JSON.stringify(r.data)}`);
  const pid = r.data.project.id;
  const s1 = await c("POST", `/api/projects/${pid}/transition`, { action: "submit" });
  assert.equal(s1.status, 200, `提交立项失败：${JSON.stringify(s1.data)}`);
  const s2 = await client(assoc)("POST", `/api/projects/${pid}/transition`, { action: "approve" });
  assert.equal(s2.status, 200, `审批立项失败：${JSON.stringify(s2.data)}`);
  return pid;
}

/** 提交变更 → 审批通过，返回审批单号（此时仍未落账） */
async function changeAndApprove(submitCookie, approveCookie, pid, { title, budget } = {}) {
  const body = { title: title || `双人复核用例 ${Date.now()}` };
  if (budget !== undefined) body.budget = budget;
  const sub = await client(submitCookie)("POST", `/api/projects/${pid}/change`, body);
  assert.equal(sub.status, 200, JSON.stringify(sub.data));
  const id = sub.data.approval.id;
  const ap = await client(approveCookie)("POST", `/api/approvals/${id}/decide`, { approve: true, comment: "同意变更" });
  assert.equal(ap.status, 200, JSON.stringify(ap.data));
  return id;
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

test("审批通过后项目预算不动 —— 审批 ≠ 生效", async () => {
  const pid = await freshProject({ budget: 50000 });
  const before = Number(await projectOf(admin, pid).then((p) => p.budget));
  const next = before + 5000;
  const id = await changeAndApprove(exec, assoc, pid, { title: "预算上调 5000（审批后不落账）", budget: next });

  const p = await projectOf(admin, pid);
  assert.equal(Number(p.budget), before, "审批通过不应改预算");
  assert.equal(p.status, "已立项", "审批通过不应改项目状态");

  const ap = await approvalOf(admin, pid, id);
  assert.equal(ap.status, "已通过", "审批单状态应为「已通过」");
  assert.ok(!ap.executed_at, "未落账时 executed_at 应为空");
  assert.equal(Number(ap.amount), next, "审批单应记住变更后预算");
});

test("审批人自己不能落账（双人复核）", async () => {
  const pid = await freshProject();
  // exec 提交、assoc 审批 → assoc 想自己落账，必须被拦
  const id = await changeAndApprove(exec, assoc, pid, { title: "审批人自落账用例", budget: 60000 });
  const r = await client(assoc)("POST", `/api/approvals/${id}/execute`, {});
  assert.equal(r.status, 409, JSON.stringify(r.data));
  assert.equal(r.data.error.code, "NEED_SECOND_PERSON");
  assert.match(r.data.error.message, /双人复核/);
  assert.equal(r.data.error.detail.decided_by, "王敏");

  // 预算一分没动
  assert.equal(Number((await projectOf(admin, pid)).budget), 50000);
});

test("申请人自己不能落账（双人复核）", async () => {
  const pid = await freshProject();
  // exec 提交、assoc 审批 → exec 想自己落账，必须被拦
  const id = await changeAndApprove(exec, assoc, pid, { title: "申请人自落账用例", budget: 60000 });
  const r = await client(exec)("POST", `/api/approvals/${id}/execute`, {});
  assert.equal(r.status, 409, JSON.stringify(r.data));
  assert.equal(r.data.error.code, "NEED_SECOND_PERSON");
  assert.match(r.data.error.message, /双人复核/);
  assert.equal(r.data.error.detail.by_user, "张伟");

  assert.equal(Number((await projectOf(admin, pid)).budget), 50000);
});

test("换一个人落账：预算写回、状态已执行、审计留痕", async () => {
  const pid = await freshProject({ budget: 50000 });
  const next = 58888;
  // exec 提交 → assoc 审批 → admin 落账（三个人互不重合）
  const id = await changeAndApprove(exec, assoc, pid, { title: "第三人落账用例", budget: next });

  const r = await client(admin)("POST", `/api/approvals/${id}/execute`, {});
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.budget.from, 50000);
  assert.equal(r.data.budget.to, next);
  assert.equal(Number(r.data.project.budget), next, "落账后预算应写回");
  assert.equal(r.data.approval.status, "已执行");
  assert.equal(r.data.approval.executed_by, "李静");
  assert.ok(r.data.approval.executed_at, "应记录落账时间");

  // 审计：变更落账要有一条，且写明预算变化
  const audit = await client(admin)("GET", `/api/audit?q=${encodeURIComponent(pid)}`);
  const hit = audit.data.rows.find((a) => a.action === "变更落账");
  assert.ok(hit, "应有「变更落账」审计");
  assert.match(hit.detail, /预算/);
  assert.match(hit.detail, /58,888/);
});

test("财务也能落账（change:execute 覆盖 finance）", async () => {
  // 项目负责人写成陈静（finance），财务才看得见这个项目
  const pid = await freshProject({ budget: 40000, owner: "陈静" });
  const id = await changeAndApprove(exec, assoc, pid, { title: "财务落账用例", budget: 45000 });

  const r = await client(finance)("POST", `/api/approvals/${id}/execute`, {});
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.approval.executed_by, "陈静");
  assert.equal(Number(r.data.project.budget), 45000);
});

test("重复落账被拦", async () => {
  const pid = await freshProject({ budget: 30000 });
  const id = await changeAndApprove(exec, assoc, pid, { title: "重复落账用例", budget: 30100 });
  const first = await client(admin)("POST", `/api/approvals/${id}/execute`, {});
  assert.equal(first.status, 200, JSON.stringify(first.data));
  const again = await client(admin)("POST", `/api/approvals/${id}/execute`, {});
  assert.equal(again.status, 409, JSON.stringify(again.data));
  assert.equal(again.data.error.code, "ALREADY_EXECUTED");
});

test("未审批的变更单不能落账", async () => {
  const pid = await freshProject();
  const sub = await client(exec)("POST", `/api/projects/${pid}/change`, { title: "还没批就想落账", budget: 60000 });
  assert.equal(sub.status, 200, JSON.stringify(sub.data));
  const r = await client(admin)("POST", `/api/approvals/${sub.data.approval.id}/execute`, {});
  assert.equal(r.status, 409, JSON.stringify(r.data));
  assert.equal(r.data.error.code, "NOT_APPROVED");
});

test("非变更单不能调 execute", async () => {
  const r = await client(admin)("GET", "/api/approvals?status=待审批");
  const ap = r.data.rows.find((a) => a.type !== "变更审批");
  assert.ok(ap, "需要一张非变更类审批单");
  const x = await client(admin)("POST", `/api/approvals/${ap.id}/execute`, {});
  assert.equal(x.status, 400, JSON.stringify(x.data));
  assert.match(x.data.error.message, /不需要执行落账/);
});

test("变更后预算低于已占用：提交时就拦", async () => {
  // MP-2026-012 有一笔 76,000 待审批付款，committed > 0，压到 1 元必须被拦
  const r = await client(exec)("POST", "/api/projects/MP-2026-012/change", { title: "恶意压预算", budget: 1 });
  assert.equal(r.status, 409, JSON.stringify(r.data));
  assert.equal(r.data.error.code, "BUDGET_BELOW_COMMITTED");
  assert.ok(r.data.error.detail.used >= 76000, `已占用应 ≥ 76000，实际 ${r.data.error.detail.used}`);
});

test("已有已批未落账的变更时，不能再提交新变更", async () => {
  const pid = await freshProject();
  const id = await changeAndApprove(exec, assoc, pid, { title: "占位变更（不落账）", budget: 51000 });
  const r = await client(exec)("POST", `/api/projects/${pid}/change`, { title: "第二张变更" });
  assert.equal(r.status, 409, JSON.stringify(r.data));
  assert.equal(r.data.error.code, "CHANGE_PENDING_EXECUTE");
  assert.equal(r.data.error.detail.approval, id);

  // 落账之后就能再提交了 —— 否则项目会被一张单永久锁死
  const ok = await client(admin)("POST", `/api/approvals/${id}/execute`, {});
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  const again = await client(exec)("POST", `/api/projects/${pid}/change`, { title: "落账后的第二张变更" });
  assert.equal(again.status, 200, JSON.stringify(again.data));
});

test("只改内容的已批未落账，不阻塞新变更", async () => {
  // amount = 0 的变更没有钱要落，和新变更的预算打不起来。
  // 如果连它也拦，项目会被一张陈年内容变更永久锁死（种子数据 MP-2026-001 就是这种）。
  const pid = await freshProject();
  const id = await changeAndApprove(exec, assoc, pid, { title: "只改议程（不涉金额）" });
  const ap = await approvalOf(admin, pid, id);
  assert.equal(ap.status, "已通过");
  assert.equal(Number(ap.amount), 0);

  const r = await client(exec)("POST", `/api/projects/${pid}/change`, { title: "再提一张涉及预算的变更", budget: 52000 });
  assert.equal(r.status, 200, JSON.stringify(r.data));
});

test("变更审批本身要有 project:approve —— 执行/财务不能批", async () => {
  const pid = await freshProject();
  const sub = await client(exec)("POST", `/api/projects/${pid}/change`, { title: "越权审批用例" });
  assert.equal(sub.status, 200, JSON.stringify(sub.data));
  const id = sub.data.approval.id;
  for (const [name, cookie] of [["exec", exec], ["finance", finance]]) {
    const r = await client(cookie)("POST", `/api/approvals/${id}/decide`, { approve: true });
    assert.equal(r.status, 403, `${name} 不应能审批变更：${JSON.stringify(r.data)}`);
  }
});
