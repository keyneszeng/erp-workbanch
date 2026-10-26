"use strict";
/**
 * 状态机穷举 + 全链路勾稽（V1.2.4）
 * 运行：node --test test/workflow-chain.test.js
 *
 * 前几轮测的是「单个接口该不该拒」，这一轮测两件更接近真实使用的事：
 *
 *   A. 状态机穷举 —— 9 个状态 × 9 个动作的完整矩阵。
 *      凡是不在 FLOW 里的组合，必须一律 409 ILLEGAL_TRANSITION，且状态一个字都不能变。
 *      这一组曾抓到：`reject` 走的是自己那条分支，错误码和提示语与其它非法跳转不一致，
 *      前端要为一个动作单独写分支，code 也失去「可据此判断状态不合法」的意义。
 *
 *   B. 全链路 + 事后勾稽 —— 4 个角色把 立项 → 归档 走完（含例外单、付款），
 *      结束后重新查一遍，确认所有跨表关系仍然自洽。
 *      这一组曾抓到：核销「不通过」会自动生成例外单，但审计只记「结论」，
 *      且 detail 里连例外单号都没有 —— 事后拿 EX-xxx 去追，找不到它是怎么产生的。
 */
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const PORT = 8814;
const BASE = `http://127.0.0.1:${PORT}`;
const DB = path.join(__dirname, "..", "data", "test16.db");
const UP = path.join(__dirname, "..", "data", "test16-uploads");
let proc;
let admin, assoc, executor, finance;

const ACTIONS = ["submit", "approve", "prep", "exec", "request_verify", "verify_pass", "settle", "archive", "reject"];

/** 每个状态取一个种子项目；顺序即业务推进顺序 */
const STATUS_PROJECT = {
  草稿: "MP-2026-018",
  待审批: "MP-2026-005",
  已立项: "MP-2026-009",
  筹备中: "MP-2026-001",
  执行中: "MP-2026-002",
  待核销: "MP-2026-003",
  已核销: "MP-2026-008",
  已结算: "MP-2026-006",
  已归档: "MP-2026-007"
};

/** 每个状态允许的动作（与 server/lib/constants.js 的 FLOW 一一对应） */
const ALLOWED = {
  草稿: ["submit"],
  待审批: ["approve", "reject"],
  已立项: ["prep"],
  筹备中: ["exec"],
  执行中: ["request_verify"],
  待核销: ["verify_pass"],
  已核销: ["settle"],
  已结算: ["archive"],
  已归档: []
};

function clean() {
  for (const f of [DB, DB + "-wal", DB + "-shm"]) if (fs.existsSync(f)) fs.unlinkSync(f);
  if (fs.existsSync(UP)) fs.rmSync(UP, { recursive: true, force: true });
}
async function waitHealth(t = 15000) {
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
  return async (method, url, body) => {
    const r = await fetch(BASE + url, {
      method, headers: { "Content-Type": "application/json", cookie },
      body: body ? JSON.stringify(body) : undefined
    });
    const text = await r.text();
    let data; try { data = JSON.parse(text); } catch { data = text; }
    return { status: r.status, data, code: data?.error?.code, msg: data?.error?.message || data?.message || "" };
  };
}
const statusOf = async (id) => (await admin("GET", `/api/projects/${id}`)).data.project.status;

before(async () => {
  clean();
  proc = spawn(process.execPath, ["--experimental-sqlite", "server/index.js"], {
    cwd: path.join(__dirname, ".."),
    env: { ...process.env, ERP_PORT: String(PORT), ERP_DB: DB, ERP_UPLOAD_DIR: UP },
    stdio: ["ignore", "pipe", "pipe"]
  });
  proc.stdout.on("data", () => {});
  proc.stderr.on("data", () => {});
  await waitHealth();
  admin = client(await login("admin"));
  assoc = client(await login("assoc"));
  executor = client(await login("exec"));
  finance = client(await login("finance"));
});

after(() => {
  proc?.kill();
  clean();
});

/* ================= A. 状态机穷举 ================= */

test("9 个状态 × 9 个动作：非法跳转一律 ILLEGAL_TRANSITION 且状态不变", async () => {
  const problems = [];
  for (const [status, pid] of Object.entries(STATUS_PROJECT)) {
    const allow = ALLOWED[status] || [];
    const illegal = ACTIONS.filter((a) => !allow.includes(a));

    for (const action of illegal) {
      const r = await admin("POST", `/api/projects/${pid}/transition`, { action, comment: "探测" });
      if (r.status !== 409 || r.code !== "ILLEGAL_TRANSITION") {
        problems.push(`${status} 执行 ${action} → ${r.status} ${r.code || ""}（应为 409 ILLEGAL_TRANSITION）`);
      }
      const now = await statusOf(pid);
      if (now !== status) problems.push(`${status} 执行 ${action} 后状态变成「${now}」`);
    }
  }
  assert.deepEqual(problems, [], problems.join("\n"));
});

test("非法跳转的错误体带 allowed 列表，前端可据此渲染", async () => {
  const r = await admin("POST", "/api/projects/MP-2026-001/transition", { action: "archive" });
  assert.equal(r.status, 409);
  assert.equal(r.code, "ILLEGAL_TRANSITION");
  // 错误体的附加信息统一放在 error.detail（单数）
  assert.equal(r.data.error.detail.status, "筹备中");
  assert.deepEqual(r.data.error.detail.allowed, ["exec"]);
});

test("reject 在非「待审批」状态也返回 ILLEGAL_TRANSITION（与其它动作同口径）", async () => {
  const r = await admin("POST", "/api/projects/MP-2026-001/transition", { action: "reject", comment: "x" });
  assert.equal(r.status, 409);
  assert.equal(r.code, "ILLEGAL_TRANSITION", `实际 ${r.code} / ${r.msg}`);
  assert.match(r.msg, /当前状态「筹备中」/);
  assert.ok(Array.isArray(r.data.error.detail.allowed));
});

test("reject 不带理由被拒，且不会改状态", async () => {
  const r = await assoc("POST", "/api/projects/MP-2026-005/transition", { action: "reject" });
  assert.equal(r.status, 400);
  assert.match(r.msg, /驳回必须填写理由/);
  assert.equal(await statusOf("MP-2026-005"), "待审批");
});

/* ================= B. 全链路 + 事后勾稽 ================= */

const BUDGET = 100000;
const PAY = 60000;
let pid = "";

test("全链路：立项 → 筹备 → 执行 → 核销（含例外）→ 付款 → 结算 → 归档", async () => {
  const created = await assoc("POST", "/api/projects", {
    name: "全链路回归会", assoc: "华东医学会", form: "线下", date: "2027-05-20",
    days: 2, budget: BUDGET, people: 200, owner: "王敏", phone: "13800000002",
    dept: "会务部", agenda: "09:00 开幕 / 10:00 主题演讲 / 14:00 分论坛"
  });
  assert.equal(created.status, 200, JSON.stringify(created.data));
  pid = created.data.project.id;

  // exec / finance 的数据范围是「本人负责或项目成员」，新建项目默认只有负责人可见，
  // 必须由协会管理员授权后才能参与 —— 这一步不能漏，否则后面全是 403。
  for (const uid of [3, 4]) {
    const r = await assoc("POST", `/api/projects/${pid}/members`, { user_id: uid });
    assert.equal(r.status, 200, `授权成员 ${uid} 失败：${JSON.stringify(r.data)}`);
  }

  const steps = [
    ["提交立项", () => assoc("POST", `/api/projects/${pid}/transition`, { action: "submit" })],
    ["审批通过", () => assoc("POST", `/api/projects/${pid}/transition`, { action: "approve", comment: "同意" })],
    ["进入筹备", () => executor("POST", `/api/projects/${pid}/transition`, { action: "prep" })],
    ["进入执行", () => executor("POST", `/api/projects/${pid}/transition`, { action: "exec" })]
  ];
  for (const [label, fn] of steps) {
    const r = await fn();
    assert.equal(r.status, 200, `${label} 失败：${r.status} ${r.code} ${r.msg}`);
  }

  // 8 类材料（发票、劳务表由财务补）
  for (const k of ["立项文件", "合同", "议程", "课件", "签到表", "劳务表", "发票", "现场照片"]) {
    const c = k === "发票" || k === "劳务表" ? finance : executor;
    const r = await c("POST", `/api/projects/${pid}/materials`, { kind: k, name: `${k}（全链路）` });
    assert.equal(r.status, 200, `登记材料「${k}」失败：${r.msg}`);
  }

  const c1 = await assoc("POST", "/api/contracts", {
    pid, name: "全链路会场服务合同", vendor: "测试会展公司",
    amount: PAY, sign_date: "2027-04-01", status: "已签署"
  });
  assert.equal(c1.status, 200, JSON.stringify(c1.data));

  const rv = await executor("POST", `/api/projects/${pid}/transition`, { action: "request_verify" });
  assert.equal(rv.status, 200, rv.msg);

  for (let no = 1; no <= 5; no++) {
    const r = await executor("POST", `/api/projects/${pid}/verify/steps/${no}`, { result: "通过" });
    assert.equal(r.status, 200, `第 ${no} 步判定失败：${r.msg}`);
  }
  const fail = await executor("POST", `/api/projects/${pid}/verify/steps/6`, {
    result: "不通过", remark: "发票金额与合同差 200 元"
  });
  assert.equal(fail.status, 200, fail.msg);
  assert.match(fail.msg, /已生成例外单/);

  // 例外单审批通过
  const vd = (await admin("GET", `/api/projects/${pid}/verify`)).data;
  const ex = vd.verification.exceptions.find((e) => e.status === "待审批");
  assert.ok(ex, "第 6 步不通过必须生成待审批例外单");
  const dec = await finance("POST", `/api/exceptions/${ex.id}/decide`, { approve: true, comment: "差额已补票" });
  assert.equal(dec.status, 200, dec.msg);

  const vp = await finance("POST", `/api/projects/${pid}/transition`, { action: "verify_pass" });
  assert.equal(vp.status, 200, vp.msg);

  const pay = await assoc("POST", "/api/payments", {
    pid, type: "学会公付", payee: "测试会展公司", amount: PAY, invoice_no: "INV-FULL-001"
  });
  assert.equal(pay.status, 200, pay.msg);
  const payId = pay.data.payment.id;
  assert.equal((await finance("POST", `/api/payments/${payId}/approve`, { approve: true })).status, 200);
  assert.equal((await finance("POST", `/api/payments/${payId}/pay`, {})).status, 200);

  const st = await finance("POST", `/api/projects/${pid}/transition`, { action: "settle" });
  assert.equal(st.status, 200, st.msg);
  const ar = await assoc("POST", `/api/projects/${pid}/transition`, { action: "archive" });
  assert.equal(ar.status, 200, ar.msg);

  assert.equal(await statusOf(pid), "已归档");
});

test("事后勾稽：结算单 income/expense/profit 与预算、已付款一致", async () => {
  const d = (await admin("GET", `/api/projects/${pid}`)).data;
  const paid = d.payments.filter((y) => y.status === "已付款").reduce((s, y) => s + Number(y.amount), 0);
  assert.equal(paid, PAY, "已付款合计应为付款金额");
  assert.ok(d.settlement, "已归档项目必须有结算单");
  assert.equal(Number(d.settlement.income), BUDGET, "结算单 income 应等于项目预算");
  assert.equal(Number(d.settlement.expense), paid, "结算单 expense 应等于已付款合计");
  assert.equal(Number(d.settlement.profit), BUDGET - paid, "profit 应为 income − expense");
  assert.equal(Number(d.paidTotal), paid, "项目详情 paidTotal 应与付款一致");
});

test("事后勾稽：6 步核销全通过，8 类材料齐备", async () => {
  const d = (await admin("GET", `/api/projects/${pid}`)).data;
  const passed = d.verification.steps.filter((x) => ["通过", "已解例外"].includes(x.result));
  assert.equal(passed.length, 6, `核销通过步数 ${passed.length}/6`);
  assert.equal(d.verification.complete, true);
  assert.equal(d.materialsStatus.ok, true, `缺材料：${d.materialsStatus.missing.join("、")}`);
  assert.equal(d.materialsStatus.have.length, 8);
});

test("归档后 9 类写操作全部被拒", async () => {
  const cases = [
    ["材料登记", () => executor("POST", `/api/projects/${pid}/materials`, { kind: "发票", name: "归档后补" })],
    ["合同录入", () => assoc("POST", "/api/contracts", { pid, name: "归档后合同", vendor: "x", amount: 1 })],
    ["付款申请", () => assoc("POST", "/api/payments", { pid, type: "学会公付", payee: "x", amount: 1 })],
    ["需求单保存", () => assoc("PATCH", `/api/demand/${pid}`, { items: [] })],
    ["需求单重置", () => assoc("POST", `/api/demand/${pid}/reset`)],
    ["加成员", () => assoc("POST", `/api/projects/${pid}/members`, { user_id: 5 })],
    ["改资料", () => assoc("PATCH", `/api/projects/${pid}`, { name: "归档后改名" })],
    ["提交变更", () => assoc("POST", `/api/projects/${pid}/change`, { title: "归档后变更" })],
    ["例外单", () => executor("POST", `/api/projects/${pid}/exceptions`, { step_no: 1, reason: "归档后例外" })]
  ];
  const leaked = [];
  for (const [label, fn] of cases) {
    const r = await fn();
    if (r.status === 200) leaked.push(`${label} → 200`);
  }
  assert.deepEqual(leaked, [], `归档后仍被放行的写操作：${leaked.join("; ")}`);
});

/* ================= C. 审计完整性 ================= */

test("审计覆盖全链路关键动作", async () => {
  const rows = (await admin("GET", `/api/projects/${pid}/timeline`)).data.rows;
  const actions = new Set(rows.map((l) => l.action));
  const expect = ["立项申请", "状态流转", "上传", "合同录入", "结论", "例外单", "例外通过",
    "付款申请", "付款审批通过", "付款", "归档"];
  const miss = expect.filter((a) => !actions.has(a));
  assert.deepEqual(miss, [], `审计缺：${miss.join("、")}；实际有：${[...actions].join("、")}`);
});

test("判定「不通过」自动生成的例外单必须单独留痕，且带单号", async () => {
  const rows = (await admin("GET", `/api/projects/${pid}/timeline`)).data.rows;
  const exRows = rows.filter((l) => l.action === "例外单");
  assert.ok(exRows.length >= 1, "自动生成例外单必须有 action=「例外单」的审计记录");

  const auto = exRows.find((l) => /自动生成/.test(l.detail || ""));
  assert.ok(auto, `例外单审计未标注「自动生成」：${JSON.stringify(exRows.map((r) => r.detail))}`);
  assert.match(auto.detail, /EX-\d{4}-\d+/, "例外单审计必须带单号，否则事后无法反查");

  // 「结论」那条也要带上例外单号，两条记录能互相指认
  const concl = rows.find((l) => l.action === "结论" && /不通过/.test(l.detail || ""));
  assert.ok(concl, "缺第 6 步「不通过」的结论审计");
  assert.match(concl.detail, /已生成例外单 EX-/, `结论 detail 未带单号：${concl.detail}`);
});
