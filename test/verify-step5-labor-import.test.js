"use strict";
/**
 * 第 5 步 OCR 判定通过后，劳务表识别出的收款账号必须：
 *  1) 以 AES-GCM 密文入库（库里/接口里都不出现完整账号）
 *  2) 出现在 /payee-options 里，source=labor，只带尾号
 *  3) 判定不通过时清空
 * 同时验证扫描报告不会把完整账号下发给浏览器。
 * 这条链路在 !isDemoMode() 分支，必须用生产模式服务器验证。
 */
const {test,before,after}=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs"),os=require("node:os"),path=require("node:path");
const {spawn}=require("node:child_process");
const {DatabaseSync}=require("node:sqlite");

const dir=fs.mkdtempSync(path.join(os.tmpdir(),"erp-labor5-"));
const port=13800+(process.pid%400);
const root="http://127.0.0.1:"+port;
const phone="13800138000";
const pid="MP-2026-902";
const A1="6222020200099998888",A2="6217000010001234567";
const LABOR_TEXT="姓名|时间|角色|金额|银行账号|开户行\n"+
 `张伟明|2026-11-01|讲者|1000|${A1}|中国工商银行广州分行\n`+
 `李建国|2026-11-01|主持|800|${A2}|中国建设银行`;
let proc,db,cookie;

async function request(method,url,data,ck=""){
 const res=await fetch(root+url,{method,
  headers:{"Content-Type":"application/json",...(ck?{Cookie:ck}:{})},
  body:data===undefined?undefined:JSON.stringify(data)});
 return {status:res.status,body:await res.json().catch(()=>null),
  cookie:(res.headers.get("set-cookie")||"").split(";")[0]};
}

before(async()=>{
 proc=spawn(process.execPath,["--experimental-sqlite","server/index.js"],{
  cwd:path.resolve(__dirname,".."),stdio:["ignore","pipe","pipe"],
  env:{...process.env,NODE_ENV:"test",ERP_DEMO_MODE:"0",ERP_DB_BACKEND:"",
   ERP_DB:path.join(dir,"test.db"),ERP_PORT:String(port),ERP_HOST:"127.0.0.1",
   ERP_BOOTSTRAP_ADMIN_PHONE:phone,ERP_SMS_PROVIDER:"test",ERP_SMS_TEST_MODE:"1",
   ERP_SESSION_FALLBACK:"0",ERP_UPLOAD_DIR:path.join(dir,"uploads"),
   ERP_FINANCIAL_DATA_KEY:"a".repeat(64),ERP_OCR_ENABLED:"0"}
 });
 let err="";proc.stderr.on("data",b=>{err+=String(b);});
 for(let i=0;i<600;i++){
  if(proc.exitCode!==null)throw Error("server failed: "+err);
  try{if((await request("GET","/api/health")).status===200)break;}catch{}
  await new Promise(r=>setTimeout(r,100));
 }
 let r=await request("POST","/api/auth/login",{username:phone,password:"123456"});
 assert.equal(r.status,200,JSON.stringify(r.body));
 await request("POST","/api/auth/sms/send",{},r.cookie);
 r=await request("POST","/api/auth/password",
  {oldPassword:"123456",newPassword:"Labor5Strong2026",smsCode:"654321"},r.cookie);
 assert.equal(r.status,200,JSON.stringify(r.body));
 cookie=r.cookie;

 db=new DatabaseSync(path.join(dir,"test.db"));
 db.exec("PRAGMA busy_timeout=5000");
 const at="2026-11-09 09:00";
 db.prepare("INSERT INTO projects (id,name,assoc,form,date,days,budget,tax_fee_rate,people,owner,owner_id,phone,dept,agenda,status,status_at,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
  .run(pid,"第5步劳务账号导入测试","消化病分会","线下","2026-12-01",1,1800,0,50,
   "总管理员",1,phone,"学术部","09:00 开场","待核销",at,1,at,at);
 const m=db.prepare("INSERT INTO materials (pid,kind,name,version,uploader,created_at,file_key,file_name,file_size,file_mime) VALUES (?,?,?,?,?,?,?,?,?,?)")
  .run(pid,"劳务表","专家劳务登记表","v1","总管理员",at,"labor.txt","劳务表.txt",512,"text/plain");
 // 模拟已完成 OCR/原生文本提取：文本层里含完整账号，报告对外必须脱敏。
 db.prepare("INSERT INTO material_ocr_results (material_id,pid,file_key,recognized_text,suggestions_json,engine,mode,pages,total_pages,truncated,updated_at,updated_by) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)")
  .run(Number(m.lastInsertRowid),pid,"labor.txt",LABOR_TEXT,"[]","文本内容提取 v1","native-text",1,1,0,at,"总管理员");
});
after(()=>{if(proc)proc.kill("SIGTERM");fs.rmSync(dir,{recursive:true,force:true});});

test("扫描报告只给尾号，不下发完整银行账号",async()=>{
 const r=await request("POST",`/api/projects/${pid}/verify/steps/5/scan`,{},cookie);
 assert.equal(r.status,200,JSON.stringify(r.body));
 const report=r.body.report;
 assert.ok(report,"必须有扫描报告");
 assert.equal(report.laborRecords,undefined,"完整账号记录不得下发浏览器");
 assert.equal(report.laborRecordsMasked.length,2);
 assert.equal(report.evidence.laborCount,2);
 const json=JSON.stringify(report);
 assert.ok(!json.includes(A1)&&!json.includes(A2),"响应里不能出现完整卡号");
 assert.ok(report.checks.some(x=>x.name==="劳务收款账号识别"),"应有账号识别检查项");
 assert.ok(report.checks.find(x=>x.name==="劳务收款账号识别").detail.includes("尾号"));
});

test("OCR 判定通过后账号加密入库，付款下拉可选到 labor 来源",async()=>{
 const scan=await request("POST",`/api/projects/${pid}/verify/steps/5/scan`,{},cookie);
 const token=scan.body.report.token;
 const r=await request("POST",`/api/projects/${pid}/verify/steps/5`,
  {result:"通过",auto:true,scanToken:token},cookie);
 assert.equal(r.status,200,JSON.stringify(r.body));

 const rows=db.prepare("SELECT name,bank,account_cipher,amount FROM verified_labor_payees WHERE pid=? ORDER BY id").all(pid);
 assert.equal(rows.length,2);
 assert.equal(rows[0].name,"张伟明");
 assert.equal(rows[0].bank,"中国工商银行广州分行");
 assert.equal(rows[0].amount,1000);
 assert.ok(!rows[0].account_cipher.includes(A1),"库里不能是明文账号");
 assert.ok(!rows[1].account_cipher.includes(A2));

 const step=db.prepare("SELECT result,evidence_json FROM verify_steps WHERE pid=? AND step_no=5").get(pid);
 assert.equal(step.result,"通过");
 assert.equal(JSON.parse(step.evidence_json).laborAccountsStored,2);

 const po=await request("GET",`/api/projects/${pid}/payee-options`,undefined,cookie);
 assert.equal(po.status,200,JSON.stringify(po.body));
 const labor=po.body.rows.filter(x=>x.source==="labor");
 assert.equal(labor.length,2);
 assert.equal(labor[0].maskedAccount,"尾号 "+A1.slice(-4));
 const text=JSON.stringify(po.body);
 assert.ok(!text.includes(A1)&&!text.includes(A2),"付款下拉不能暴露完整账号");
});

test("判定不通过时清空已保存的劳务账号",async()=>{
 const scan=await request("POST",`/api/projects/${pid}/verify/steps/5/scan`,{},cookie);
 const r=await request("POST",`/api/projects/${pid}/verify/steps/5`,
  {result:"不通过",auto:true,scanToken:scan.body.report.token},cookie);
 assert.equal(r.status,200,JSON.stringify(r.body));
 const n=db.prepare("SELECT COUNT(*) AS c FROM verified_labor_payees WHERE pid=?").get(pid).c;
 assert.equal(n,0);
});
