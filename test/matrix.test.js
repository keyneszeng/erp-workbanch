"use strict";
/**
 * 角色 × 接口矩阵 + 并发 + 其余状态机分支
 */
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const PORT = 8801;
const BASE = `http://127.0.0.1:${PORT}`;
const DB = path.join(__dirname, "..", "data", "matrix.db");
let proc;

const cleanDb = () => { for (const f of [DB, DB + "-wal", DB + "-shm"]) if (fs.existsSync(f)) fs.renameSync(f, f + ".old"); };

async function waitHealth(t = 40000) {
  const t0 = Date.now();
  while (Date.now() - t0 < t) {
    try { if ((await fetch(`${BASE}/api/health`)).ok) return; } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("服务启动超时");
}

async function login(u, p = "123456") {
  const r = await fetch(`${BASE}/api/auth/login`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: u, password: p })
  });
  assert.equal(r.status, 200, `${u} 登录失败`);
  return (r.headers.get("set-cookie") || "").split(";")[0];
}

const client = (cookie) => async (method, url, body) => {
  const r = await fetch(BASE + url, {
    method, headers: { "Content-Type": "application/json", cookie },
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await r.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  return { status: r.status, data };
};

const ROLES = ["admin", "assoc", "exec", "finance", "guest"];
const GETS = [
  "/api/dashboard", "/api/projects", "/api/approvals", "/api/payments", "/api/contracts",
  "/api/materials", "/api/settlements", "/api/audit", "/api/users", "/api/auth/me", "/api/meta"
];
const apis = {};

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
  for (const r of ROLES) apis[r] = client(await login(r));
});

after(() => proc && proc.kill("SIGTERM"));

test("矩阵：五个角色 × 11 个 GET 接口均不 500", async () => {
  const bad = [];
  for (const role of ROLES) {
    for (const url of GETS) {
      const r = await apis[role]("GET", url);
      if (r.status >= 500) bad.push(`${role} ${url} → ${r.status} ${JSON.stringify(r.data).slice(0, 120)}`);
      assert.ok([200, 403, 404].includes(r.status), `${role} ${url} 返回异常状态 ${r.status}`);
    }
  }
  assert.deepEqual(bad, [], "不应有 500：" + bad.join(" | "));
});

test("矩阵：每个角色的看板数据结构完整", async () => {
  for (const role of ROLES) {
    const r = await apis[role]("GET", "/api/dashboard");
    assert.equal(r.status, 200);
    for (const k of ["counts", "todos", "upcoming", "alerts", "recent", "budget", "paid"]) {
      assert.ok(k in r.data, `${role} 看板缺字段 ${k}`);
    }
  }
});

test("并发：同时创建 5 笔付款单，单号不重复", async () => {
  const reqs = Array.from({ length: 5 }, (_, i) =>
    apis.finance("POST", "/api/payments", {
      pid: "MP-2026-017", type: "学会公付", payee: `并发测试${i}`, amount: 100 + i
    , payee_bank: "中国银行北京分行", payee_account: "3210987654321098"})
  );
  const rs = await Promise.all(reqs);
  const ok = rs.filter((r) => r.status === 200);
  assert.equal(ok.length, 5, "5 笔并发付款都应成功：" + JSON.stringify(rs.map((r) => r.status)));
  const ids = ok.map((r) => r.data.payment.id);
  assert.equal(new Set(ids).size, 5, "单号不应重复：" + ids.join(","));
});

test("变更申请：提交后进入审批，可通过", async () => {
  const c = await apis.assoc("POST", "/api/projects/MP-2026-001/change", { title: "新增圆桌环节" });
  assert.equal(c.status, 200);
  const list = await apis.assoc("GET", "/api/approvals?type=" + encodeURIComponent("变更审批"));
  const ap = list.data.rows.find((x) => x.pid === "MP-2026-001" && x.status === "待审批");
  assert.ok(ap, "应生成变更审批单");
  const d = await apis.assoc("POST", `/api/approvals/${ap.id}/decide`, { approve: true, comment: "同意" });
  assert.equal(d.status, 200);
});

test("非法枚举：修改会议形式为未知值被拒", async () => {
  const r = await apis.admin("PATCH", "/api/projects/MP-2026-009", { form: "全息投影" });
  assert.equal(r.status, 400);
});

test("归档项目：协会管理员改资料被拒，总管理员可改", async () => {
  const a = await apis.assoc("PATCH", "/api/projects/MP-2026-015", { people: 500 });
  assert.equal(a.status, 409);
  const b = await apis.admin("PATCH", "/api/projects/MP-2026-015", { people: 500 });
  assert.equal(b.status, 200);
  assert.equal(b.data.project.people, 500);
});

test("材料类别：自定义可登记但不顶替必备 8 类，空/超长被拒", async () => {
  // V1.2.13 起不再要求必须是 8 类之一 —— 会议纪要、专家简历这类东西以前只能
  // 硬塞进 8 类凑数，反而让「齐备」不可信。自定义类别能登记，但不算必备那 8 类。
  const before = (await apis.admin("GET", "/api/projects/MP-2026-001")).data.materialsStatus.missing.length;
  const ok = await apis.assoc("POST", "/api/projects/MP-2026-001/materials", { kind: "会议纪要", name: "自定义类别.pdf" });
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  assert.equal(ok.data.materialsStatus.missing.length, before, "自定义类别不应减少必备 8 类的缺口");

  const blank = await apis.assoc("POST", "/api/projects/MP-2026-001/materials", { kind: "   ", name: "x.pdf" });
  assert.equal(blank.status, 400, "空类别应被拒");
  const tooLong = await apis.assoc("POST", "/api/projects/MP-2026-001/materials", { kind: "长".repeat(21), name: "x.pdf" });
  assert.equal(tooLong.status, 400, "类别超过 20 字应被拒");
});

test("例外单步骤号越界被拒", async () => {
  const r = await apis.assoc("POST", "/api/projects/MP-2026-001/exceptions", { step_no: 9, reason: "x" });
  assert.equal(r.status, 400);
});

test("例外单自定义步骤：写了事项才收，空事项被拒", async () => {
  // step_no = 0 是「不属于 6 步中任何一步」，必须自带一个事项名，
  // 否则审批人看到「第 0 步」根本不知道要批什么
  const noLabel = await apis.assoc("POST", "/api/projects/MP-2026-001/exceptions", { step_no: 0, reason: "专家临时换人" });
  assert.equal(noLabel.status, 400, "自定义步骤不写事项应被拒");
  const blank = await apis.assoc("POST", "/api/projects/MP-2026-001/exceptions", { step_no: 0, step_label: "   ", reason: "专家临时换人" });
  assert.equal(blank.status, 400, "事项全是空格也应被拒");
});

test("合同类别：未填按名称推断，非法值被拒", async () => {
  const auto = await apis.assoc("POST", "/api/contracts", {
    pid: "MP-2026-001", name: "专家劳务协议补充", vendor: "某医学会", amount: 12000, status: "草稿"
  });
  assert.equal(auto.status, 200, JSON.stringify(auto.data));
  assert.equal(auto.data.contract.category, "劳务专家", "「劳务」字样应推断为劳务专家");

  const auto2 = await apis.assoc("POST", "/api/contracts", {
    pid: "MP-2026-001", name: "直播平台与摄像服务", vendor: "某设备商", amount: 8000, status: "草稿"
  });
  assert.equal(auto2.data.contract.category, "设备技术");

  const badCat = await apis.assoc("POST", "/api/contracts", {
    pid: "MP-2026-001", name: "x", vendor: "y", amount: 100, status: "草稿", category: "随便写"
  });
  assert.equal(badCat.status, 400, "不在类别表里的值应被拒");
});

test("未知流转动作返回 ILLEGAL_TRANSITION", async () => {
  const r = await apis.admin("POST", "/api/projects/MP-2026-001/transition", { action: "teleport" });
  assert.equal(r.status, 409);
  assert.equal(r.data.error.code, "ILLEGAL_TRANSITION");
  assert.ok(Array.isArray(r.data.error.detail.allowed), "应返回可执行动作列表");
});

test("导出核销明细：表头含 6 步列", async () => {
  const r = await fetch(`${BASE}/api/export/verify`, { headers: { cookie: await login("finance") } });
  assert.equal(r.status, 200);
  const text = Buffer.from(await r.arrayBuffer()).toString("utf8");
  for (const h of ["1.议程与课件核对", "4.课件与议程课题一致性", "6.发票与合同金额核对", "例外单", "结算单"]) {
    assert.ok(text.includes(h), `导出应包含列「${h}」`);
  }
});

test("导出：普通用户被拒，审计角色可导审计", async () => {
  const g = await apis.guest("GET", "/api/export/payments");
  assert.equal(g.status, 403);
  const a = await apis.assoc("GET", "/api/export/audit");
  assert.equal(a.status, 200);
});
