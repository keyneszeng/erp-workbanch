"use strict";
const {test,before,after}=require("node:test"),assert=require("node:assert/strict");
const {spawn}=require("node:child_process"),fs=require("node:fs"),os=require("node:os"),path=require("node:path");
const dir=fs.mkdtempSync(path.join(os.tmpdir(),"erp-income-test-")),port=14900+(process.pid%700),base="http://127.0.0.1:"+port;
let child,admin,exec;
async function request(method,url,body,cookie){
 const r=await fetch(base+url,{method,headers:{"Content-Type":"application/json",...(cookie?{Cookie:cookie}:{})},body:body===undefined?undefined:JSON.stringify(body)});
 return {status:r.status,data:await r.json(),cookie:(r.headers.get("set-cookie")||"").split(";")[0]};
}
async function login(name){const x=await request("POST","/api/auth/login",{username:name,password:"123456"});assert.equal(x.status,200,JSON.stringify(x.data));return x.cookie;}
const pdf=Buffer.from("%PDF-1.4\n1 0 obj\n<<>>\nendobj\n%%EOF");
async function upload(cookie,pid){
 const r=await fetch(base+"/api/uploads?pid="+encodeURIComponent(pid),{method:"POST",headers:{Cookie:cookie,"Content-Type":"application/octet-stream","X-File-Name":"sponsor.pdf"},body:pdf});
 const v=await r.json();assert.equal(r.status,200,JSON.stringify(v));return v.key;
}
before(async()=>{
 child=spawn(process.execPath,["--experimental-sqlite","server/index.js"],{cwd:path.resolve(__dirname,".."),stdio:["ignore","pipe","pipe"],env:{...process.env,ERP_DEMO_MODE:"1",ERP_PORT:String(port),ERP_HOST:"127.0.0.1",ERP_DB:path.join(dir,"data.db"),ERP_UPLOAD_DIR:path.join(dir,"uploads")}});
 let err="";child.stderr.on("data",s=>err+=s);
 // 慢盘上 Node 冷启动（含 pdf-lib 加载）可能超过 15 秒，窗口放到 40 秒；
 // 循环耗尽必须显式报错，否则会退化成一句无信息的 "fetch failed"。
 let ready=false;
 for(let i=0;i<400;i++){if(child.exitCode!==null)throw Error("Server failed: "+err);try{if((await request("GET","/api/health")).status===200){ready=true;break;}}catch{}await new Promise(r=>setTimeout(r,100));}
 if(!ready)throw Error("Server did not start in 40s: "+err);
 admin=await login("admin");exec=await login("exec");
});
after(()=>{child?.kill("SIGTERM");fs.rmSync(dir,{recursive:true,force:true});});
test("赞助合同/到账凭证/开票逐笔登记、授权与预算差额",async()=>{
 const p=await request("POST","/api/projects",{name:"赞助收入测试项目",assoc:"华东医学会",form:"线下",date:"2027-10-20",budget:10000,people:60,owner:"陈静",agenda:"学术会议"},exec);
 assert.equal(p.status,200,JSON.stringify(p.data));const pid=p.data.project.id;
 const initial=await request("GET","/api/projects/"+pid+"/income",undefined,admin);assert.equal(initial.status,200);assert.equal(initial.data.summary.budget,10000);
 const forbidden=await request("GET","/api/projects/"+pid+"/income");assert.equal(forbidden.status,401);
 const contractKey=await upload(exec,pid);
 const c=await request("POST","/api/projects/"+pid+"/income/contracts",{enterprise:"测试赞助企业",contractNo:"SP-2027-001",amount:10000,file_key:contractKey,file_name:"sponsor.pdf"},exec);
 assert.equal(c.status,200,JSON.stringify(c.data));
 assert.equal(c.data.summary.contracted,0);
 const over=await request("POST","/api/projects/"+pid+"/income/contracts/"+c.data.id+"/decide",{approve:true},exec);
 assert.equal(over.status,403,"execution role cannot approve sponsor contract");
 const approved=await request("POST","/api/projects/"+pid+"/income/contracts/"+c.data.id+"/decide",{approve:true},admin);
 assert.equal(approved.status,200,JSON.stringify(approved.data));
 assert.equal(approved.data.summary.contracted,10000);
 const another=await request("POST","/api/projects/"+pid+"/income/contracts",{enterprise:"另一赞助企业",contractNo:"SP-2027-002",amount:500,file_key:await upload(exec,pid)},exec);
 assert.equal(another.status,200);
 const excess=await request("POST","/api/projects/"+pid+"/income/contracts/"+another.data.id+"/decide",{approve:true},admin);
 assert.equal(excess.status,409,"赞助累计已超过预算应拒绝");
 const receiptKey=await upload(admin,pid);
 for(const invalidDate of ["2027-13-01", "2027-02-30", "not-a-date"]) {
   const rejected=await request("POST","/api/projects/"+pid+"/income/receipts",
     {sponsorId:c.data.id,amount:10000,paymentRef:"BANK20270001",receivedDate:invalidDate,file_key:receiptKey},admin);
   assert.equal(rejected.status,400,"无效到账日期须返回 400（而非 RangeError 500）: "+invalidDate+" "+JSON.stringify(rejected.data));
 }
 const rec=await request("POST","/api/projects/"+pid+"/income/receipts",
   {sponsorId:c.data.id,amount:10000,paymentRef:"BANK20270001",receivedDate:"2027-10-21",file_key:receiptKey},admin);
 assert.equal(rec.status,200,JSON.stringify(rec.data));
 assert.equal(rec.data.summary.received,10000);
 const invoiceKey=await upload(admin,pid);
 for(const invalidDate of ["2027-00-12", "2027-02-30", "2027-13-01"]) {
   const rejected=await request("POST","/api/projects/"+pid+"/income/invoices",
     {sponsorId:c.data.id,amount:10000,invoiceNo:"INV20270001",issuedDate:invalidDate,file_key:invoiceKey},admin);
   assert.equal(rejected.status,400,"无效开票日期须返回 400（而非 RangeError 500）: "+invalidDate+" "+JSON.stringify(rejected.data));
 }
 const inv=await request("POST","/api/projects/"+pid+"/income/invoices",
   {sponsorId:c.data.id,amount:10000,invoiceNo:"INV20270001",issuedDate:"2027-10-21",file_key:invoiceKey},admin);
 assert.equal(inv.status,200,JSON.stringify(inv.data));assert.equal(inv.data.summary.invoiced,10000);
 const state=await request("GET","/api/projects/"+pid+"/income",undefined,admin);
 assert.equal(state.data.summary.contractGap,0);assert.equal(state.data.summary.receiptGap,0);
 assert.equal(state.data.contracts.length,2);assert.equal(state.data.receipts.length,1);assert.equal(state.data.invoices.length,1);
 const dup=await request("POST","/api/projects/"+pid+"/income/invoices",{sponsorId:c.data.id,amount:1,invoiceNo:"INV20270001",issuedDate:"2027-10-21",file_key:await upload(admin,pid)},admin);
 assert.equal(dup.status,409);
});
