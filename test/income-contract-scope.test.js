"use strict";
/**
 * 收入类（赞助）合同的范围边界回归。
 * 运行：node --experimental-sqlite --test test/income-contract-scope.test.js
 *
 * 老板 2026-11-02：「收入类（赞助类）合同不关联到材料和核销」。
 *
 * 赞助合同是钱进来，不是钱出去。以前台账里没有这个类别，只能选「其他」，
 * 于是它被当成支出合同：算进核销第 6 步的「合同总额」、自动生成一条归档「合同」材料、
 * 还会出现在付款申请的收款方候选里 —— 财务看着一份 15000 的赞助，以为要付 15000 出去。
 *
 * 本文件锁死四条边界：
 *   1) 不计入核销第 6 步的合同总额（支出合同总额不变）
 *   2) 不同步成归档「合同」类材料（归档齐备度不被赞助顶替）
 *   3) 不出现在付款收款方候选里
 *   4) 台账编辑能把存量合同改成「赞助收入」，并撤下当初同步的材料
 */
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const PORT = 8834;
const BASE = `http://127.0.0.1:${PORT}`;
const DB = path.join(__dirname, "..", "data", "test-income-scope.db");
const UP = path.join(__dirname, "..", "data", "test-income-scope-uploads");
let proc;
let admin, assoc, exec, finance;
let seq = 0;

function clean() {
  for (const f of [DB, DB + "-wal", DB + "-shm"]) if (fs.existsSync(f)) fs.renameSync(f, f + ".bak");
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

/** 建一个 exec / assoc 都看得见的「已立项」项目 */
async function freshProject() {
  const c = client(exec);
  const r = await c("POST", "/api/projects", {
    name: `收入类合同边界 ${Date.now()}-${++seq}`,
    assoc: "华东医学会", form: "线下", date: "2027-08-01",
    budget: 200000, people: 60, owner: "陈静", agenda: "09:00 开幕致辞 / 13:30 分论坛"
  });
  assert.equal(r.status, 200, `建项目失败：${JSON.stringify(r.data)}`);
  const pid = r.data.project.id;
  assert.equal((await c("POST", `/api/projects/${pid}/transition`, { action: "submit" })).status, 200);
  assert.equal((await client(assoc)("POST", `/api/projects/${pid}/transition`, { action: "approve" })).status, 200);
  return pid;
}

/** 直接录一份「已签署」合同（演示模式不做签署审批，状态原样落库） */
async function signedContract(pid, extra = {}) {
  const r = await client(exec)("POST", "/api/contracts", {
    pid, name: `边界合同 ${Date.now()}-${++seq}`, vendor: "测试供应商",
    amount: 10000, status: "已签署", sign_date: "2026-10-01", ...extra
  });
  assert.equal(r.status, 200, `录入合同失败：${JSON.stringify(r.data)}`);
  return r.data.contract;
}

/** 上传一个极小 PDF 当合同原件，拿到 file_key */
async function uploadTinyPdf(pid) {
  const pdf = Buffer.from(
    "%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n" +
    "3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n",
    "latin1"
  );
  const r = await fetch(`${BASE}/api/uploads?pid=${encodeURIComponent(pid)}`, {
    method: "POST",
    headers: { "Content-Type": "application/pdf", "x-file-name": encodeURIComponent("赞助协议.pdf"), cookie: exec },
    body: pdf
  });
  const j = await r.json();
  assert.equal(r.status, 200, `上传失败：${JSON.stringify(j)}`);
  return j;
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

test("合同类别里必须有「赞助收入」，否则收入类合同无处归类", async () => {
  const meta = (await client(admin)("GET", "/api/meta")).data;
  assert.ok((meta.contractCategories || []).includes("赞助收入"), JSON.stringify(meta.contractCategories));
});

test("收入类合同不生成归档「合同」材料；支出合同照旧生成", async () => {
  const pid = await freshProject();
  const up = await uploadTinyPdf(pid);

  const income = await signedContract(pid, {
    name: "企业赞助协议", vendor: "某某药企", amount: 15000, category: "赞助收入",
    file_key: up.key, file_name: up.name, file_size: up.size, file_mime: up.mime
  });
  assert.equal(income.category, "赞助收入");

  const up2 = await uploadTinyPdf(pid);
  const spend = await signedContract(pid, {
    name: "会场租赁合同", vendor: "会展中心", amount: 8000, category: "场地餐饮",
    file_key: up2.key, file_name: up2.name, file_size: up2.size, file_mime: up2.mime
  });

  const mats = (await client(admin)("GET", "/api/materials")).data.rows.filter((m) => m.pid === pid && m.kind === "合同");
  const names = mats.map((m) => m.name);
  assert.equal(names.some((n) => n.includes(income.id)), false, "赞助合同不应出现在归档「合同」类：" + JSON.stringify(names));
  assert.equal(names.some((n) => n.includes(spend.id)), true, "支出合同必须照旧同步进归档「合同」类：" + JSON.stringify(names));
});

test("收入类合同不进项目台账的支出合计（核销口径与台账同源）", async () => {
  const pid = await freshProject();
  await signedContract(pid, { name: "企业赞助协议", vendor: "某某药企", amount: 15000, category: "赞助收入" });
  await signedContract(pid, { name: "会场租赁合同", vendor: "会展中心", amount: 8000, category: "场地餐饮" });

  const d = (await client(admin)("GET", `/api/project-ledger/${pid}`)).data;
  const sums = d.financial_summary;
  assert.equal(Number(sums.contract_total), 8000, "台账合同总额只能是支出合同的 8000：" + JSON.stringify(sums));
  assert.equal(Number(sums.income_contract_total), 15000, "收入类合同要单列：" + JSON.stringify(sums));
  assert.equal(Number(sums.income_contracts), 1);
});

test("收入类合同不出现在付款收款方候选里", async () => {
  const pid = await freshProject();
  await signedContract(pid, { name: "企业赞助协议", vendor: "某某药企", amount: 15000, category: "赞助收入" });
  await signedContract(pid, { name: "会场租赁合同", vendor: "会展中心", amount: 8000, category: "场地餐饮" });

  const r = (await client(finance)("GET", `/api/projects/${pid}/payee-options`)).data;
  const rows = r.rows || [];
  assert.ok(rows.some((x) => x.payee === "会展中心"), "支出合同应可选：" + JSON.stringify(rows));
  assert.equal(rows.some((x) => x.payee === "某某药企"), false, "赞助企业不该出现在付款候选里：" + JSON.stringify(rows));
});

test("台账编辑：把存量合同改成「赞助收入」后，撤下同步材料并退出核销口径", async () => {
  const pid = await freshProject();
  const up = await uploadTinyPdf(pid);
  const c = await signedContract(pid, {
    name: "误记为支出的赞助协议", vendor: "某某药企", amount: 15000, category: "其他",
    file_key: up.key, file_name: up.name, file_size: up.size, file_mime: up.mime
  });

  const beforeMats = (await client(admin)("GET", "/api/materials")).data.rows
    .filter((m) => m.pid === pid && m.kind === "合同" && m.name.includes(c.id));
  assert.equal(beforeMats.length, 1, "改之前，支出合同应已同步成归档材料");

  const r = await client(assoc)("PATCH", `/api/contracts/${c.id}`, { category: "赞助收入" });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.contract.category, "赞助收入");
  assert.match(String(r.data.message || ""), /撤下/, "应提示已撤下同步材料：" + r.data.message);

  const afterMats = (await client(admin)("GET", "/api/materials")).data.rows
    .filter((m) => m.pid === pid && m.kind === "合同" && m.name.includes(c.id));
  assert.equal(afterMats.length, 0, "改成收入类后，归档「合同」类里的这条必须消失");

  // 再改回支出类，原件应重新登记进归档材料
  const back = await client(assoc)("PATCH", `/api/contracts/${c.id}`, { category: "场地餐饮" });
  assert.equal(back.status, 200, JSON.stringify(back.data));
  const restored = (await client(admin)("GET", "/api/materials")).data.rows
    .filter((m) => m.pid === pid && m.kind === "合同" && m.name.includes(c.id));
  assert.equal(restored.length, 1, "改回支出类后，原件应重新登记为归档「合同」材料");
});

test("合同台账编辑不能越权改别协会的合同", async () => {
  // 用总管理员建一个肿瘤分会的项目：exec 的授权范围是华东医学会，看不到它
  const other = await client(admin)("POST", "/api/projects", {
    name: `外协会项目 ${Date.now()}-${++seq}`, assoc: "肿瘤分会", form: "线下",
    date: "2027-09-01", budget: 50000, people: 20, owner: "孙倩", agenda: "09:00 开场"
  });
  assert.equal(other.status, 200, JSON.stringify(other.data));
  const otherPid = other.data.project.id;
  const otherC = await client(admin)("POST", "/api/contracts", {
    pid: otherPid, name: "外协会合同", vendor: "别家", amount: 5000, status: "已签署", sign_date: "2026-10-01"
  });
  assert.equal(otherC.status, 200, JSON.stringify(otherC.data));

  const blocked = await client(exec)("PATCH", `/api/contracts/${otherC.data.contract.id}`, { category: "赞助收入" });
  assert.ok([403, 404].includes(blocked.status), `应被数据范围拦住，实际 ${blocked.status} ${JSON.stringify(blocked.data)}`);
  const still = (await client(admin)("GET", "/api/contracts")).data.rows.find((x) => x.id === otherC.data.contract.id);
  assert.equal(still.category, "其他", "被拦下后类别不能变");
});
