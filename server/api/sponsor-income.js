"use strict";
const {db}=require("../lib/db");
const {now,bad,conflict,notFound}=require("../lib/util");
const {getProject,assertNotFrozen}=require("../lib/workflow");
const {can,assertProjectVisible}=require("../lib/rbac");
const {assertUploadAttachable}=require("../lib/upload-ownership");
const {logAudit}=require("../lib/audit");
const KEY=/^[a-f0-9]{32}\.(?:jpg|png|webp|gif|pdf|ppt|docx|pptx|xlsx)$/;
function rows(pid){return db.prepare("SELECT * FROM sponsor_income WHERE pid=? ORDER BY id DESC").all(pid);}
function summary(pid,budget) {
 const list=rows(pid);
 const committed=Math.round(list.reduce((s,r)=>s+Number(r.amount||0),0)*100)/100;
 const received=Math.round(list.filter(r=>["已核验到账","已开票"].includes(r.status))
   .reduce((s,r)=>s+Number(r.amount||0),0)*100)/100;
 return {budget:Number(budget),committed,received,difference:Math.round((Number(budget)-committed)*100)/100,
   match:Math.round(committed*100)===Math.round(Number(budget)*100),
   receivedMatched:Math.round(received*100)===Math.round(Number(budget)*100)};
}
function checkFile(key,pid,user){
 if(!KEY.test(String(key||"")))throw bad("请上传有效的合同/付款凭证/发票原件");
 assertUploadAttachable(key,pid,user);
 return key;
}
function manage(ctx,p){
 assertProjectVisible(ctx.user,p);
 if(!can(ctx.user,"contract:write")&&!can(ctx.user,"payment:pay"))throw Object.assign(new Error("无权维护赞助收入"),{status:403,code:"FORBIDDEN"});
 assertNotFrozen(p,"企业赞助收入");
}
function register(router){
 router.get("/api/projects/:id/sponsor-income",async ctx=>{
   const p=getProject(ctx.params.id);assertProjectVisible(ctx.user,p);
   if(!can(ctx.user,"contract:write")&&!can(ctx.user,"payment:pay")&&!can(ctx.user,"verify:check"))
     throw Object.assign(new Error("无权查看赞助合同与付款资料"),{status:403,code:"FORBIDDEN"});
   return {rows:rows(p.id),summary:summary(p.id,p.budget)};
 });
 router.post("/api/projects/:id/sponsor-income",async ctx=>{
   const p=getProject(ctx.params.id);manage(ctx,p);
   const b=ctx.body||{};
   const company=String(b.company||"").trim(),amount=Number(b.amount);
   if(!company||company.length>100)throw bad("赞助企业名称须为 1～100 字");
   if(!Number.isFinite(amount)||amount<=0||amount>1e9||Number(amount.toFixed(2))!==amount)
     throw bad("赞助合同金额须为有效正数，最多两位小数");
   const contractKey=checkFile(b.contract_key,p.id,ctx.user);
   const at=now();
   const result=db.prepare("INSERT INTO sponsor_income(pid,company,amount,contract_key,status,created_by,created_at,updated_at) VALUES (?,?,?,?,'待收款',?,?,?)")
     .run(p.id,company,amount,contractKey,ctx.user.id,at,at);
   logAudit({user:ctx.user,module:"会议收入",action:"登记赞助合同",target:p.id,
     detail:"赞助企业："+company+"；金额："+amount+"；原件："+contractKey,ip:ctx.ip});
   return {entry:db.prepare("SELECT * FROM sponsor_income WHERE id=?").get(result.lastInsertRowid),
     summary:summary(p.id,p.budget)};
 });
 router.patch("/api/projects/:id/sponsor-income/:entryId",async ctx=>{
   const p=getProject(ctx.params.id);manage(ctx,p);
   if(!can(ctx.user,"payment:pay") && ctx.user.role!=="assoc" && ctx.user.role!=="admin")
     throw Object.assign(new Error("只有财务或协会管理员可确认入账与开票"),{status:403,code:"FORBIDDEN"});
   const entry=db.prepare("SELECT * FROM sponsor_income WHERE pid=? AND id=?").get(p.id,Number(ctx.params.entryId));
   if(!entry)throw notFound("企业赞助收入记录不存在");
   const b=ctx.body||{}, action=String(b.action||"");
   if(!["confirm-receipt","issue-invoice"].includes(action))throw bad("操作只能是确认到账或登记开票");
   let status,receiptKey=entry.receipt_key,invoiceKey=entry.invoice_key,invoiceNo=entry.invoice_no;
   if(action==="confirm-receipt"){
     if(entry.status!=="待收款")throw conflict("已经确认到账，不能重复操作","INCOME_STATE");
     receiptKey=checkFile(b.receipt_key,p.id,ctx.user);
     status="已核验到账";
   }else{
     if(entry.status!=="已核验到账")throw conflict("须先确认到账，再登记发票","INCOME_RECEIPT_REQUIRED");
     invoiceNo=String(b.invoice_no||"").trim();
     if(!invoiceNo||invoiceNo.length>70)throw bad("请输入有效发票号码");
     invoiceKey=checkFile(b.invoice_key,p.id,ctx.user);
     status="已开票";
   }
   db.prepare("UPDATE sponsor_income SET status=?,receipt_key=?,invoice_key=?,invoice_no=?,checked_by=?,updated_at=? WHERE id=?")
     .run(status,receiptKey,invoiceKey,invoiceNo,ctx.user.id,now(),entry.id);
   logAudit({user:ctx.user,module:"会议收入",action:action==="confirm-receipt"?"核验企业到账":"登记已开具发票",target:p.id,
     detail:"赞助记录 #"+entry.id+"；金额："+entry.amount+"；原件已登记",ip:ctx.ip});
   return {entry:db.prepare("SELECT * FROM sponsor_income WHERE id=?").get(entry.id),
     summary:summary(p.id,p.budget)};
 });
}
module.exports={register,summary};
