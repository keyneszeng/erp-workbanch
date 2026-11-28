"use strict";
/**
 * 第 6 步「会务合同与发票关联核对」的门禁回归。
 *
 * 口径：只要求 会务需求预算 == 已签会务合同总额，并已关联合同/发票原件；
 * **不校验发票金额**。旧实现强制 OCR 唯一识别发票金额并要求三方一致，
 * 项目里有多张发票或扫描件时永远判不了通过。
 * 这条链路在 !isDemoMode() 分支里，必须用生产模式服务器验证。
 */
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { DatabaseSync } = require("node:sqlite");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "erp-step6-"));
const port = 13400 + (process.pid % 500);
const root = "http://127.0.0.1:" + port;
const phone = "13800138000";
const pid = "MP-2026-901";
let proc, db, cookie;

async function request(method, url, data, ck = "") {
  const res = await fetch(root + url, {
    method,
    headers: { "Content-Type": "application/json", ...(ck ? { Cookie: ck } : {}) },
    body: data === undefined ? undefined : JSON.stringify(data)
  });
  return { status: res.status, body: await res.json().catch(() => null), cookie: (res.headers.get("set-cookie") || "").split(";")[0] };
}

before(async () => {
  proc = spawn(process.execPath, ["--experimental-sqlite", "server/index.js"], {
    cwd: path.resolve(__dirname, ".."), stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env, NODE_ENV: "test", ERP_DEMO_MODE: "0", ERP_DB_BACKEND: "",
      ERP_DB: path.join(dir, "test.db"), ERP_PORT: String(port), ERP_HOST: "127.0.0.1",
      ERP_BOOTSTRAP_ADMIN_PHONE: phone, ERP_SMS_PROVIDER: "test", ERP_SMS_TEST_MODE: "1",
      ERP_SESSION_FALLBACK: "0", ERP_UPLOAD_DIR: path.join(dir, "uploads")
    }
  });
  let err = "";
  proc.stderr.on("data", b => { err += String(b); });
  for (let i = 0; i < 600; i++) {
    if (proc.exitCode !== null) throw Error("server failed: " + err);
    try { if ((await request("GET", "/api/health")).status === 200) break; } catch {}
    await new Promise(r => setTimeout(r, 100));
  }

  // 生产模式首次登录必须改密
  let r = await request("POST", "/api/auth/login", { username: phone, password: "123456" });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  await request("POST", "/api/auth/sms/send", {}, r.cookie);
  r = await request("POST", "/api/auth/password", {
    oldPassword: "123456", newPassword: "Step6Strong2026", smsCode: "654321"
  }, r.cookie);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  cookie = r.cookie;

  db = new DatabaseSync(path.join(dir, "test.db"));
  db.exec("PRAGMA busy_timeout=5000");
  const at = "2026-11-08 23:00";
  db.prepare("INSERT INTO projects (id,name,assoc,form,date,days,budget,tax_fee_rate,people,owner,owner_id,phone,dept,agenda,status,status_at,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
    .run(pid, "第6步门禁测试", "消化病分会", "线下", "2026-12-01", 1, 3175, 0, 50,
      "总管理员", 1, phone, "学术部", "09:00 开场", "待核销", at, 1, at, at);
  db.prepare("INSERT INTO demand_sheets (pid,confirmed,confirmed_by,confirmed_at,created_at,updated_at) VALUES (?,?,?,?,?,?)")
    .run(pid, 1, "总管理员", at, at, at);
  db.prepare("INSERT INTO demand_items (pid,grp,item,need,budget,quantity,unit_price,updated_at) VALUES (?,?,?,?,?,?,?,?)")
    .run(pid, "现场执行", "会务服务", "需要", 3175, "1", "3175", at);
  db.prepare("INSERT INTO contracts (id,pid,name,vendor,amount,sign_date,status,category,created_by,created_at,file_key) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
    .run("HT-TEST-1", pid, "会务服务协议", "某会务公司", 3175, "2026-11-01", "已签署", "会务需求", 1, at, "meet.pdf");
  const ins = db.prepare("INSERT INTO materials (pid,kind,name,version,uploader,created_at,file_key,file_name,file_size,file_mime) VALUES (?,?,?,?,?,?,?,?,?,?)");
  ins.run(pid, "合同", "会务服务协议", "v1", "总管理员", at, "meet.pdf", "meet.pdf", 512, "application/pdf");
  ins.run(pid, "会务发票", "会务发票", "v1", "总管理员", at, "inv.pdf", "inv.pdf", 512, "application/pdf");
});
after(() => { if (proc) proc.kill("SIGTERM"); fs.rmSync(dir, { recursive: true, force: true }); });

const REVIEWED = {
  demandReviewed: true, meetingContractReviewed: true, meetingInvoiceReviewed: true
};
const judge = (extra = {}) => request("POST", `/api/projects/${pid}/verify/steps/6`,
  { result: "通过", evidence: REVIEWED, ...extra }, cookie);

test("不提供发票金额也能判定通过（新口径不校验发票金额）", async () => {
  const r = await judge();
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.match(r.body?.message || "", /判定：通过/);
});

test("OCR/人工填了与预算不同的发票金额也不拦截", async () => {
  const r = await judge({ invoiceAmount: 99999 });
  assert.equal(r.status, 200, JSON.stringify(r.body));
});

test("会务需求预算与已签会务合同总额不一致仍然拦截", async () => {
  db.prepare("UPDATE demand_items SET budget=? WHERE pid=?").run(4000, pid);
  const r = await judge();
  assert.equal(r.status, 409, JSON.stringify(r.body));
  assert.equal(r.body?.error?.code, "MEETING_THREE_WAY_MISMATCH");
  db.prepare("UPDATE demand_items SET budget=? WHERE pid=?").run(3175, pid);
});

test("“会务协议”就是会务合同：已签历史其他类别、PDF原件关联均有效",async()=>{
 try{
  db.prepare("UPDATE materials SET kind='会务协议',name='已签会务服务协议' WHERE pid=? AND file_key='meet.pdf'").run(pid);
  db.prepare("UPDATE contracts SET category='其他' WHERE id='HT-TEST-1'").run();
  const s=await request("POST","/api/projects/"+pid+"/verify/steps/6/scan",{},cookie);
  assert.equal(s.status,200,JSON.stringify(s.body));
  const report=s.body.report;
  assert.equal(report.demandSheet.contractTotal,3175);
  assert.ok(report.files.some(x=>x.kind==="会务协议"),"linked meeting agreement must be included");
  assert.equal(report.checks.find(x=>x.name==="已签会务合同/会务协议原件")?.status,"一致");
  assert.equal(report.summary.mismatch,0,JSON.stringify(report.checks));
  const passed=await judge();
  assert.equal(passed.status,200,JSON.stringify(passed.body));

  // A sponsor or labor contract must NEVER be reinterpreted as a meeting agreement.
  db.prepare("UPDATE contracts SET category='企业赞助' WHERE id='HT-TEST-1'").run();
  const excluded=await request("POST","/api/projects/"+pid+"/verify/steps/6/scan",{},cookie);
  assert.equal(excluded.status,200);
  assert.ok(!excluded.body.report.files.some(x=>x.kind==="会务协议"));
  const denied=await judge();
  assert.equal(denied.status,409,JSON.stringify(denied.body));
 }finally{
  db.prepare("UPDATE contracts SET category='会务需求' WHERE id='HT-TEST-1'").run();
  db.prepare("UPDATE materials SET kind='合同',name='会务服务协议' WHERE pid=? AND file_key='meet.pdf'").run(pid);
 }
});
test("第6项真实可检索PDF协议和发票能自动提取文字，仍保持合同与发票的关联门禁",async()=>{
 const {PDFDocument,StandardFonts}=require("pdf-lib");
 const makePdf=async text=>{
  const pdf=await PDFDocument.create(),page=pdf.addPage([595,842]);
  const font=await pdf.embedFont(StandardFonts.Helvetica);
  page.drawText(text,{x:42,y:720,size:12,font});
  return Buffer.from(await pdf.save());
 };
 const upload=async(text,name)=>{
  const buffer=await makePdf(text);
  const response=await fetch(root+"/api/uploads?pid="+encodeURIComponent(pid),{
   method:"POST",headers:{Cookie:cookie,"content-type":"application/pdf",
    "x-file-name":encodeURIComponent(name)},body:buffer
  });
  const obj=await response.json();
  assert.equal(response.status,200,JSON.stringify(obj));
  return obj.key;
 };
 const agreementKey=await upload("Meeting service agreement. The contract is signed and covers meeting operations. Budget 3175 CNY.","meeting-agreement.pdf");
 const invoiceKey=await upload("Meeting service invoice. Invoice issued for meeting operations and services. Reference number INV20261117.","meeting-invoice.pdf");
 try{
  db.prepare("UPDATE contracts SET file_key=? WHERE id='HT-TEST-1'").run(agreementKey);
  db.prepare("UPDATE materials SET file_key=?,file_name='meeting-agreement.pdf',kind='会务协议' WHERE pid=? AND file_key='meet.pdf'").run(agreementKey,pid);
  db.prepare("UPDATE materials SET file_key=?,file_name='meeting-invoice.pdf' WHERE pid=? AND file_key='inv.pdf'").run(invoiceKey,pid);
  const s=await request("POST","/api/projects/"+pid+"/verify/steps/6/scan",{},cookie);
  assert.equal(s.status,200,JSON.stringify(s.body));
  const report=s.body.report;
  assert.ok(report.scanned>=2,JSON.stringify(report.files));
  const agreement=report.files.find(x=>x.kind==="会务协议");
  const invoice=report.files.find(x=>x.kind==="会务发票");
  assert.equal(agreement.state,"recognized");
  assert.equal(invoice.state,"recognized");
  assert.match(agreement.preview,/Meeting service agreement/i);
  assert.match(invoice.preview,/Meeting service invoice/i);
  assert.equal(agreement.mode,"pdf-text");
  assert.equal(invoice.mode,"pdf-text");
  assert.equal(report.checks.find(x=>x.name==="已签会务合同/会务协议原件")?.status,"一致");
  assert.equal(report.checks.find(x=>x.name==="已关联会务发票原件")?.status,"一致");
  const accepted=await request("POST","/api/projects/"+pid+"/verify/steps/6",{
   result:"通过",auto:true,scanToken:report.token
  },cookie);
  assert.equal(accepted.status,200,JSON.stringify(accepted.body));
 }finally{
  db.prepare("UPDATE contracts SET file_key='meet.pdf' WHERE id='HT-TEST-1'").run();
  db.prepare("UPDATE materials SET file_key='meet.pdf',file_name='meet.pdf',kind='合同' WHERE pid=? AND file_key=?").run(pid,agreementKey);
  db.prepare("UPDATE materials SET file_key='inv.pdf',file_name='inv.pdf' WHERE pid=? AND file_key=?").run(pid,invoiceKey);
 }
});
/**
 * UI 判定链路回归：页面点「判定」会先 scan 再带 scanToken 提交 auto=true。
 * 第 6 步 scan 不做 OCR，scanned 恒为 0；若把「scanned>0」当作通过前置条件，
 * 文件齐备、四项检查全一致时按钮仍永久置灰、接口 409 OCR_EVIDENCE_REQUIRED。
 */
test("UI 链路：第6步不做OCR也能人工判定通过（scanned=0 不得拦截）", async () => {
  const s = await request("POST", `/api/projects/${pid}/verify/steps/6/scan`, {}, cookie);
  assert.equal(s.status, 200, JSON.stringify(s.body));
  const report = s.body?.report;
  assert.ok(report, "扫描必须返回比对报告");
  assert.equal(report.scanned, 0, "第6步按设计不做OCR，scanned 应为 0");
  assert.ok(report.total > 0, "必须已关联会务合同与会务发票原件");
  assert.ok(report.token, "扫描必须返回比对指纹");
  assert.equal(report.summary.mismatch, 0);
  assert.equal(report.summary.uncertain, 0);

  const r = await request("POST", `/api/projects/${pid}/verify/steps/6`, {
    result: "通过", auto: true, scanToken: report.token
  }, cookie);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.match(r.body?.message || "", /判定：通过/);
});


test("生产模式：已核销未结算项目允许补录合同，并自动退回待核销复核",async()=>{
 db.prepare("UPDATE projects SET status='已核销',status_at='2026-11-28 17:00' WHERE id=?").run(pid);
 const before=db.prepare("SELECT result FROM verify_steps WHERE pid=? AND step_no=6").get(pid);
 assert.equal(before.result,"通过","前置条件：第6步已经核验通过");
 const created=await request("POST","/api/contracts",{
  pid,name:"核销后补录会务服务合同",vendor:"补录会务公司",amount:1250,
  category:"会务需求",status:"草稿"
 },cookie);
 assert.equal(created.status,200,JSON.stringify(created.body));
 assert.match(created.body.message,/已退回「待核销」/);
 assert.ok(created.body.contract?.id);
 const project=db.prepare("SELECT status FROM projects WHERE id=?").get(pid);
 assert.equal(project.status,"待核销");
 const step=db.prepare("SELECT result,remark,checked_by,checked_at FROM verify_steps WHERE pid=? AND step_no=6").get(pid);
 assert.equal(step.result,"待判定");
 assert.match(step.remark,/归档前资料变更/);
 assert.equal(step.checked_by,null);
 assert.equal(step.checked_at,null);
 const revision=db.prepare("SELECT reason,after_json FROM admin_content_revisions WHERE pid=? AND entity_type='prearchive_material_recheck' ORDER BY id DESC LIMIT 1").get(pid);
 assert.match(revision.reason,/核销后补录合同/);
 assert.match(revision.after_json,/6/);
});

test("生产模式：已结算或已归档项目仍禁止新增合同",async()=>{
 db.prepare("UPDATE projects SET status='已结算' WHERE id=?").run(pid);
 const settled=await request("POST","/api/contracts",{
  pid,name:"结算后不应补录",vendor:"测试公司",amount:100,
  category:"会务需求",status:"草稿"
 },cookie);
 assert.equal(settled.status,409,JSON.stringify(settled.body));
 assert.equal(settled.body.error.code,"FROZEN");
 db.prepare("UPDATE projects SET status='已归档' WHERE id=?").run(pid);
 const archived=await request("POST","/api/contracts",{
  pid,name:"归档后不应补录",vendor:"测试公司",amount:100,
  category:"会务需求",status:"草稿"
 },cookie);
 assert.equal(archived.status,409,JSON.stringify(archived.body));
 assert.equal(archived.body.error.code,"ARCHIVED");
});
