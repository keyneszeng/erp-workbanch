"use strict";
/** 测试立项税费管理费率自动净额，编辑、旧库迁移与付款可用预算门禁。 */
const {test,before,after}=require("node:test"),assert=require("node:assert/strict");
const {spawn}=require("node:child_process"),fs=require("node:fs"),path=require("node:path"),os=require("node:os");
const dir=fs.mkdtempSync(path.join(os.tmpdir(),"erp-project-fee-")),port=8983;
const base="http://127.0.0.1:"+port;
let proc,cookie,newId;
async function req(method,url,data){
 const res=await fetch(base+url,{method,headers:{"content-type":"application/json",cookie},
 body:data===undefined?undefined:JSON.stringify(data)});
 return {status:res.status,body:await res.json()};
}
before(async()=>{
 proc=spawn(process.execPath,["--experimental-sqlite","server/index.js"],{
 cwd:path.join(__dirname,".."),env:{...process.env,ERP_DEMO_MODE:"1",
 ERP_PORT:String(port),ERP_DB:path.join(dir,"erp.db"),ERP_UPLOAD_DIR:path.join(dir,"uploads")},stdio:["ignore","pipe","pipe"]});
 proc.stderr.on("data",c=>{if(!String(c).includes("ExperimentalWarning"))process.stderr.write(c)});
 let good=false;
 for(let i=0;i<400;i++){try{if((await fetch(base+"/api/health")).ok){good=true;break;}}catch{}
 await new Promise(r=>setTimeout(r,150));}
 assert.ok(good,"server must become ready");
 const login=await fetch(base+"/api/auth/login",{method:"POST",headers:{"content-type":"application/json"},
 body:JSON.stringify({username:"admin",password:"123456"})});
 assert.equal(login.status,200);
 cookie=login.headers.get("set-cookie").split(";")[0];
});
after(()=>{proc?.kill("SIGTERM");fs.rmSync(dir,{recursive:true,force:true});});
test("历史项目默认0%：可用预算不应被迁移意外扣减",async()=>{
 const r=await req("GET","/api/projects/MP-2026-008");
 assert.equal(r.status,200);
 assert.equal(Number(r.body.project.tax_fee_rate),0);
 assert.equal(r.body.project.available_budget,72000);
});
test("创建立项：预算100000、税费10%自动返回可用90000并持久保存",async()=>{
 const meta=await req("GET","/api/meta");
 const admin=await req("GET","/api/auth/me");
 const b={name:"税费管理费回归项目",assoc:meta.body.assocs[0],form:meta.body.forms[0],
 date:"2027-06-10",days:1,budget:100000,tax_fee_rate:10,people:30,
 owner:admin.body.user.name,agenda:"09:00主持开场；10:00专题讨论"};
 const r=await req("POST","/api/projects",b);
 assert.equal(r.status,200,JSON.stringify(r.body));
 newId=r.body.project.id;
 assert.equal(Number(r.body.project.tax_fee_rate),10);
 assert.equal(r.body.project.budget,100000);
 assert.equal(r.body.project.available_budget,90000);
 const detail=await req("GET","/api/projects/"+newId);
 assert.equal(detail.body.project.available_budget,90000);
 const list=await req("GET","/api/projects?size=100");
 const row=list.body.rows.find(p=>p.id===newId);
 assert.ok(row);
 assert.equal(row.available_budget,90000);
});
test("编辑费率时实时重算，支持小数费率且以分舍入",async()=>{
 const updated=await req("PATCH","/api/projects/"+newId,{budget:12345.67,tax_fee_rate:12.5});
 assert.equal(updated.status,200,JSON.stringify(updated.body));
 assert.equal(updated.body.project.tax_fee_rate,12.5);
 assert.equal(updated.body.project.available_budget,10802.46);
 const noRate=await req("PATCH","/api/projects/"+newId,{budget:20000});
 assert.equal(noRate.status,200);
 assert.equal(noRate.body.project.tax_fee_rate,12.5,"预算修改不应清空费率");
 assert.equal(noRate.body.project.available_budget,17500);
});
test("拒绝非法费率，不改变持久化项目",async()=>{
 for(const raw of [-1,101,"10.123","abc","Infinity"]){
  const r=await req("PATCH","/api/projects/"+newId,{tax_fee_rate:raw});
  assert.equal(r.status,400,JSON.stringify({raw,body:r.body}));
 }
 const detail=await req("GET","/api/projects/"+newId);
 assert.equal(detail.body.project.tax_fee_rate,12.5);
});
test("含税费可用预算小于已占用金额必须拦截",async()=>{
 const bad=await req("PATCH","/api/projects/MP-2026-008",{tax_fee_rate:96});
 assert.equal(bad.status,409,JSON.stringify(bad.body));
 assert.equal(bad.body.error.code,"BUDGET_BELOW_COMMITTED");
 const good=await req("PATCH","/api/projects/MP-2026-008",{tax_fee_rate:95});
 assert.equal(good.status,200,JSON.stringify(good.body));
 assert.equal(good.body.project.available_budget,3600);
 const pay=await req("POST","/api/payments",{pid:"MP-2026-008",type:"学会公付",
 payee:"税费限额测试供应商",payee_bank:"中国银行北京分行",
 payee_account:"3210987654321098",amount:1});
 assert.equal(pay.status,409,JSON.stringify(pay.body));
 assert.equal(pay.body.error.code,"OVER_BUDGET");
 assert.match(pay.body.error.message,/可用预算/);
});
test("费率100%时可用预算为0；0%恢复全额",async()=>{
 const all=await req("PATCH","/api/projects/"+newId,{tax_fee_rate:100});
 assert.equal(all.status,200);
 assert.equal(all.body.project.available_budget,0);
 const zero=await req("PATCH","/api/projects/"+newId,{tax_fee_rate:0});
 assert.equal(zero.status,200);
 assert.equal(zero.body.project.available_budget,20000);
});
