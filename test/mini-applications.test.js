"use strict";
const {test,before,after}=require("node:test");
const assert=require("node:assert/strict");
const {spawn}=require("node:child_process");
const fs=require("node:fs"),os=require("node:os"),path=require("node:path");
const {ASSOCS}=require("../server/lib/constants");
const dir=fs.mkdtempSync(path.join(os.tmpdir(),"erp-ux-mini-"));
const port=13600+(process.pid%520),host="http://127.0.0.1:"+port;
let child;
async function req(method,uri,payload,cookie=""){
 const res=await fetch(host+uri,{method,headers:{"Content-Type":"application/json",...(cookie?{Cookie:cookie}:{})},
  body:payload===undefined?undefined:JSON.stringify(payload)});
 return {status:res.status,body:await res.json(),cookie:(res.headers.get("set-cookie")||"").split(";")[0]};
}
before(async()=>{
 child=spawn(process.execPath,["--experimental-sqlite","server/index.js"],{cwd:path.resolve(__dirname,".."),
  stdio:["ignore","pipe","pipe"],env:{...process.env,NODE_ENV:"test",ERP_DEMO_MODE:"0",ERP_DB:path.join(dir,"data.db"),
    ERP_DB_BACKEND:"",ERP_HOST:"127.0.0.1",ERP_PORT:String(port),ERP_BOOTSTRAP_ADMIN_PHONE:"13800138000",
    ERP_SESSION_FALLBACK:"0",ERP_SMS_PROVIDER:"test",ERP_SMS_TEST_MODE:"1",ERP_MINIPROGRAM_ENABLED:"1"}});
 let errors="";child.stderr.on("data",b=>errors+=String(b));
 for(let i=0;i<750;i++){
  if(child.exitCode!==null)throw Error("Server crashed: "+errors);
  try{if((await req("GET","/api/health")).status===200)return;}catch{}
  await new Promise(r=>setTimeout(r,80));
 }
 throw Error("Server not ready "+errors);
});
after(()=>{if(child)child.kill("SIGTERM");fs.rmSync(dir,{recursive:true,force:true});});
test("mobile participant application: own-association draft, edit, submit and manager approval",async()=>{
 let admin=await req("POST","/api/auth/login",{username:"13800138000",password:"123456"});
 assert.equal(admin.status,200);
 assert.equal((await req("POST","/api/auth/sms/send",{},admin.cookie)).status,200);
 admin=await req("POST","/api/auth/password",
  {oldPassword:"123456",newPassword:"UXAdmin2027#Safe",smsCode:"654321"},admin.cookie);
 assert.equal(admin.status,200,JSON.stringify(admin.body));
 const adminCookie=admin.cookie;
 const a=await req("POST","/api/users",{phone:"13900139000",name:"参会发起者",role:"user",assoc:ASSOCS[0]},adminCookie);
 const b=await req("POST","/api/users",{phone:"13700137000",name:"其他协会用户",role:"user",assoc:ASSOCS[1]},adminCookie);
 assert.equal(a.status,200,JSON.stringify(a.body));assert.equal(b.status,200,JSON.stringify(b.body));
 // 正式环境的新账号默认0权限；由总管理员明确启用小程序立项和本人项目查看。
 for(const id of [a.body.user.id,b.body.user.id]){
  const grant=await req("PATCH","/api/users/"+id+"/access",
    {modules:["projects"],permissions:["mini:apply"]},adminCookie);
  assert.equal(grant.status,200,JSON.stringify(grant.body));
 }
 async function auth(phone){
  let r=await req("POST","/api/auth/login",{username:phone,password:"123456"});
  assert.equal(r.status,200);
  await req("POST","/api/auth/sms/send",{},r.cookie);
  r=await req("POST","/api/auth/password",{oldPassword:"123456",newPassword:"UXMember2027#Safe",smsCode:"654321"},r.cookie);
  assert.equal(r.status,200,JSON.stringify(r.body));
  return r.cookie;
 }
 const alice=await auth("13900139000"),bob=await auth("13700137000");
 const base={name:"移动端真实立项申请",assoc:ASSOCS[0],form:"线下",date:"2027-08-10",days:2,
  event_end_date:"2027-08-11",event_start_time:"09:00",event_end_time:"18:00",
  budget:20000,tax_fee_rate:8.5,people:120,agenda:"09:00开场；09:30专题发言；10:30交流"};
 assert.equal((await req("POST","/api/projects",{...base,owner_id:a.body.user.id},alice)).status,403,
  "ordinary user cannot bypass the dedicated application API");
 assert.equal((await req("POST","/api/mini/applications",{...base,assoc:ASSOCS[1]},alice)).status,403,
  "participant cannot apply to another association");
 const meta=await req("GET","/api/meta",undefined,alice);
 assert.equal(meta.status,200);
 assert.deepEqual(meta.body.projectDepts,meta.body.depts,"网页和小程序须使用同一份部门目录");
 assert.ok(!meta.body.depts.includes("会务部"));
 const rejectedDept=await req("POST","/api/mini/applications",{...base,dept:"会务部"},alice);
 assert.equal(rejectedDept.status,400,"旧部门不能用于新立项");
 const agendaFile={filename:"初版议程.txt",content_base64:Buffer.from("09:00 开幕\n10:00 专题报告").toString("base64")};
 assert.equal((await req("POST","/api/projects/agenda-ocr",agendaFile)).status,401,
  "内部议程OCR不能被匿名调用");
 const importAgenda=await req("POST","/api/projects/agenda-ocr",agendaFile,alice);
 assert.equal(importAgenda.status,200,JSON.stringify(importAgenda.body));
 assert.match(importAgenda.body.agenda,/专题报告/);
 const invalidPeriod=await req("POST","/api/mini/applications",{...base,event_end_date:"2027-08-12"},alice);
 assert.equal(invalidPeriod.status,400,"会期必须与举办时间段一致");
 for(const raw of [undefined,"",null]){
  const input={...base};
  if(raw===undefined)delete input.tax_fee_rate;
  else input.tax_fee_rate=raw;
  const bad=await req("POST","/api/mini/applications",input,alice);
  assert.equal(bad.status,400,"微信内部立项税费率缺失或空值必须被拦截："+JSON.stringify(bad.body));
 }
 const explicitZero=await req("POST","/api/mini/applications",{...base,name:"显式零费率",tax_fee_rate:0},alice);
 assert.equal(explicitZero.status,200,JSON.stringify(explicitZero.body));
 const zeroDetail=await req("GET","/api/mini/applications/"+explicitZero.body.project.id,undefined,alice);
 assert.equal(zeroDetail.body.project.tax_fee_rate,0,"用户主动填0应可保存，且详情可回显");
 const created=await req("POST","/api/mini/applications",base,alice);
 assert.equal(created.status,200,JSON.stringify(created.body));
 const id=created.body.project.id;
 assert.match(id,/^HDYX-2027-\d{2}$/,"小程序立项编号使用协会简写和举办年份");
 const period=(await req("GET","/api/mini/applications/"+id,undefined,alice)).body.project;
 assert.equal(period.event_end_date,"2027-08-11");
 assert.equal(period.event_start_time,"09:00");
 assert.equal(period.event_end_time,"18:00");
 assert.equal(period.tax_fee_rate,8.5,"小程序详情需回显主动填写的协会费税率");
 const mine=await req("GET","/api/mini/applications",undefined,alice);
 assert.equal(mine.status,200);
 assert.ok(mine.body.rows.some(x=>x.id===id&&x.status==="草稿"));
 assert.ok(!mine.body.rows.some(x=>x.id==="unknown"));
 assert.equal((await req("GET","/api/mini/applications",undefined,bob)).body.total,0);
 assert.equal((await req("GET","/api/mini/applications/"+id,undefined,bob)).status,403);
 assert.equal((await req("PATCH","/api/mini/applications/"+id,{...base,name:"越权修改"},bob)).status,403);
 assert.equal((await req("POST","/api/mini/applications/"+id+"/submit",{},bob)).status,403);
 const edited=await req("PATCH","/api/mini/applications/"+id,{...base,name:"正式提交立项"},alice);
 assert.equal(edited.status,200,JSON.stringify(edited.body));
 const afterEdit=await req("GET","/api/mini/applications/"+id,undefined,alice);
 assert.equal(afterEdit.body.project.tax_fee_rate,8.5,"编辑草稿后保留费率");
 const changed=await req("PATCH","/api/mini/applications/"+id,{...base,tax_fee_rate:12.75},alice);
 assert.equal(changed.status,200,JSON.stringify(changed.body));
 const afterChanged=await req("GET","/api/mini/applications/"+id,undefined,alice);
 assert.equal(afterChanged.body.project.tax_fee_rate,12.75,"编辑草稿须持久化新费率而非丢失");
 const missingRate=await req("PATCH","/api/mini/applications/"+id,
   Object.fromEntries(Object.entries(base).filter(([k])=>k!=="tax_fee_rate")),alice);
 assert.equal(missingRate.status,400,"微信草稿修改不能通过遗漏费率把它偷偷回退到0");
 const submitted=await req("POST","/api/mini/applications/"+id+"/submit",{},alice);
 assert.equal(submitted.status,200,JSON.stringify(submitted.body));
 assert.equal(submitted.body.project.status,"待审批");
 assert.equal((await req("POST","/api/projects/"+id+"/transition",{action:"approve"},alice)).status,403,"ordinary applicant cannot approve their own submitted application");
 assert.equal((await req("POST","/api/mini/applications/"+id+"/submit",{},alice)).status,409);
 assert.equal((await req("PATCH","/api/mini/applications/"+id,base,alice)).status,409);
 const aps=await req("GET","/api/approvals",undefined,adminCookie);
 assert.equal(aps.status,200);
 assert.ok(aps.body.rows.some(x=>x.pid===id&&x.type==="立项审批"&&x.status==="待审批"),
  "submission must generate the existing ERP approval record");
 const approval=await req("POST","/api/projects/"+id+"/transition",{action:"approve"},adminCookie);
 assert.equal(approval.status,200,JSON.stringify(approval.body));
 assert.equal(approval.body.project.status,"已立项");
 const visible=await req("GET","/api/projects/"+id,undefined,alice);
 assert.equal(visible.status,200);
 assert.equal(visible.body.project.name,"正式提交立项");
 assert.equal(visible.body.project.budget,undefined,"participant project detail must not expose internal budget");
});
