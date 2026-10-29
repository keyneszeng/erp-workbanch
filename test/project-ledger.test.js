"use strict";
/**
 * 唯一会议编号 + 仅总管理员项目台账集成回归。
 * 使用独立 SQLite 种子库，不接触线上财务记录。
 */
const {test,before,after}=require("node:test");
const assert=require("node:assert/strict");
const {spawn}=require("node:child_process");
const fs=require("node:fs");
const path=require("node:path");
const PORT=8953,BASE="http://127.0.0.1:"+PORT;
const DB=path.join(__dirname,"..","data","test-project-ledger.db");
let server,users={};
async function healthy(){
  for(let n=0;n<150;n++){
    try{const r=await fetch(BASE+"/api/health");if(r.ok)return}catch{}
    await new Promise(resolve=>setTimeout(resolve,100));
  }
  throw Error("ledger API did not start");
}
async function login(user){
 const r=await fetch(BASE+"/api/auth/login",{method:"POST",headers:{"Content-Type":"application/json"},
   body:JSON.stringify({username:user,password:"123456"})});
 assert.equal(r.status,200,user+" login");
 return (r.headers.get("set-cookie")||"").split(";")[0];
}
async function request(role,path,method="GET",body){
 const r=await fetch(BASE+path,{method,headers:{
  ...(role?{Cookie:users[role]}:{}),
  ...(body?{"Content-Type":"application/json"}:{})
 },body:body?JSON.stringify(body):undefined});
 let parsed;
 if((r.headers.get("content-type")||"").includes("text/csv")) parsed=await r.text();
 else parsed=await r.json();
 return {status:r.status,body:parsed,headers:r.headers};
}
before(async()=>{
 for(const f of [DB,DB+"-wal",DB+"-shm"])try{fs.rmSync(f)}catch{}
 server=spawn(process.execPath,["--experimental-sqlite","server/index.js"],{
  cwd:path.join(__dirname,".."),env:{...process.env,ERP_DB:DB,ERP_PORT:String(PORT)},
  stdio:["ignore","pipe","pipe"]});
 server.stderr.on("data",d=>{if(!d.toString().includes("ExperimentalWarning"))process.stderr.write(d)});
 await healthy();
 for(const user of ["admin","assoc","exec","finance","guest","sunqian"])users[user]=await login(user);
});
after(()=>server?.kill("SIGTERM"));

test("编号直接是项目主键；多模块所有记录均按会议编号关联",async()=>{
 const pid="MP-2026-015";
 const r=await request("admin","/api/project-ledger/"+pid);
 assert.equal(r.status,200);
 assert.equal(r.body.meeting_no,pid);
 assert.equal(r.body.canonical_key,"projects.id");
 assert.ok(r.body.contracts.every(x=>x.pid===pid));
 assert.ok(r.body.payments.every(x=>x.pid===pid));
 assert.ok(r.body.financial_materials.every(x=>x.pid===pid));
 assert.ok(!r.body.settlement||r.body.settlement.pid===pid);
});
test("仅总管理员有权访问所有台账入口，即使财务本人负责该会议也不行",async()=>{
 const urls=["/api/project-ledger","/api/project-ledger/MP-2026-015","/api/project-ledger/MP-2026-015/export"];
 for(const user of ["assoc","exec","finance","guest","sunqian"]){
   for(const url of urls) {
     const r=await request(user,url);
     assert.equal(r.status,403,user+" "+url);
     assert.equal(r.body.error.code,"FORBIDDEN");
   }
 }
 for(const url of urls)assert.equal((await request(null,url)).status,401);
});
test("列表搜索可按会议编号定位并保留跨模块只读汇总",async()=>{
 const p="MP-2026-015";
 const list=await request("admin","/api/project-ledger?q="+p+"&page=1&size=10");
 assert.equal(list.status,200);
 assert.equal(list.body.total,1);
 assert.equal(list.body.rows[0].meeting_no,p);
 assert.ok(list.body.rows[0].financial_summary.payment_paid>0);
 assert.equal((await request("admin","/api/project-ledger?page=0")).status,400);
 assert.equal((await request("admin","/api/project-ledger?size=1000")).status,400);
});
test("金额基于真实业务字段；发票号码与发票原件不被混为一项",async()=>{
 const out=await request("admin","/api/project-ledger/MP-2026-006");
 assert.equal(out.status,200);
 const d=out.body;
 assert.equal(d.financial_summary.contract_total,
   Number(d.contracts.reduce((s,r)=>s+Number(r.amount),0).toFixed(2)));
 assert.equal(d.financial_summary.payment_paid,
   Number(d.payments.filter(r=>r.status==="已付款").reduce((s,r)=>s+Number(r.amount),0).toFixed(2)));
 assert.ok(d.document_coverage.invoice_numbers>=0);
 assert.ok(d.document_coverage.invoice_original_files>=0);
 assert.ok(d.payment_types.some(x=>x.type==="厂家款"));
 assert.ok(d.warnings.some(s=>s.includes("厂家款")));
});
test("明细 CSV 含会议编号及业务分类，不能导出其他会议记录",async()=>{
 const pid="MP-2026-015";
 const r=await request("admin","/api/project-ledger/"+pid+"/export");
 assert.equal(r.status,200);
 assert.match(r.headers.get("content-type")||"",/text\/csv/);
 assert.match(r.headers.get("content-disposition")||"",/MP-2026-015/);
 assert.ok(r.body.startsWith("\ufeff"));
 assert.ok(r.body.includes("会议编号"));
 assert.ok(r.body.includes(pid));
 assert.ok(!r.body.includes("MP-2026-006"));
 assert.ok(r.body.includes("合同")&&r.body.includes("付款")&&r.body.includes("结算"));
});
test("已存在会议编号在审批通过后不重新生成，避免资料关联断链",async()=>{
 const beforeState=await request("admin","/api/projects/MP-2026-005");
 assert.equal(beforeState.status,200);
 const pid=beforeState.body.project.id;
 assert.equal(pid,"MP-2026-005");
 assert.equal(beforeState.body.project.status,"待审批");
 const approved=await request("assoc","/api/approvals/AP-2026-014/decide","POST",{approve:true});
 assert.equal(approved.status,200);
 const afterState=await request("admin","/api/projects/"+pid);
 assert.equal(afterState.status,200);
 assert.equal(afterState.body.project.id,pid);
 assert.equal(afterState.body.project.status,"已立项");
 assert.equal((await request("admin","/api/project-ledger/"+pid)).body.meeting_no,pid);
});
test("不存在的会议编号不暴露数据",async()=>{
 const r=await request("admin","/api/project-ledger/MP-2099-999999");
 assert.equal(r.status,404);
});
