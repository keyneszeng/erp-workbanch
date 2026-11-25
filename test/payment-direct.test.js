"use strict";
/** Authorized direct payment without an application; real transfer receipt is mandatory. */
const {test,before,after}=require("node:test");
const assert=require("node:assert/strict");
const {spawn}=require("node:child_process"),fs=require("node:fs"),os=require("node:os"),path=require("node:path");
const dir=fs.mkdtempSync(path.join(os.tmpdir(),"erp-direct-pay-"));
const port=8999,base="http://127.0.0.1:"+port,pid="MP-2026-008";
const PDF=Buffer.from("%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n");
let server,finance="",admin="",exec="",guest="",completedId="";
async function auth(username,password="123456"){
 const r=await fetch(base+"/api/auth/login",{method:"POST",headers:{"content-type":"application/json"},
 body:JSON.stringify({username,password})});
 assert.equal(r.status,200,username+" login");
 return r.headers.get("set-cookie").split(";")[0];
}
async function call(cookie,method,url,body){
 const r=await fetch(base+url,{method,headers:{cookie,...(body===undefined?{}:{"content-type":"application/json"})},
 body:body===undefined?undefined:JSON.stringify(body)});
 return {status:r.status,data:await r.json()};
}
async function upload(cookie,projectId=pid){
 const r=await fetch(base+"/api/uploads?pid="+projectId,{method:"POST",headers:{
  cookie,"content-type":"application/pdf","x-file-name":encodeURIComponent("付款回单.pdf")},body:PDF});
 return {status:r.status,data:await r.json()};
}
const body=()=>({pid,type:"学会公付",payee:"财务直付专项供应商",amount:93.33,
 payee_bank:"中国银行北京分行",payee_account:"3210987654321098",confirm_paid:true});
before(async()=>{
 server=spawn(process.execPath,["--experimental-sqlite","server/index.js"],{
 cwd:path.join(__dirname,".."),env:{...process.env,ERP_DEMO_MODE:"1",ERP_PORT:String(port),
 ERP_DB:path.join(dir,"erp.db"),ERP_UPLOAD_DIR:path.join(dir,"uploads")},
 stdio:["ignore","pipe","pipe"]});
 server.stderr.on("data",d=>{if(!String(d).includes("ExperimentalWarning"))process.stderr.write(d)});
 let ready=false;
 for(let i=0;i<300;i++){
  try{if((await fetch(base+"/api/health")).ok){ready=true;break;}}catch{}
  await new Promise(r=>setTimeout(r,120));
 }
 assert.ok(ready,"ERP server starts");
 [finance,admin,exec,guest]=await Promise.all(["finance","admin","exec","guest"].map(u=>auth(u)));
});
after(()=>{server?.kill("SIGTERM");fs.rmSync(dir,{recursive:true,force:true});});
test("有付款权限的财务人员能上传付款凭证；无付款权限的账号不能直接付款",async()=>{
 const f=await upload(finance);
 assert.equal(f.status,200,JSON.stringify(f.data));
 const no=await call(exec,"POST","/api/payments/direct",{
  ...body(),receipt_file_key:f.data.key,receipt_file_name:f.data.name});
 assert.equal(no.status,403,JSON.stringify(no.data));
 const guestResponse=await call(guest,"POST","/api/payments/direct",{...body(),receipt_file_key:f.data.key});
 assert.equal(guestResponse.status,403);
});
test("核销前、归档、未勾选或无凭证不得直接登记已付款",async()=>{
 const voucher=await upload(finance);
 assert.equal(voucher.status,200);
 let result=await call(finance,"POST","/api/payments/direct",{
  ...body(),receipt_file_key:voucher.data.key,confirm_paid:false});
 assert.equal(result.status,400);
 result=await call(finance,"POST","/api/payments/direct",body());
 assert.equal(result.status,400);
 const archived=await call(admin,"POST","/api/payments/direct",{
  ...body(),pid:"MP-2026-015",receipt_file_key:voucher.data.key});
 assert.equal(archived.status,409,JSON.stringify(archived.data));
 assert.equal(archived.data.error.code,"ARCHIVED");
});
test("财务可免申请免审批，付款记录与凭证原子保存；结余计入已付款",async()=>{
 const before=await call(admin,"GET","/api/payments?pid="+pid);
 const approvalBefore=await call(admin,"GET","/api/approvals?type=付款审批");
 const voucher=await upload(finance);
 assert.equal(voucher.status,200);
 const result=await call(finance,"POST","/api/payments/direct",{
  ...body(),receipt_file_key:voucher.data.key,receipt_file_name:voucher.data.name});
 assert.equal(result.status,200,JSON.stringify(result.data));
 completedId=result.data.payment.id;
 assert.equal(result.data.payment.status,"已付款");
 assert.equal(result.data.payment.receipt_file_key,voucher.data.key);
 assert.ok(result.data.payment.paid_at);
 const afterPayments=await call(admin,"GET","/api/payments?pid="+pid);
 const row=afterPayments.data.rows.find(y=>y.id===completedId);
 assert.equal(row.receipt_file_key,voucher.data.key);
 assert.equal(row.status,"已付款");
 assert.equal(Number((afterPayments.data.summary.paidAmount-before.data.summary.paidAmount).toFixed(2)),93.33);
 const afterApprovals=await call(admin,"GET","/api/approvals?type=付款审批");
 assert.equal(afterApprovals.data.rows.length,approvalBefore.data.rows.length,
  "直接付款不生成待审批单");
 const download=await fetch(base+"/api/uploads/"+voucher.data.key,{headers:{cookie:finance}});
 assert.equal(download.status,200);
 assert.deepEqual(Buffer.from(await download.arrayBuffer()),PDF);
 const denied=await fetch(base+"/api/uploads/"+voucher.data.key,{headers:{cookie:exec}});
 assert.equal(denied.status,403,"即使执行人员可查看普通材料，也不能下载付款回单");
});
test("相同付款不能重复；换期次才可作为另一个付款事项",async()=>{
 const upload2=await upload(admin);
 const duplicate=await call(admin,"POST","/api/payments/direct",{
  ...body(),receipt_file_key:upload2.data.key});
 assert.equal(duplicate.status,409,JSON.stringify(duplicate.data));
 assert.equal(duplicate.data.error.code,"DUPLICATE_PAYMENT");
 assert.equal(duplicate.data.error.detail?.payment,completedId);
});
test("历史已付款记录可补传缺失的凭证，已有凭证不可覆盖",async()=>{
 const current=await call(admin,"GET","/api/payments?pid="+pid);
 const legacy=current.data.rows.find(x=>x.status==="已付款"&&!x.receipt_file_key);
 assert.ok(legacy,"演示数据中存在尚无回单的历史已付款记录");
 const voucher=await upload(finance);
 const result=await call(finance,"POST","/api/payments/"+legacy.id+"/receipt",{
  file_key:voucher.data.key,file_name:voucher.data.name});
 assert.equal(result.status,200,JSON.stringify(result.data));
 assert.equal(result.data.receipt.file_key,voucher.data.key);
 const second=await upload(finance);
 const reject=await call(finance,"POST","/api/payments/"+legacy.id+"/receipt",{
  file_key:second.data.key,file_name:second.data.name});
 assert.equal(reject.status,409);
 assert.equal(reject.data.error.code,"PAYMENT_RECEIPT_EXISTS");
});
test("普通申请流程保持可用，已审批付款可同时上传凭证后标记已付款",async()=>{
 const proposed=await call(admin,"POST","/api/payments",{
  pid,type:"学会公付",payee:"待审批历史供应商-附回单",amount:57.19});
 assert.equal(proposed.status,200,JSON.stringify(proposed.data));
 const id=proposed.data.payment.id;
 assert.equal((await call(admin,"POST","/api/payments/"+id+"/approve",{approve:true})).status,200);
 assert.equal((await call(finance,"PATCH","/api/payments/"+id+"/account",{
  payee_bank:"中国银行北京分行",payee_account:"3210987654321098"})).status,200);
 const receipt=await upload(finance);
 const paid=await call(finance,"POST","/api/payments/"+id+"/pay",{
  receipt_file_key:receipt.data.key,receipt_file_name:receipt.data.name
 });
 assert.equal(paid.status,200,JSON.stringify(paid.data));
 assert.equal(paid.data.payment.receipt_file_key,receipt.data.key);
});

test("非财务岗位获得付款执行权限即可直接付款，核销前置与结算权限不变",async()=>{
 const project=await call(admin,"GET","/api/projects/"+pid);
 assert.equal(project.status,200);
 const assoc=project.data.project.assoc;
 const created=await call(admin,"POST","/api/users",{
  username:"qa_granted_pay",name:"测试付款授权",role:"assoc",assoc,assocs:[assoc],
  dept:"非供应商",phone:"13800009776",password:"SecureDemo2026!"
 });
 assert.equal(created.status,200,JSON.stringify(created.data));
 const id=created.data.user.id;
 let actor=await auth("qa_granted_pay","SecureDemo2026!");
 const denied=await call(actor,"POST","/api/payments/direct",body());
 assert.equal(denied.status,403);
 const grant=await call(admin,"PATCH","/api/users/"+id+"/access",{modules:[],permissions:["payment:pay"]});
 assert.equal(grant.status,200,JSON.stringify(grant.data));
 actor=await auth("qa_granted_pay","SecureDemo2026!");
 const list=await call(actor,"GET","/api/payments?pid="+pid);
 assert.equal(list.status,200,JSON.stringify(list.data));
 assert.equal((await call(actor,"GET","/api/settlements")).status,403,"付款权限不授予结算模块");
 const voucher=await upload(actor);
 assert.equal(voucher.status,200,JSON.stringify(voucher.data));
 const direct=await call(actor,"POST","/api/payments/direct",{
  ...body(),payee:"授权非财务岗位测试供应商",amount:12.34,receipt_file_key:voucher.data.key,receipt_file_name:voucher.data.name
 });
 assert.equal(direct.status,200,JSON.stringify(direct.data));
 assert.equal(direct.data.payment.status,"已付款");
 const revoke=await call(admin,"PATCH","/api/users/"+id+"/access",{modules:[],permissions:[]});
 assert.equal(revoke.status,200);
 actor=await auth("qa_granted_pay","SecureDemo2026!");
 assert.equal((await call(actor,"POST","/api/payments/direct",body())).status,403);
});

test("已审批付款明细可直接确认，无需录入银行账号；凭证随后独立上传",async()=>{
 const made=await call(admin,"POST","/api/payments",{pid,type:"学会公付",payee:"逐行确认测试收款方",amount:16.18});
 assert.equal(made.status,200,JSON.stringify(made.data));
 const id=made.data.payment.id;
 assert.equal((await call(admin,"POST","/api/payments/"+id+"/approve",{approve:true})).status,200);
 assert.equal((await call(exec,"POST","/api/payments/"+id+"/pay",{confirm_paid:true})).status,403);
 const paid=await call(finance,"POST","/api/payments/"+id+"/pay",{confirm_paid:true});
 assert.equal(paid.status,200,JSON.stringify(paid.data));
 assert.equal(paid.data.payment.status,"已付款");
 assert.equal(paid.data.payment.receipt_file_key,null);
 assert.equal((await call(finance,"POST","/api/payments/"+id+"/pay",{confirm_paid:true})).status,409);
 const voucher=await upload(finance);
 assert.equal(voucher.status,200);
 const result=await call(finance,"POST","/api/payments/"+id+"/receipt",{file_key:voucher.data.key,file_name:voucher.data.name});
 assert.equal(result.status,200,JSON.stringify(result.data));
});

test("具有付款执行权限的财务可超会议预算付款，无需总管理员特批",async()=>{
 const project=await call(admin,"GET","/api/projects/"+pid);
 assert.equal(project.status,200);
 const budget=Number(project.data.project.budget);
 const receipt=await upload(finance);
 assert.equal(receipt.status,200);
 const amount=budget+100;
 const paid=await call(finance,"POST","/api/payments/direct",{
  ...body(),payee:"超预算付款专项测试供应商",amount,receipt_file_key:receipt.data.key,receipt_file_name:receipt.data.name
 });
 assert.equal(paid.status,200,JSON.stringify(paid.data));
 assert.equal(paid.data.payment.status,"已付款");
 assert.equal(paid.data.payment.amount,amount);
 const detail=await call(admin,"GET","/api/projects/"+pid);
 assert.equal(Number(detail.data.project.budget),budget,"原会议预算不随付款自动修改");
});
