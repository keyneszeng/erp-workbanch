"use strict";
/** 同一笔有效付款申请不可重复，包含旧数据、驳回重报及并发双击。 */
const {test,before,after}=require("node:test");
const assert=require("node:assert/strict"),{spawn}=require("node:child_process");
const fs=require("node:fs"),os=require("node:os"),path=require("node:path");
const dir=fs.mkdtempSync(path.join(os.tmpdir(),"erp-pay-dedupe-"));
const port=8981,base="http://127.0.0.1:"+port,pid="MP-2026-008";
let processServer,cookie;
const bank="中国银行北京分行",account="3210987654321098";
async function call(method,url,body) {
 const r=await fetch(base+url,{method,headers:{cookie,"content-type":"application/json"},
   body:body===undefined?undefined:JSON.stringify(body)});
 return {status:r.status,data:await r.json()};
}
const payload=(payee,amount=101.11)=>({
 pid,type:"学会公付",payee,amount,payee_bank:bank,payee_account:account
});
const send=b=>call("POST","/api/payments",b);
before(async()=>{
 processServer=spawn(process.execPath,["--experimental-sqlite","server/index.js"],{
   cwd:path.join(__dirname,".."),env:{...process.env,ERP_DEMO_MODE:"1",
     ERP_PORT:String(port),ERP_DB:path.join(dir,"test.db"),ERP_UPLOAD_DIR:path.join(dir,"uploads")},
   stdio:["ignore","pipe","pipe"]
 });
 processServer.stderr.on("data",c=>{if(!String(c).includes("ExperimentalWarning"))process.stderr.write(c)});
 let ready=false;
 for(let i=0;i<400;i++){
   try{if((await fetch(base+"/api/health")).ok){ready=true;break;}}catch{}
   await new Promise(r=>setTimeout(r,150));
 }
 assert.equal(ready,true,"测试服务应启动");
 const r=await fetch(base+"/api/auth/login",{method:"POST",headers:{"content-type":"application/json"},
   body:JSON.stringify({username:"admin",password:"123456"})});
 assert.equal(r.status,200,"管理员登录");
 cookie=r.headers.get("set-cookie").split(";")[0];
});
after(()=>{processServer?.kill("SIGTERM");fs.rmSync(dir,{recursive:true,force:true});});
test("同笔无发票号付款仅允许一次，变更账号/备注/发票号也无法重复",async()=>{
 const input=payload(" 去重设备供应商 ",117.17);
 const first=await send(input);
 assert.equal(first.status,200,JSON.stringify(first.data));
 const duplicate=await send({...input,payee:"去重设备供应商",remark:"第二次提交",
   invoice_no:"ANOTHER-INVOICE",payee_account:"1234567890123456"});
 assert.equal(duplicate.status,409,JSON.stringify(duplicate.data));
 assert.equal(duplicate.data.error.code,"DUPLICATE_PAYMENT");
 assert.equal(duplicate.data.error.detail?.payment,first.data.payment.id);
 const list=await call("GET","/api/payments?pid="+pid);
 assert.equal(list.data.rows.filter(x=>x.payee.includes("去重设备供应商")).length,1);
});
test("已审批、已付款以及管理员 force 都不能重复请款",async()=>{
 const input=payload("不可二次申请供应商",119.19);
 const first=await send(input);assert.equal(first.status,200);
 const id=first.data.payment.id;
 const approved=await call("POST","/api/payments/"+id+"/approve",{approve:true});
 assert.equal(approved.status,200,JSON.stringify(approved.data));
 let duplicate=await send(input);
 assert.equal(duplicate.status,409);
 assert.equal(duplicate.data.error.code,"DUPLICATE_PAYMENT");
 const paid=await call("POST","/api/payments/"+id+"/pay",{});
 assert.equal(paid.status,200,JSON.stringify(paid.data));
 duplicate=await send({...input,force:true});
 assert.equal(duplicate.status,409);
 assert.equal(duplicate.data.error.code,"DUPLICATE_PAYMENT");
});
test("被驳回付款可纠正重报，重报后仍不许再重复",async()=>{
 const input=payload("驳回重报供应商",123.23);
 const first=await send(input);assert.equal(first.status,200);
 const rejected=await call("POST","/api/payments/"+first.data.payment.id+"/approve",{approve:false});
 assert.equal(rejected.status,200,JSON.stringify(rejected.data));
 const again=await send(input);assert.equal(again.status,200,JSON.stringify(again.data));
 assert.notEqual(first.data.payment.id,again.data.payment.id);
 const duplicate=await send(input);
 assert.equal(duplicate.status,409);
 assert.equal(duplicate.data.error.code,"DUPLICATE_PAYMENT");
});
test("金额、付款类型或收款方不同属于其他付款，可正常申请",async()=>{
 const input=payload("正常分笔供应商",105.15);
 for(const entry of [input,{...input,amount:105.16},{...input,type:"个人报销"},{...input,payee:"另一收款方"}]){
  const r=await send(entry);assert.equal(r.status,200,JSON.stringify(r.data));
 }
});
test("五个请求并行提交同笔只产生一个付款单和审批单",async()=>{
 const input=payload("多窗口双击提交供应商",127.27);
 const all=await Promise.all(Array.from({length:5},()=>send(input)));
 assert.equal(all.filter(x=>x.status===200).length,1,JSON.stringify(all));
 assert.equal(all.filter(x=>x.status===409&&x.data.error?.code==="DUPLICATE_PAYMENT").length,4);
 const id=all.find(x=>x.status===200).data.payment.id;
 const approvals=await call("GET","/api/approvals");
 assert.equal(approvals.status,200,JSON.stringify(approvals.data));
 assert.equal(approvals.data.rows.filter(x=>x.type==="付款审批"&&x.ref_id===id).length,1);
});
test("历史已付款记录无 dedupe_key 时也能阻止重复",async()=>{
 const r=await send({...payload("周涛",3600),type:"个人报销"});
 assert.equal(r.status,409,JSON.stringify(r.data));
 assert.equal(r.data.error.code,"DUPLICATE_PAYMENT");
});
