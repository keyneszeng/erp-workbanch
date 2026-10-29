"use strict";
/** 线上只读回归：项目台账必须只允许总管理员，按唯一会议编号关联财务记录。 */
const assert=require("node:assert/strict");
const BASE=process.env.ERP_BASE||"https://erp.aibuild.work";
async function login(username){
 const r=await fetch(BASE+"/api/auth/login",{method:"POST",
  headers:{"Content-Type":"application/json"},
  body:JSON.stringify({username,password:"123456"})});
 assert.equal(r.status,200,username+" demo login");
 return (r.headers.get("set-cookie")||"").split(";")[0];
}
async function get(cookie,path){return fetch(BASE+path,{headers:cookie?{Cookie:cookie}:undefined,cache:"no-store"});}
(async()=>{
 const cookies={};
 for(const u of ["admin","assoc","exec","finance","guest"])cookies[u]=await login(u);
 console.log("PASS five demo accounts login");
 const list=await get(cookies.admin,"/api/project-ledger?q=MP-2026-019");
 assert.equal(list.status,200,"admin ledger list");const data=await list.json();
 assert.ok(data.rows?.some(x=>x.meeting_no==="MP-2026-019"),"archived demo meeting not in ledger");
 console.log("PASS ledger list contains canonical meeting number");
 const pid=data.rows[0].meeting_no;
 const detail=await get(cookies.admin,"/api/project-ledger/"+pid);
 assert.equal(detail.status,200);const d=await detail.json();
 assert.equal(d.meeting_no,pid);
 assert.ok(d.payments.every(x=>x.pid===pid));
 assert.ok(d.contracts.every(x=>x.pid===pid));
 assert.ok(d.financial_materials.every(x=>x.pid===pid));
 console.log("PASS ledger source records by same meeting number",pid);
 const exportUrl="/api/project-ledger/"+pid+"/export";
 const exported=await get(cookies.admin,exportUrl);
 assert.equal(exported.status,200);
 assert.match(exported.headers.get("content-type")||"",/text\/csv/);
 assert.ok((await exported.text()).includes(pid));
 console.log("PASS ledger CSV export for super admin");
 for(const role of ["assoc","exec","finance","guest"]){
  for(const url of ["/api/project-ledger","/api/project-ledger/"+pid,exportUrl]){
   const r=await get(cookies[role],url);
   assert.equal(r.status,403,role+" must not read "+url);
  }
  console.log("PASS deny non-admin ledger",role);
 }
 assert.equal((await get("",exportUrl)).status,401,"anonymous export must be denied");
 console.log("PROJECT_LEDGER_LIVE_PASS");
})().catch(e=>{console.error("PROJECT_LEDGER_LIVE_FAIL",e.stack||e.message);process.exitCode=1});
