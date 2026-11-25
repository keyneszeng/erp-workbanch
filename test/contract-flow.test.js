"use strict";
/**
 * 合同两步流转回归：草稿 → 待签署 → 已签署
 * 运行：node --experimental-sqlite --test test/contract-flow.test.js
 *
 * 老板 2026-10-27 拍板：合同状态要「提交签署 → 确认签署」两步。
 * 原来状态只在录入时选一次，之后永远改不了，台账上的「已签署金额」只能靠人记。
 *
 * 两步分权（谁提交、谁确认，审计里分得清）：
 *   提交签署 contract:write   → 协会管理员 / 会务执行
 *   确认签署 contract:approve → 协会管理员（代表协会落章）
 */
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const PORT = 8816;
const BASE = `http://127.0.0.1:${PORT}`;
const DB = path.join(__dirname, "..", "data", "test22.db");
const UP = path.join(__dirname, "..", "data", "test22-uploads");
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

/** 建一个 exec 与 assoc 都看得见的「已立项」项目（合同录入不受状态限制，除已结算/已归档） */
async function freshProject() {
  const c = client(exec);
  const r = await c("POST", "/api/projects", {
    name: `合同流转用例项目 ${Date.now()}-${++seq}`,
    assoc: "华东医学会", form: "线下", date: "2027-07-01",
    tax_fee_rate:0, budget: 200000, people: 80, owner: "陈静", agenda: "09:00 开幕致辞 / 13:30 分论坛"
  });
  assert.equal(r.status, 200, `建项目失败：${JSON.stringify(r.data)}`);
  const pid = r.data.project.id;
  const s1 = await c("POST", `/api/projects/${pid}/transition`, { action: "submit" });
  assert.equal(s1.status, 200, `提交立项失败：${JSON.stringify(s1.data)}`);
  const s2 = await client(assoc)("POST", `/api/projects/${pid}/transition`, { action: "approve" });
  assert.equal(s2.status, 200, `审批立项失败：${JSON.stringify(s2.data)}`);
  return pid;
}

/** 录一份草稿合同，返回合同号 */
async function draftContract(pid, extra = {}) {
  const r = await client(exec)("POST", "/api/contracts", {
    pid, name: `测试合同 ${Date.now()}-${++seq}`, vendor: "测试供应商",
    amount: 30000, status: "草稿", ...extra
  });
  assert.equal(r.status, 200, `录入合同失败：${JSON.stringify(r.data)}`);
  return r.data.contract.id;
}

function todayStr() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
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

test("草稿 → 提交签署 → 确认签署：两步走完才算签了", async () => {
  const pid = await freshProject();
  const cid = await draftContract(pid);

  // 第 1 步：exec 提交签署
  const s1 = await client(exec)("POST", `/api/contracts/${cid}/transition`, { action: "submit" });
  assert.equal(s1.status, 200, JSON.stringify(s1.data));
  assert.equal(s1.data.contract.status, "待签署");
  assert.equal(s1.data.contract.sign_date, "", "提交签署不该写签署日期");

  // 第 2 步：assoc 确认签署，日期默认今天
  const s2 = await client(assoc)("POST", `/api/contracts/${cid}/transition`, { action: "sign" });
  assert.equal(s2.status, 200, JSON.stringify(s2.data));
  assert.equal(s2.data.contract.status, "已签署");
  assert.equal(s2.data.contract.sign_date, todayStr(), "确认签署应默认写今天");

  // 审计：两步各留一条，detail 写明状态变化
  const audit = await client(admin)("GET", `/api/audit?q=${encodeURIComponent(pid)}`);
  const submitLog = audit.data.rows.find((a) => a.action === "提交签署" && a.detail.includes(cid));
  const signLog = audit.data.rows.find((a) => a.action === "确认签署" && a.detail.includes(cid));
  assert.ok(submitLog, "应有「提交签署」审计");
  assert.ok(signLog, "应有「确认签署」审计");
  assert.match(submitLog.detail, /草稿 → 待签署/);
  assert.match(signLog.detail, /待签署 → 已签署/);
});

test("确认签署可指定签署日期", async () => {
  const pid = await freshProject();
  const cid = await draftContract(pid);
  await client(exec)("POST", `/api/contracts/${cid}/transition`, { action: "submit" });
  const r = await client(assoc)("POST", `/api/contracts/${cid}/transition`, { action: "sign", sign_date: "2026-10-01" });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.contract.sign_date, "2026-10-01");
});

test("草稿不能直接确认签署（跳步）", async () => {
  const pid = await freshProject();
  const cid = await draftContract(pid);
  const r = await client(assoc)("POST", `/api/contracts/${cid}/transition`, { action: "sign" });
  assert.equal(r.status, 409, JSON.stringify(r.data));
  assert.equal(r.data.error.code, "ILLEGAL_TRANSITION");
  assert.deepEqual(r.data.error.detail.allowed, ["submit"]);
  assert.equal(r.data.error.detail.status, "草稿");
});

test("执行不能确认签署（只有协会管理员能落章）", async () => {
  const pid = await freshProject();
  const cid = await draftContract(pid);
  await client(exec)("POST", `/api/contracts/${cid}/transition`, { action: "submit" });
  const r = await client(exec)("POST", `/api/contracts/${cid}/transition`, { action: "sign" });
  assert.equal(r.status, 403, JSON.stringify(r.data));
  assert.match(r.data.error.message, /协会管理员/);

  // 状态没被改掉
  const list = await client(assoc)("GET", `/api/contracts?pid=${pid}`);
  assert.equal(list.data.rows.find((c) => c.id === cid).status, "待签署");
});

test("已签署是终态，不能再流转", async () => {
  const pid = await freshProject();
  const cid = await draftContract(pid);
  await client(exec)("POST", `/api/contracts/${cid}/transition`, { action: "submit" });
  await client(assoc)("POST", `/api/contracts/${cid}/transition`, { action: "sign" });
  const r = await client(assoc)("POST", `/api/contracts/${cid}/transition`, { action: "submit" });
  assert.equal(r.status, 409, JSON.stringify(r.data));
  assert.equal(r.data.error.code, "ILLEGAL_TRANSITION");
  assert.deepEqual(r.data.error.detail.allowed, []);
  assert.match(r.data.error.message, /没有可继续的流转/);
});

test("录入「已签署」必须带签署日期", async () => {
  const pid = await freshProject();
  const r = await client(exec)("POST", "/api/contracts", {
    pid, name: "补录合同无日期", vendor: "测试供应商", amount: 10000, status: "已签署"
  });
  assert.equal(r.status, 400, JSON.stringify(r.data));
  assert.match(r.data.error.message, /必须填写签署日期/);

  // 带上日期就放行（历史合同补录场景）
  const ok = await client(exec)("POST", "/api/contracts", {
    pid, name: "补录合同带日期", vendor: "测试供应商", amount: 10000, status: "已签署", sign_date: "2026-09-01"
  });
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  assert.equal(ok.data.contract.status, "已签署");
});

test("已结算项目的合同不可再流转（账目封存）", async () => {
  // MP-2026-006 已结算，HT-2026-006 是它的合同；finance 是项目成员，看得见
  const r = await client(finance)("POST", "/api/contracts/HT-2026-006/transition", { action: "submit" });
  assert.equal(r.status, 409, JSON.stringify(r.data));
  assert.equal(r.data.error.code, "FROZEN");
  assert.equal(r.data.error.detail.status, "已结算");
});

test("不存在的合同 → 404，未知动作 → 409", async () => {
  const nf = await client(admin)("POST", "/api/contracts/HT-9999-999/transition", { action: "submit" });
  assert.equal(nf.status, 404, JSON.stringify(nf.data));

  const pid = await freshProject();
  const cid = await draftContract(pid);
  const bad = await client(exec)("POST", `/api/contracts/${cid}/transition`, { action: "archive" });
  assert.equal(bad.status, 409, JSON.stringify(bad.data));
  assert.equal(bad.data.error.code, "ILLEGAL_TRANSITION");
});

test("合同台账企业赞助自动编号并关联会议收入；签署只算收入不计支出",async()=>{
 const pid=await freshProject();
 const pdf=Buffer.from("%PDF-1.4\n1 0 obj\n<<>>\nendobj\n%%EOF");
 const up=await fetch(BASE+"/api/uploads?pid="+pid,{
   method:"POST",headers:{Cookie:exec,"Content-Type":"application/octet-stream","X-File-Name":"sponsor.pdf"},body:pdf
 });
 const upload=await up.json();assert.equal(up.status,200,JSON.stringify(upload));
 const created=await client(exec)("POST","/api/contracts",{
   pid,name:"企业赞助合作协议",vendor:"深圳市睿康医疗科技有限公司",
   category:"企业赞助",amount:50000,status:"待签署",
   file_key:upload.key,file_name:"sponsor.pdf",rightsCategories:["主会场背景板LOGO露出"]
 });
 assert.equal(created.status,200,JSON.stringify(created.data));
 const id=created.data.contract.id;
 assert.match(id,/^HT-\d{4}-\d{3,}$/);
 assert.ok(created.data.sponsorId);
 const inc0=await client(admin)("GET","/api/projects/"+pid+"/income");
 assert.equal(inc0.status,200,JSON.stringify(inc0.data));
 const sponsor=inc0.data.contracts.find(x=>x.ledger_contract_id===id);
 assert.equal(sponsor?.contract_no,id);
 assert.equal(sponsor?.enterprise,"深圳市睿康医疗科技有限公司");
 assert.equal(inc0.data.summary.contracted,0);
 const a=await client(assoc)("GET","/api/approvals?type=合同审批");
 assert.equal(a.status,200,JSON.stringify(a.data));
 const approval=a.data.rows.find(x=>x.ref_id===id);
 if(approval){
   const decision=await client(assoc)("POST","/api/approvals/"+approval.id+"/decide",{approve:true});
   assert.equal(decision.status,200,JSON.stringify(decision.data));
 }else{
   // npm test 以演示模式启动；演示模式的签署流转不创建审批单。
   const signed=await client(assoc)("POST","/api/contracts/"+id+"/transition",{action:"sign"});
   assert.equal(signed.status,200,JSON.stringify(signed.data));
 }
 const inc1=await client(admin)("GET","/api/projects/"+pid+"/income");
 assert.equal(inc1.data.summary.contracted,50000,"赞助签署后进入会议收入");
 assert.equal(inc1.data.contracts.find(x=>x.id===sponsor.id).status,"已签署");
 const list=await client(admin)("GET","/api/contracts?pid="+pid);
 assert.equal(list.data.rows.find(x=>x.id===id).status,"已签署");
 const payees=await client(finance)("GET","/api/projects/"+pid+"/payee-options");
 assert.equal(payees.status,200,JSON.stringify(payees.data));
 assert.ok(!payees.data.rows.some(x=>x.payee==="深圳市睿康医疗科技有限公司"),
   "赞助收入方不可进入财务付款候选");
});

test("合同台账修改类别：草稿允许选择，非法类别和越权拒绝，并保留合同号",async()=>{
 const pid=await freshProject(),id=await draftContract(pid,{category:"会务需求"});
 const url="/api/contracts/"+id+"/category";
 assert.equal((await client(finance)("PATCH",url,{category:"劳务专家"})).status,403);
 assert.equal((await client(exec)("PATCH",url,{category:"自定义非法类别"})).status,400);
 const changed=await client(exec)("PATCH",url,{
  category:"劳务专家",expected_category:"会务需求",expected_status:"草稿"
 });
 assert.equal(changed.status,200,JSON.stringify(changed.data));
 assert.equal(changed.data.contract.id,id);
 assert.equal(changed.data.contract.category,"劳务专家");
 assert.equal(changed.data.contract.status,"草稿");
 assert.equal((await client(exec)("PATCH",url,{category:"企业赞助"})).status,400,
  "企业赞助类别必须有原件");
 assert.equal((await client(exec)("PATCH",url,{category:"会务需求",expected_category:"会务需求"})).status,409,
  "过期页面不得覆盖新分类");
 const audit=await client(admin)("GET","/api/audit?q="+encodeURIComponent(pid));
 assert.ok(audit.data.rows.some(x=>x.action==="修改合同类别"&&x.detail.includes(id)),
  "合同类别改变必须写入审计");
});

test("待签署或已签署合同可以受控改类别，旧签署审批撤销并重新提交",async()=>{
 const pid=await freshProject(),id=await draftContract(pid,{category:"会务需求"});
 const url="/api/contracts/"+id+"/category";
 assert.equal((await client(exec)("POST","/api/contracts/"+id+"/transition",{action:"submit"})).status,200);
 const changed=await client(exec)("PATCH",url,{
  category:"劳务专家",expected_category:"会务需求",expected_status:"待签署"
 });
 assert.equal(changed.status,200,JSON.stringify(changed.data));
 assert.equal(changed.data.contract.status,"草稿");
 const approvals=await client(admin)("GET","/api/approvals?type="+encodeURIComponent("合同审批"));
 assert.ok(!approvals.data.rows.some(x=>x.ref_id===id&&x.status==="待审批"),
  "类别修改应撤销原待签署审批");
 assert.equal((await client(exec)("POST","/api/contracts/"+id+"/transition",{action:"submit"})).status,200);
 assert.equal((await client(assoc)("POST","/api/contracts/"+id+"/transition",{action:"sign"})).status,200);
 const denied=await client(exec)("PATCH",url,{category:"会务需求"});
 assert.equal(denied.status,403,"已签署合同只能由协会审批人员重分类");
 const signedChange=await client(assoc)("PATCH",url,{
  category:"会务需求",expected_category:"劳务专家",expected_status:"已签署"
 });
 assert.equal(signedChange.status,200,JSON.stringify(signedChange.data));
 assert.equal(signedChange.data.contract.status,"草稿");
 assert.equal(signedChange.data.contract.sign_date,"");
 assert.deepEqual(signedChange.data.reverifySteps,[5,6]);
});

test("会务协议与企业赞助合同改类须同步建立/撤销会议收入关联",async()=>{
 const pid=await freshProject();
 const pdf=Buffer.from("%PDF-1.4\n1 0 obj\n<<>>\nendobj\n%%EOF");
 const upload=await fetch(BASE+"/api/uploads?pid="+pid,{
  method:"POST",headers:{Cookie:exec,"Content-Type":"application/octet-stream","X-File-Name":encodeURIComponent("分类更正合同.pdf")},body:pdf
 });
 const file=await upload.json();
 assert.equal(upload.status,200,JSON.stringify(file));
 const id=await draftContract(pid,{category:"会务需求",file_key:file.key,file_name:file.name,
  file_size:file.size,file_mime:file.mime});
 const change=await client(exec)("PATCH","/api/contracts/"+id+"/category",{
  category:"企业赞助",expected_category:"会务需求"
 });
 assert.equal(change.status,200,JSON.stringify(change.data));
 assert.ok(change.data.sponsorId,"必须同步建立企业赞助收入关联");
 const income=await client(admin)("GET","/api/projects/"+pid+"/income");
 assert.ok(income.data.contracts.some(x=>x.id===change.data.sponsorId&&x.ledger_contract_id===id));
 const back=await client(exec)("PATCH","/api/contracts/"+id+"/category",{
  category:"劳务专家",expected_category:"企业赞助"
 });
 assert.equal(back.status,200,JSON.stringify(back.data));
 const after=await client(admin)("GET","/api/projects/"+pid+"/income");
 assert.ok(!after.data.contracts.some(x=>x.ledger_contract_id===id),
  "撤销空白赞助关联后不能继续算作会议收入");
 const list=await client(admin)("GET","/api/contracts?pid="+pid);
 assert.equal(list.data.rows.find(x=>x.id===id).category,"劳务专家");
 assert.equal(list.data.rows.find(x=>x.id===id).file_key,file.key,
  "只改合同类别不能误删或替换原件");
});

test("已有赞助权益确认的合同不得直接变更类别",async()=>{
 const pid=await freshProject();
 const pdf=Buffer.from("%PDF-1.4\n1 0 obj\n<<>>\nendobj\n%%EOF");
 const upload=await fetch(BASE+"/api/uploads?pid="+pid,{
  method:"POST",headers:{Cookie:exec,"Content-Type":"application/octet-stream","X-File-Name":encodeURIComponent("权益类合同.pdf")},body:pdf
 });
 const file=await upload.json();
 assert.equal(upload.status,200,JSON.stringify(file));
 const id=await draftContract(pid,{category:"企业赞助",file_key:file.key,file_name:file.name,
  file_size:file.size,file_mime:file.mime,rightsCategories:["背景板LOGO"]});
 const income=(await client(admin)("GET","/api/projects/"+pid+"/income")).data;
 const sponsor=income.contracts.find(x=>x.ledger_contract_id===id);
 assert.ok(sponsor);
 const confirm=await client(exec)("PATCH","/api/projects/"+pid+"/income/contracts/"+sponsor.id+"/rights",{
  categories:["背景板LOGO"]
 });
 assert.equal(confirm.status,200,JSON.stringify(confirm.data));
 const denied=await client(exec)("PATCH","/api/contracts/"+id+"/category",{category:"会务需求"});
 assert.equal(denied.status,409,JSON.stringify(denied.data));
 assert.equal(denied.data.error.code,"SPONSOR_RECONCILIATION_REQUIRED");
 const still=(await client(admin)("GET","/api/contracts?pid="+pid)).data.rows.find(x=>x.id===id);
 assert.equal(still.category,"企业赞助");
});

test("协会管理员可本人录入、提交、确认签署；总管理员同样可自签",async()=>{
 const pid=await freshProject();
 // 前序安全测试会主动撤销登录态；测试独立重新签入，避免共用旧cookie。
 const fresh={assoc:await login("assoc"),admin:await login("admin")};
 for(const [role,label] of [["assoc","协会管理员"],["admin","总管理员"]]){
  const created=await client(fresh[role])("POST","/api/contracts",{
   pid,name:label+"自签合同",vendor:"会务供应商",amount:2468,category:"会务需求",status:"草稿"
  });
  assert.equal(created.status,200,label+"录入合同："+JSON.stringify(created.data));
  const id=created.data.contract.id;
  const submit=await client(fresh[role])("POST","/api/contracts/"+id+"/transition",{action:"submit"});
  assert.equal(submit.status,200,label+"提交签署："+JSON.stringify(submit.data));
  const sign=await client(fresh[role])("POST","/api/contracts/"+id+"/transition",{action:"sign"});
  assert.equal(sign.status,200,label+"自签："+JSON.stringify(sign.data));
  assert.equal(sign.data.contract.status,"已签署");
  const list=await client(admin)("GET","/api/contracts?pid="+pid);
  assert.equal(list.data.rows.find(x=>x.id===id).sign_date,todayStr());
 }
});

test("其他成员仅可录入并提交，不能越权确认或审批合同",async()=>{
 const pid=await freshProject();
 const created=await client(exec)("POST","/api/contracts",{
  pid,name:"会务执行提交审批合同",vendor:"会务供应商",amount:1600,status:"草稿"
 });
 assert.equal(created.status,200,JSON.stringify(created.data));
 const id=created.data.contract.id;
 assert.equal((await client(exec)("POST","/api/contracts/"+id+"/transition",{action:"submit"})).status,200);
 const denied=await client(exec)("POST","/api/contracts/"+id+"/transition",{action:"sign"});
 assert.equal(denied.status,403,"执行成员只能提交不能签署");
 const approve=await client(assoc)("POST","/api/contracts/"+id+"/transition",{action:"sign"});
 assert.equal(approve.status,200,"协会管理员可以审批成员提交的合同："+JSON.stringify(approve.data));
});
