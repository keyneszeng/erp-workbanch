"use strict";
/** 结算单四项财务指标和四类展开明细：金额精确、状态排除、兼容历史、权限保护。 */
const {test,before,after}=require("node:test");
const assert=require("node:assert/strict");
const {spawn}=require("node:child_process");
const fs=require("node:fs"),os=require("node:os"),path=require("node:path");
const {buildSettlementBreakdown,groupForType}=require("../server/lib/settlement-breakdown");
const dir=fs.mkdtempSync(path.join(os.tmpdir(),"erp-settle-detail-"));
const port=8985,base="http://127.0.0.1:"+port;
let proc,adminCookie,guestCookie;
const invoice=(type,amount,status="已付款",id="PY-TEST")=>({
 id,pid:"MP-X",type,payee:"供应商",amount,status,paid_at:"2026-11-07",
 req_user:"财务",payee_bank:"中国银行",payee_account:"6222029999000012345"
});
test("旧付款类型归四块；待审批/已审批/驳回不计入已支付且无敏感完整账号",()=>{
 const st={id:"ST-X",pid:"MP-X",income:1000,expense:316.58,tax_fee_rate:10};
 const pr={tax_fee_rate:80};
 const payments=[
   invoice("专家费",100.01,"已付款","PY-A"),
   invoice("学会公付",200.02,"已付款","PY-B"),
   invoice("个人报销",3.33,"已付款","PY-C"),
   invoice("协会报销",2.22,"已付款","PY-D"),
   invoice("厂家款",1.01,"已付款","PY-E"),
   invoice("其他历史类型",9.99,"已付款","PY-F"),
   invoice("专家费",999,"已审批","PY-G"),
   invoice("专家费",999,"待审批","PY-H"),
   invoice("专家费",999,"已驳回","PY-I")
 ];
 const r=buildSettlementBreakdown(st,pr,payments);
 assert.deepEqual(r.groups.map(x=>x.label),["劳务","会务","协会报销","其他"]);
 assert.deepEqual(r.groups.map(x=>x.count),[1,1,2,2]);
 assert.deepEqual(r.groups.map(x=>x.amount),[100.01,200.02,5.55,11]);
 assert.equal(r.summary.budget,1000);
 assert.equal(r.summary.tax_fee_rate,10,"创建结算时费率快照不可受后续项目修改影响");
 assert.equal(r.summary.available_budget,900);
 assert.equal(r.summary.paid,316.58);
 assert.equal(r.summary.balance,583.42);
 assert.equal(r.summary.payment_count,6);
 assert.equal(r.reconciliation,null);
 assert.equal(r.groups[0].items[0].account_tail,"2345");
 assert.equal("payee_account" in r.groups[0].items[0],false);
 assert.equal(groupForType("新类型"),"other");
});
test("历史结算兼容0%默认费率，支出与明细不符时明确提示",()=>{
 const r=buildSettlementBreakdown({id:"ST-OLD",pid:"MP-X",income:100,expense:90,tax_fee_rate:null},
 {budget:100,tax_fee_rate:0},[invoice("专家费",50)]);
 assert.equal(r.summary.available_budget,100);
 assert.equal(r.summary.paid,50);
 assert.equal(r.summary.balance,50);
 assert.equal(r.reconciliation.original_expense,90);
 assert.equal(r.reconciliation.paid_from_payments,50);
});
async function login(username){
 const r=await fetch(base+"/api/auth/login",{method:"POST",headers:{"content-type":"application/json"},
 body:JSON.stringify({username,password:"123456"})});
 assert.equal(r.status,200,username+" login failed");
 return r.headers.get("set-cookie").split(";")[0];
}
async function req(cookie,method,url,body){
 const r=await fetch(base+url,{method,headers:{cookie,"content-type":"application/json"},
 body:body===undefined?undefined:JSON.stringify(body)});
 return {status:r.status,data:await r.json()};
}
before(async()=>{
 proc=spawn(process.execPath,["--experimental-sqlite","server/index.js"],{
   cwd:path.resolve(__dirname,".."),
   env:{...process.env,ERP_DEMO_MODE:"1",ERP_PORT:String(port),
     ERP_DB:path.join(dir,"test.db"),ERP_UPLOAD_DIR:path.join(dir,"uploads")},
   stdio:["ignore","pipe","pipe"]});
 let err="";proc.stderr.on("data",c=>err+=String(c));
 let ready=false;
 for(let i=0;i<480;i++){try{if((await fetch(base+"/api/health")).ok){ready=true;break;}}catch{}
  if(proc.exitCode!==null)throw Error("server died "+err);
  await new Promise(r=>setTimeout(r,125));}
 assert.ok(ready,"server must start "+err);
 adminCookie=await login("admin");
 guestCookie=await login("guest");
});
after(()=>{proc?.kill("SIGTERM");fs.rmSync(dir,{recursive:true,force:true});});
test("结算列表点击详情的API四项汇总必须与该项目已付款记录逐笔对齐",async()=>{
 const all=await req(adminCookie,"GET","/api/settlements");
 assert.equal(all.status,200,JSON.stringify(all.data));
 assert.ok(all.data.rows.length>0);
 const st=all.data.rows[0];
 const r=await req(adminCookie,"GET","/api/settlements/"+encodeURIComponent(st.id)+"/breakdown");
 assert.equal(r.status,200,JSON.stringify(r.data));
 assert.equal(r.data.id,st.id);
 assert.deepEqual(r.data.groups.map(x=>x.key),["labor","meeting","association","other"]);
 const payments=await req(adminCookie,"GET","/api/payments?pid="+encodeURIComponent(st.pid));
 assert.equal(payments.status,200);
 const realPaid=payments.data.rows.filter(y=>y.status==="已付款");
 assert.equal(r.data.summary.payment_count,realPaid.length);
 assert.equal(Math.round(r.data.summary.paid*100),realPaid.reduce((s,x)=>s+Math.round(x.amount*100),0));
 assert.equal(Math.round(r.data.summary.paid*100),
  r.data.groups.reduce((s,x)=>s+Math.round(x.amount*100),0));
 const detail=await req(adminCookie,"GET","/api/projects/"+st.pid);
 assert.equal(detail.status,200);
 assert.deepEqual(detail.data.settlementBreakdown,r.data,"项目付款页与财务结算页应共用统一分类口径");
});
test("无权角色不能绕过财务模块权限直接读取结算单明细",async()=>{
 const list=await req(adminCookie,"GET","/api/settlements");
 const id=list.data.rows[0].id;
 const forbidden=await req(guestCookie,"GET","/api/settlements/"+encodeURIComponent(id)+"/breakdown");
 assert.equal(forbidden.status,403,JSON.stringify(forbidden.data));
 assert.equal(forbidden.data.error.code,"FORBIDDEN");
 const missing=await req(adminCookie,"GET","/api/settlements/ST-NOT-FOUND/breakdown");
 assert.equal(missing.status,404);
});

test("四分类付款明细在结算单小板块默认展开，零记录板块不默认展开",()=>{
 const fs=require("node:fs"),path=require("node:path");
 const source=fs.readFileSync(path.join(__dirname,"../web/assets/js/lib/settlement-breakdown.js"),"utf8");
 assert.match(source,/\[\["预算",s\.budget\],\["可用预算",s\.available_budget\],\["已支付",s\.paid\],\["结余",s\.balance\]\]/);
 assert.ok(source.includes("(rows.length?' open':'')"));
 assert.match(source,/sg-rows/);
 assert.match(source,/data-settlement-group/);
 assert.match(source,/可展开或收起/);
 const groups=buildSettlementBreakdown(
   {id:"ST-LINES",pid:"MP-X",income:1000,expense:50,tax_fee_rate:0},
   {tax_fee_rate:0},[invoice("专家费",50)]
 ).groups;
 assert.deepEqual(groups.map(x=>x.label),["劳务","会务","协会报销","其他"]);
 assert.equal(groups[0].items[0].amount,50);
 assert.ok(groups.slice(1).every(x=>x.items.length===0));
});
