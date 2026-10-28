"use strict";
/**
 * 业务规则回归（V1.2.3）
 * 运行：node --test test/business-rules.test.js
 *
 * 这一批全部来自「对抗性探测找到的真缺陷」，每条都对应一个曾经真实发生过的错误行为：
 *   1. 合同状态不校验枚举 → 任意字符串入库，台账「已签署金额」漏算
 *   2. 合同签署日期不校验格式 → 「根本不是日期」也能存
 *   3. 变更申请只查数据范围不查权限 → 普通用户/嘉宾也能提交变更进审批中心
 *   4. 预算可下调到低于已占用金额 → 结算单 income < expense，负结余
 *   5. 付款收款方无长度上限 → 5000 字入库
 *   6. 同项目同收款方同发票号可重复挂账 → 重复报销
 *   7. 核销未开始（草稿等）就能提交例外单 → 审批中心被无意义单据污染
 * 另含合同总额超预算的预警（不硬拦，但必须回 warning）。
 */
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const PORT = 8812;
const BASE = `http://127.0.0.1:${PORT}`;
const DB = path.join(__dirname, "..", "data", "test14.db");
const UP = path.join(__dirname, "..", "data", "test14-uploads");
let proc;
let admin, assoc, finance, guest;

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
    let data; try { data = JSON.parse(text); } catch { data = text; }
    return { status: r.status, data, code: data?.error?.code, msg: data?.error?.message || data?.message || "" };
  };
}

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
  finance = client(await login("finance"));
  guest = client(await login("guest"));
});

after(() => {
  proc?.kill();
  clean();
});

/* ---------------- 合同字段校验 ---------------- */

test("合同状态不在白名单被拒", async () => {
  const r = await admin("POST", "/api/contracts", {
    pid: "MP-2026-001", name: "枚举测试", vendor: "某供应商", amount: 1000,
    status: "这个状态根本不存在"
  });
  assert.equal(r.status, 400);
  assert.match(r.msg, /合同状态必须是/);
});

test("合同状态合法值可正常录入", async () => {
  const r = await admin("POST", "/api/contracts", {
    pid: "MP-2026-001", name: "合法状态测试", vendor: "某供应商", amount: 1000,
    status: "待签署", sign_date: "2026-09-01"
  });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.contract.status, "待签署");
});

test("签署日期格式不对被拒", async () => {
  const r = await admin("POST", "/api/contracts", {
    pid: "MP-2026-001", name: "日期格式测试", vendor: "某供应商", amount: 1000,
    sign_date: "2026/09/01"
  });
  assert.equal(r.status, 400);
  assert.match(r.msg, /YYYY-MM-DD/);
});

test("签署日期是「不存在的日期」被拒", async () => {
  const r = await admin("POST", "/api/contracts", {
    pid: "MP-2026-001", name: "假日期测试", vendor: "某供应商", amount: 1000,
    sign_date: "2026-02-30"
  });
  assert.equal(r.status, 400);
  assert.match(r.msg, /不是有效日期/);
});

test("合同备注超长被拒", async () => {
  const r = await admin("POST", "/api/contracts", {
    pid: "MP-2026-001", name: "备注测试", vendor: "某供应商", amount: 1000,
    remark: "备".repeat(501)
  });
  assert.equal(r.status, 400);
  assert.match(r.msg, /备注不能超过/);
});

/* ---------------- 合同总额超预算预警 ---------------- */

test("合同总额超预算返回 warning 而非静默通过", async () => {
  // MP-2026-001 预算 180000，已有合同 96000 + 28000，再录 100000 必超
  const r = await admin("POST", "/api/contracts", {
    pid: "MP-2026-001", name: "超预算合同", vendor: "某供应商", amount: 100000
  });
  assert.equal(r.status, 200, "超预算不硬拦，业务上可能确需超支");
  assert.ok(r.data.warning, "必须回 warning，否则静默超支");
  assert.match(r.data.warning, /已超项目预算/);
});

test("合同总额未超预算时 warning 为空", async () => {
  const r = await admin("POST", "/api/contracts", {
    pid: "MP-2026-018", name: "小额合同", vendor: "某供应商", amount: 1000
  });
  assert.equal(r.status, 200);
  assert.equal(r.data.warning, "");
});

/* ---------------- 变更申请权限 ---------------- */

test("普通用户/嘉宾不能提交变更申请", async () => {
  // guest 是 MP-2026-002 的成员，能看到该项目，但没有写权限
  const r = await guest("POST", "/api/projects/MP-2026-002/change", { title: "嘉宾提的变更" });
  assert.equal(r.status, 403, JSON.stringify(r.data));
  assert.match(r.msg, /变更申请/);
});

test("协会管理员可以提交变更申请", async () => {
  const r = await assoc("POST", "/api/projects/MP-2026-001/change", { title: "议程新增圆桌环节" });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.match(r.msg, /变更申请/);
});

test("变更内容超长被拒", async () => {
  const r = await assoc("POST", "/api/projects/MP-2026-001/change", { title: "变".repeat(501) });
  assert.equal(r.status, 400);
  assert.match(r.msg, /不能超过 500 字/);
});

test("同一项目堆积待审批变更单被限流", async () => {
  // 上一条已建 1 张，再补到 3 张，第 4 张应被拒
  await assoc("POST", "/api/projects/MP-2026-001/change", { title: "变更二" });
  await assoc("POST", "/api/projects/MP-2026-001/change", { title: "变更三" });
  const r = await assoc("POST", "/api/projects/MP-2026-001/change", { title: "变更四" });
  assert.equal(r.status, 409);
  assert.equal(r.code, "TOO_MANY_PENDING");
});

/* ---------------- 预算下调 ---------------- */

test("预算不能下调到低于已占用金额", async () => {
  // MP-2026-008 预算 72000，已付款 3600
  const r = await admin("PATCH", "/api/projects/MP-2026-008", { budget: 1000 });
  assert.equal(r.status, 409, JSON.stringify(r.data));
  assert.equal(r.code, "BUDGET_BELOW_COMMITTED");
  assert.match(r.msg, /低于该项目已占用金额/);
});

test("预算上调不受限制", async () => {
  const r = await admin("PATCH", "/api/projects/MP-2026-008", { budget: 100000 });
  assert.equal(r.status, 200);
  assert.equal(Number(r.data.project.budget), 100000);
});

test("总管理员可 force 强制下调预算（纠错通道）", async () => {
  const r = await admin("PATCH", "/api/projects/MP-2026-008", { budget: 3000, force: true });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(Number(r.data.project.budget), 3000);
});

test("force 下调预算写入审计并标注强制纠错", async () => {
  const logs = (await admin("GET", "/api/projects/MP-2026-008/timeline")).data.rows;
  const hit = logs.find((l) => /资料修改/.test(l.action) && /force/.test(l.detail || ""));
  assert.ok(hit, "强制纠错必须在审计里可辨识");
  assert.match(hit.action, /强制纠错/);
});

test("预算还原（供后续付款用例使用）", async () => {
  const r = await admin("PATCH", "/api/projects/MP-2026-008", { budget: 100000 });
  assert.equal(r.status, 200);
  assert.equal(Number(r.data.project.budget), 100000);
});

/* ---------------- 付款字段与发票去重 ---------------- */

test("收款方超长被拒", async () => {
  const r = await admin("POST", "/api/payments", {
    pid: "MP-2026-008", type: "学会公付", payee: "超".repeat(61), amount: 1
  , payee_bank: "中国银行北京分行", payee_account: "3210987654321098"});
  assert.equal(r.status, 400);
  assert.match(r.msg, /收款方不能超过/);
});

test("付款说明超长被拒", async () => {
  const r = await admin("POST", "/api/payments", {
    pid: "MP-2026-008", type: "学会公付", payee: "某公司", amount: 1, remark: "说".repeat(301)
  , payee_bank: "中国银行北京分行", payee_account: "3210987654321098"});
  assert.equal(r.status, 400);
  assert.match(r.msg, /付款说明不能超过/);
});

test("同项目同收款方同发票号不可重复挂账", async () => {
  // seed 里 MP-2026-008 已有「0312 4490 / 周涛 / 3600」的已付款单
  const r = await admin("POST", "/api/payments", {
    pid: "MP-2026-008", type: "个人报销", payee: "周涛", amount: 3600, invoice_no: "0312 4490"
  , payee_bank: "中国银行北京分行", payee_account: "3210987654321098"});
  assert.equal(r.status, 409, JSON.stringify(r.data));
  assert.equal(r.code, "DUPLICATE_INVOICE");
});

test("不同收款方用同一发票号不受影响（不误伤）", async () => {
  const a = await admin("POST", "/api/payments", {
    pid: "MP-2026-008", type: "学会公付", payee: "甲公司", amount: 100, invoice_no: "TEST-INV-001"
  , payee_bank: "中国银行北京分行", payee_account: "3210987654321098"});
  const b = await admin("POST", "/api/payments", {
    pid: "MP-2026-008", type: "学会公付", payee: "乙公司", amount: 100, invoice_no: "TEST-INV-001"
  , payee_bank: "中国银行北京分行", payee_account: "3210987654321098"});
  assert.equal(a.status, 200, JSON.stringify(a.data));
  assert.equal(b.status, 200, "不同收款方各自开票，号段可能撞，不该拦");
});

test("同一收款方换发票号可以正常挂账", async () => {
  const r = await admin("POST", "/api/payments", {
    pid: "MP-2026-008", type: "个人报销", payee: "周涛", amount: 500, invoice_no: "0312 9999"
  , payee_bank: "中国银行北京分行", payee_account: "3210987654321098"});
  assert.equal(r.status, 200, JSON.stringify(r.data));
});

test("被驳回的付款不占用发票号", async () => {
  // seed 里 MP-2026-004 有一笔「已驳回」的 23800 付款，发票号 0312 4501
  // MP-2026-004 是「待核销」，不能付款，所以换个思路：先造一笔再驳回
  const mk = await admin("POST", "/api/payments", {
    pid: "MP-2026-008", type: "学会公付", payee: "丙公司", amount: 200, invoice_no: "REJ-INV-001"
  , payee_bank: "中国银行北京分行", payee_account: "3210987654321098"});
  assert.equal(mk.status, 200);
  const id = mk.data.payment.id;
  const rej = await admin("POST", `/api/payments/${id}/approve`, { approve: false });
  assert.equal(rej.status, 200, JSON.stringify(rej.data));
  const again = await admin("POST", "/api/payments", {
    pid: "MP-2026-008", type: "学会公付", payee: "丙公司", amount: 200, invoice_no: "REJ-INV-001"
  , payee_bank: "中国银行北京分行", payee_account: "3210987654321098"});
  assert.equal(again.status, 200, "驳回后重报是正常流程，不应被发票号拦住");
});

/* ---------------- 例外单阶段 ---------------- */

test("草稿项目不能提交核销例外单", async () => {
  const r = await admin("POST", "/api/projects/MP-2026-018/exceptions", { step_no: 3, reason: "草稿提例外" });
  assert.equal(r.status, 409, JSON.stringify(r.data));
  assert.equal(r.code, "ILLEGAL_STATE");
  assert.match(r.msg, /还不能提交核销例外单/);
});

test("筹备中项目不能提交核销例外单", async () => {
  const r = await admin("POST", "/api/projects/MP-2026-001/exceptions", { step_no: 3, reason: "筹备中提例外" });
  assert.equal(r.status, 409);
  assert.equal(r.code, "ILLEGAL_STATE");
});

test("待核销项目可以提交核销例外单", async () => {
  const r = await admin("POST", "/api/projects/MP-2026-003/exceptions", {
    step_no: 2, reason: "签到人数低于 85%，申请例外"
  });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.match(r.msg, /例外单 .* 已提交/);
});

test("已结算项目提交例外单返回 FROZEN", async () => {
  const r = await admin("POST", "/api/projects/MP-2026-006/exceptions", { step_no: 3, reason: "事后补例外" });
  assert.equal(r.status, 409);
  assert.equal(r.code, "FROZEN");
});

test("参数错误优先于阶段错误（步骤越界先报 400）", async () => {
  const r = await admin("POST", "/api/projects/MP-2026-018/exceptions", { step_no: 9, reason: "x" });
  assert.equal(r.status, 400, "参数本身错就该 400，不该被阶段 409 盖掉");
  assert.match(r.msg, /1~6/);
});

/* ---------------- 结算单一致性基线 ---------------- */

test("所有结算单的 income 等于对应项目预算", async () => {
  const ss = (await admin("GET", "/api/settlements")).data.rows;
  const ps = (await admin("GET", "/api/projects")).data.rows;
  const map = new Map(ps.map((p) => [p.id, p]));
  assert.ok(ss.length > 0, "种子数据应有结算单");
  for (const s of ss) {
    assert.equal(Number(s.income), Number(map.get(s.pid).budget),
      `${s.pid} 结算单 income 与项目预算不一致`);
  }
});

/* ---------------- 冻结状态：需求单与成员 ---------------- */

const ARCHIVED = "MP-2026-007";   // 已归档
const SETTLED_P = "MP-2026-006";  // 已结算
const VERIFYING = "MP-2026-003";  // 待核销（未冻结）

/** 取出需求单的扁平条目，供 PATCH 整单替换用 */
async function demandItems(c, pid) {
  const d = (await c("GET", `/api/demand/${pid}`)).data;
  return Object.entries(d.items).flatMap(([grp, arr]) => arr.map((it) => ({ ...it, grp })));
}

test("已归档项目不能修改需求单", async () => {
  const items = await demandItems(admin, ARCHIVED);
  const r = await admin("PATCH", `/api/demand/${ARCHIVED}`, { items });
  assert.equal(r.status, 409, JSON.stringify(r.data));
  assert.equal(r.code, "ARCHIVED");
});

test("已归档项目不能重置需求单（会 DELETE 全部条目）", async () => {
  const r = await admin("POST", `/api/demand/${ARCHIVED}/reset`);
  assert.equal(r.status, 409);
  assert.equal(r.code, "ARCHIVED");
});

test("已归档项目不能确认需求单", async () => {
  const r = await admin("POST", `/api/demand/${ARCHIVED}/confirm`);
  assert.equal(r.status, 409);
  assert.equal(r.code, "ARCHIVED");
});

test("已归档项目不能增删成员", async () => {
  const add = await admin("POST", `/api/projects/${ARCHIVED}/members`, { user_id: 5 });
  assert.equal(add.status, 409, JSON.stringify(add.data));
  assert.equal(add.code, "ARCHIVED");
  const del = await admin("POST", `/api/projects/${ARCHIVED}/members`, { user_id: 7, remove: true });
  assert.equal(del.status, 409, "删成员同样要拦，否则可以清空封存卷宗的可见人");
});

test("已结算项目不能修改需求单", async () => {
  const items = await demandItems(admin, SETTLED_P);
  const r = await admin("PATCH", `/api/demand/${SETTLED_P}`, { items });
  assert.equal(r.status, 409, JSON.stringify(r.data));
  assert.equal(r.code, "FROZEN");
});

test("已结算项目不能增删成员", async () => {
  const r = await admin("POST", `/api/projects/${SETTLED_P}/members`, { user_id: 5 });
  assert.equal(r.status, 409);
  assert.equal(r.code, "FROZEN");
});

test("待核销项目仍可正常维护需求单（冻结只针对结算/归档）", async () => {
  const items = await demandItems(admin, VERIFYING);
  const r = await admin("PATCH", `/api/demand/${VERIFYING}`, { items });
  assert.equal(r.status, 200, JSON.stringify(r.data));
});

test("未结算项目仍可正常调整成员", async () => {
  const r = await admin("POST", `/api/projects/${VERIFYING}/members`, { user_id: 5 });
  assert.equal(r.status, 200, JSON.stringify(r.data));
});

/* ---------------- 工作台数据范围 ---------------- */

/**
 * 工作台「已付款」曾经是个标量子查询，子查询里 JOIN 用 p2 别名、范围条件却用 p.，
 * SQLite 当成外层引用后条件恒真 —— 协会管理员看到的是全平台已付款。
 * 这里用「项目列表的分页汇总」做基准，那条路径的聚合是独立 SQL，已验证按范围过滤。
 */
async function dashPaidVsList(c) {
  const dash = (await c("GET", "/api/dashboard")).data;
  const list = (await c("GET", "/api/projects?page=1&size=1")).data.summary;
  return { dash: Number(dash.paid), list: Number(list.paid), budget: Number(dash.budget), listBudget: Number(list.budget) };
}

test("协会管理员工作台已付款只算本协会", async () => {
  const v = await dashPaidVsList(assoc);
  assert.equal(v.dash, v.list, `工作台 ¥${v.dash} 与列表汇总 ¥${v.list} 不一致`);
});

test("会务执行工作台已付款只算授权项目", async () => {
  const exec = client(await login("exec"));
  const v = await dashPaidVsList(exec);
  assert.equal(v.dash, v.list, `工作台 ¥${v.dash} 与列表汇总 ¥${v.list} 不一致`);
});

test("工作台预算与项目列表汇总一致", async () => {
  const v = await dashPaidVsList(assoc);
  assert.equal(v.budget, v.listBudget);
});

test("普通用户工作台最近动态不含范围外项目", async () => {
  const dash = (await guest("GET", "/api/dashboard")).data;
  const mine = (await guest("GET", "/api/projects")).data.rows.map((p) => p.id);
  const leaked = (dash.recent || []).filter((r) => /^MP-/.test(String(r.target || "")) && !mine.includes(r.target));
  assert.equal(leaked.length, 0, `泄漏：${leaked.map((r) => `${r.target} ${r.action}`).join("; ")}`);
});

test("工作台待办不越数据范围", async () => {
  const dash = (await guest("GET", "/api/dashboard")).data;
  const mine = (await guest("GET", "/api/projects")).data.rows.map((p) => p.id);
  const bad = (dash.todos || []).filter((t) => t.pid && !mine.includes(t.pid));
  assert.equal(bad.length, 0);
});

test("工作台状态计数与项目列表一致", async () => {
  const dash = (await assoc("GET", "/api/dashboard")).data;
  const rows = (await assoc("GET", "/api/projects")).data.rows;
  const real = {};
  for (const p of rows) real[p.status] = (real[p.status] || 0) + 1;
  for (const [st, n] of Object.entries(real)) {
    assert.equal(dash.counts[st] || 0, n, `${st} 计数不一致`);
  }
});

/* ---------------- 静默丢数据 ---------------- */

test("需求单同分组重复条目被拒，不再静默丢弃", async () => {
  const items = await demandItems(admin, VERIFYING);
  items.push({ ...items[0] });   // 原样再塞一条
  const r = await admin("PATCH", `/api/demand/${VERIFYING}`, { items });
  assert.equal(r.status, 400, "原来会静默跳过重复项、返回 200，审计却写「更新 N 条」");
  assert.equal(r.code, "DUPLICATE_ITEM");
  assert.match(r.msg, /重复条目/);
});

test("条目名首尾空格视为同一条", async () => {
  const items = await demandItems(admin, VERIFYING);
  const first = items[0];
  items.push({ ...first, item: `${first.item} ` });
  const r = await admin("PATCH", `/api/demand/${VERIFYING}`, { items });
  assert.equal(r.status, 400, "「台卡」与「台卡 」视觉相同，不该存成两条");
  assert.equal(r.code, "DUPLICATE_ITEM");
});

test("用户姓名超长被拒", async () => {
  const r = await admin("POST", "/api/users", { username: "lencheck1", name: "名".repeat(31), role: "user" });
  assert.equal(r.status, 400);
  assert.match(r.msg, /姓名不能超过/);
});

test("用户部门超长被拒", async () => {
  const r = await admin("POST", "/api/users", { username: "lencheck2", name: "测试", role: "user", dept: "部".repeat(41) });
  assert.equal(r.status, 400);
  assert.match(r.msg, /部门不能超过/);
});

test("修改用户资料同样受长度限制", async () => {
  const users = (await admin("GET", "/api/users")).data.rows;
  const target = users.find((u) => u.username === "exec");
  const r = await admin("PATCH", `/api/users/${target.id}`, { phone: "1".repeat(21) });
  assert.equal(r.status, 400);
  assert.match(r.msg, /联系电话不能超过/);
});
