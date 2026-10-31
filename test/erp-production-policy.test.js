"use strict";
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { ASSOCS } = require("../server/lib/constants");
const dir = fs.mkdtempSync(path.join(os.tmpdir(),"erp-policy-"));
const port = 12500 + process.pid % 700;
const root = "http://127.0.0.1:" + port;
const phone = "13800138000";
let proc;
async function request(method, url, data, cookie="") {
  const res=await fetch(root+url,{method,headers:{"Content-Type":"application/json",...(cookie?{Cookie:cookie}:{})},
    body:data===undefined?undefined:JSON.stringify(data)});
  const body=await res.json();
  return { status:res.status,body,cookie:(res.headers.get("set-cookie")||"").split(";")[0] };
}
before(async () => {
  proc=spawn(process.execPath,["--experimental-sqlite","server/index.js"],{
    cwd:path.resolve(__dirname,".."), stdio:["ignore","pipe","pipe"],
    env:{...process.env,NODE_ENV:"test",ERP_DEMO_MODE:"0",ERP_DB_BACKEND:"",ERP_DB:path.join(dir,"test.db"),
      ERP_PORT:String(port),ERP_HOST:"127.0.0.1",ERP_BOOTSTRAP_ADMIN_PHONE:phone,
      ERP_SMS_PROVIDER:"test",ERP_SMS_TEST_MODE:"1",ERP_SESSION_FALLBACK:"0"}
  });
  let err="";proc.stderr.on("data",b=>err+=String(b));
  for(let i=0;i<180;i++){
    if(proc.exitCode!==null)throw Error("Server failed "+err);
    try{if((await request("GET","/api/health")).status===200)return;}catch{}
    await new Promise(r=>setTimeout(r,100));
  }
  throw Error("Server did not start "+err);
});
after(()=>{if(proc)proc.kill("SIGTERM");fs.rmSync(dir,{recursive:true,force:true});});
test("production: association member IDs, approved contract signing and pay-after-verify gate",async()=>{
  let r=await request("POST","/api/auth/login",{username:phone,password:"123456"});
  assert.equal(r.status,200,JSON.stringify(r.body));
  await request("POST","/api/auth/sms/send",{},r.cookie);
  r=await request("POST","/api/auth/password",{oldPassword:"123456",newPassword:"PolicyStrong2026",smsCode:"654321"},r.cookie);
  assert.equal(r.status,200,JSON.stringify(r.body));
  const cookie=r.cookie;
  const add=async (p,name,assoc)=>request("POST","/api/users",{phone:p,name,role:"assoc",assoc},cookie);
  const a=await add("13900139000","第一负责人",ASSOCS[0]);
  const b=await add("13700137000","其他协会负责人",ASSOCS[1]);
  assert.equal(a.status,200,JSON.stringify(a.body));
  assert.equal(b.status,200,JSON.stringify(b.body));
  const members=await request("GET","/api/users/assignable?assoc="+encodeURIComponent(ASSOCS[0]),undefined,cookie);
  assert.equal(members.status,200);
  assert.ok(members.body.rows.some(x=>x.id===a.body.user.id));
  assert.ok(!members.body.rows.some(x=>x.id===b.body.user.id));
  const base={name:"生产流程验证",assoc:ASSOCS[0],form:"线下",date:"2027-08-10",budget:20000,people:20,agenda:"09:00开幕；10:00专家分享"};
  const fake=await request("POST","/api/projects",{...base,owner:"任意伪造姓名"},cookie);
  assert.equal(fake.status,400);
  const foreign=await request("POST","/api/projects",{...base,owner_id:b.body.user.id},cookie);
  assert.equal(foreign.status,400);
  const created=await request("POST","/api/projects",{...base,owner_id:a.body.user.id},cookie);
  assert.equal(created.status,200,JSON.stringify(created.body));
  assert.equal(created.body.project.owner_id,a.body.user.id);
  const pid=created.body.project.id;
  const contract=await request("POST","/api/contracts",{pid,name:"会议服务合同",vendor:"服务供应商",amount:8000,status:"已签署"},cookie);
  assert.equal(contract.status,200,JSON.stringify(contract.body));
  assert.equal(contract.body.contract.status,"待签署","creation must not bypass signing approval");
  const pending=await request("GET","/api/approvals?type="+encodeURIComponent("合同审批"),undefined,cookie);
  assert.equal(pending.status,200);
  const ap=pending.body.rows.find(x=>x.ref_id===contract.body.contract.id&&x.status==="待审批");
  assert.ok(ap,"contract approval was created");
  const decided=await request("POST","/api/approvals/"+ap.id+"/decide",{approve:true,comment:"同意签署"},cookie);
  assert.equal(decided.status,200,JSON.stringify(decided.body));
  const signed=await request("GET","/api/contracts?pid="+pid,undefined,cookie);
  assert.equal(signed.body.rows.find(x=>x.id===contract.body.contract.id).status,"已签署");
  const premature=await request("POST","/api/payments",{pid,type:"学会公付",payee:"供应商",payee_bank:"中国银行",payee_account:"1234567890123456",amount:100,invoice_no:"INV-1"},cookie);
  assert.equal(premature.status,409,"payment cannot precede verification");
});
