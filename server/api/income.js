"use strict";
/** 赞助收入与会务支出严格分账。原件、银行回单和开票证据分别归档。 */
const {db}=require("../lib/db");
const {now,nextId,bad,conflict,notFound,cents}=require("../lib/util");
const {getProject,assertNotFrozen}=require("../lib/workflow");
const {assertProjectVisible,assertCan,assertModule,isSuper,can}=require("../lib/rbac");
const {assertUploadAttachable}=require("../lib/upload-ownership");
const {logAudit}=require("../lib/audit");
const {isDemoMode}=require("../lib/runtime");

const KEY=/^[a-f0-9]{32}\.(jpg|png|webp|gif|pdf|ppt|docx|pptx|xlsx)$/;
function amount(v) {
  const n=Number(v);
  if(!Number.isFinite(n)||n<=0||n>1e9||Math.round(n*100)/100!==n)
    throw bad("金额必须大于 0，最多保留两位小数");
  return n;
}
function stamp(s,label) {
  const v=String(s||"").trim();
  const d = /^\d{4}-\d{2}-\d{2}$/.test(v) ? Date.parse(v+"T00:00:00Z") : NaN;
  if(!Number.isFinite(d) || new Date(d).toISOString().slice(0,10)!==v)
    throw bad(label+"须为有效 YYYY-MM-DD 日期");
  return v;
}
function evidence(ctx,p,key) {
  const k=String(key||"");
  if(!KEY.test(k))throw bad("必须先上传有效的原件 PDF / 图片 / Office 附件");
  assertUploadAttachable(k,p.id,ctx.user);
  return k;
}
function sponsor(pid,id) {
  const s=db.prepare("SELECT * FROM meeting_sponsor_contracts WHERE id=? AND pid=?").get(id,pid);
  if(!s)throw notFound("企业赞助合同不存在或不属于当前项目");
  return s;
}
function incomeSummary(pid,budget) {
  const contracted=db.prepare("SELECT COALESCE(SUM(amount),0) AS n FROM meeting_sponsor_contracts WHERE pid=? AND status='已签署'").get(pid).n;
  const pending=db.prepare("SELECT COALESCE(SUM(amount),0) AS n FROM meeting_sponsor_contracts WHERE pid=? AND status='待确认'").get(pid).n;
  const received=db.prepare("SELECT COALESCE(SUM(amount),0) AS n FROM meeting_sponsor_receipts WHERE pid=?").get(pid).n;
  const invoiced=db.prepare("SELECT COALESCE(SUM(amount),0) AS n FROM meeting_sponsor_invoices WHERE pid=?").get(pid).n;
  return {budget:Number(budget),contracted:Number(contracted),pending:Number(pending),
    received:Number(received),invoiced:Number(invoiced),
    contractGap:(cents(budget)-cents(contracted))/100,
    receiptGap:(cents(budget)-cents(received))/100,
    contractedMatchesBudget:cents(budget)===cents(contracted),
    receiptsMatchBudget:cents(budget)===cents(received)};
}
function writable(ctx,p,perm){
  assertProjectVisible(ctx.user,p);
  assertCan(ctx.user,perm);
  assertNotFrozen(p,"会议赞助收入");
  if(p.status==="已核销")throw conflict("项目已核销，收入凭证冻结，须先办理核销更正","INCOME_FROZEN");
}
function register(router){
  router.get("/api/projects/:id/income",async ctx=>{
    const p=getProject(ctx.params.id);
    assertProjectVisible(ctx.user,p);
    if(!can(ctx.user,"contract:write")&&!can(ctx.user,"contract:approve")&&
       !can(ctx.user,"payment:pay")&&!can(ctx.user,"payment:approve"))
      throw require("../lib/util").forbidden("无权查看赞助合同与财务回款");
    return {pid:p.id,summary:incomeSummary(p.id,p.budget),
      contracts:db.prepare("SELECT * FROM meeting_sponsor_contracts WHERE pid=? ORDER BY created_at DESC").all(p.id),
      receipts:db.prepare("SELECT * FROM meeting_sponsor_receipts WHERE pid=? ORDER BY created_at DESC").all(p.id),
      invoices:db.prepare("SELECT * FROM meeting_sponsor_invoices WHERE pid=? ORDER BY created_at DESC").all(p.id)};
  });
  router.post("/api/projects/:id/income/contracts",async ctx=>{
    const p=getProject(ctx.params.id);writable(ctx,p,"contract:write");
    const b=ctx.body||{};
    const enterprise=String(b.enterprise||"").trim(),contractNo=String(b.contractNo||"").trim();
    if(enterprise.length<2||enterprise.length>100||contractNo.length<2||contractNo.length>80)
      throw bad("请填写企业名称与赞助合同编号（2～100 字）");
    const total=amount(b.amount);
    const key=evidence(ctx,p,b.file_key);
    const id=nextId(db,"meeting_sponsor_contracts","id","SC");
    db.prepare("INSERT INTO meeting_sponsor_contracts(id,pid,enterprise,contract_no,amount,status,file_key,file_name,created_by,created_at) VALUES (?,?,?,?,?,'待确认',?,?,?,?)")
      .run(id,p.id,enterprise,contractNo,total,key,String(b.file_name||"").slice(0,120),ctx.user.id,now());
    logAudit({user:ctx.user,module:"会议收入",action:"登记赞助合同",target:p.id,
      detail:id+"；企业："+enterprise+"；合同金额："+total,ip:ctx.ip});
    return {id,status:"待确认",summary:incomeSummary(p.id,p.budget)};
  });
  router.post("/api/projects/:id/income/contracts/:cid/decide",async ctx=>{
    const p=getProject(ctx.params.id);writable(ctx,p,"contract:approve");
    const s=sponsor(p.id,ctx.params.cid);
    if(s.status!=="待确认")throw conflict("赞助合同不在待确认状态","INCOME_CONTRACT_LOCKED");
    const approve=ctx.body?.approve;
    if(typeof approve!=="boolean")throw bad("必须明确提交审批通过或驳回");
    if(!approve && String(ctx.body?.reason||"").trim().length<4)throw bad("驳回理由至少 4 字");
    if(approve){
      if(!isDemoMode()&&!isSuper(ctx.user)&&Number(s.created_by)===Number(ctx.user.id))
        throw conflict("赞助合同录入人与审批人须分离","NEED_SECOND_PERSON");
      const summary=incomeSummary(p.id,p.budget);
      if(cents(summary.contracted)+cents(s.amount)>cents(p.budget))
        throw conflict("已签赞助合同累计金额不能高于会议预算，请先调整赞助方案","SPONSOR_BUDGET_EXCEEDED");
    }
    const status=approve?"已签署":"已驳回";
    db.prepare("UPDATE meeting_sponsor_contracts SET status=?,approved_by=?,approved_at=? WHERE id=?")
      .run(status,ctx.user.id,now(),s.id);
    logAudit({user:ctx.user,module:"会议收入",action:approve?"确认赞助合同":"驳回赞助合同",target:p.id,
      detail:s.id+(approve?"；预算核对通过":"；原因："+String(ctx.body.reason).trim()),ip:ctx.ip});
    return {id:s.id,status,summary:incomeSummary(p.id,p.budget)};
  });
  router.post("/api/projects/:id/income/receipts",async ctx=>{
    const p=getProject(ctx.params.id);writable(ctx,p,"payment:pay");
    const b=ctx.body||{},s=sponsor(p.id,String(b.sponsorId||""));
    if(s.status!=="已签署")throw conflict("需先确认赞助合同签署","SPONSOR_NOT_SIGNED");
    const n=amount(b.amount),ref=String(b.paymentRef||"").trim();
    if(ref.length<3||ref.length>100)throw bad("银行回款流水号不能为空");
    const received=db.prepare("SELECT COALESCE(SUM(amount),0) AS n FROM meeting_sponsor_receipts WHERE sponsor_id=?").get(s.id).n;
    if(cents(received)+cents(n)>cents(s.amount))throw conflict("累计回款不能超过该企业签署的赞助金额","INCOME_OVERPAID");
    const key=evidence(ctx,p,b.file_key),date=stamp(b.receivedDate,"到账日期");
    const id=nextId(db,"meeting_sponsor_receipts","id","RC");
    db.prepare("INSERT INTO meeting_sponsor_receipts(id,pid,sponsor_id,amount,payment_ref,received_date,file_key,file_name,created_by,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)")
      .run(id,p.id,s.id,n,ref,date,key,String(b.file_name||"").slice(0,120),ctx.user.id,now());
    logAudit({user:ctx.user,module:"会议收入",action:"登记赞助回款",target:p.id,
      detail:id+"；合同："+s.id+"；金额："+n+"；银行凭证已关联",ip:ctx.ip});
    return {id,summary:incomeSummary(p.id,p.budget)};
  });
  router.post("/api/projects/:id/income/invoices",async ctx=>{
    const p=getProject(ctx.params.id);writable(ctx,p,"payment:pay");
    const b=ctx.body||{},s=sponsor(p.id,String(b.sponsorId||""));
    if(s.status!=="已签署")throw conflict("需先确认赞助合同签署","SPONSOR_NOT_SIGNED");
    const n=amount(b.amount),invoiceNo=String(b.invoiceNo||"").trim();
    if(!/^[\w\-]{6,50}$/.test(invoiceNo))throw bad("开票号码格式不正确");
    const invoiced=db.prepare("SELECT COALESCE(SUM(amount),0) AS n FROM meeting_sponsor_invoices WHERE sponsor_id=?").get(s.id).n;
    if(cents(invoiced)+cents(n)>cents(s.amount))throw conflict("累计开票不能超过合同赞助金额","INVOICE_OVERSPONSOR");
    const key=evidence(ctx,p,b.file_key),date=stamp(b.issuedDate,"开票日期");
    const id=nextId(db,"meeting_sponsor_invoices","id","IV");
    if(db.prepare("SELECT 1 FROM meeting_sponsor_invoices WHERE invoice_no=?").get(invoiceNo))
      throw conflict("该开票号码已登记","INVOICE_DUPLICATE");
    db.prepare("INSERT INTO meeting_sponsor_invoices(id,pid,sponsor_id,amount,invoice_no,issued_date,file_key,file_name,created_by,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)")
      .run(id,p.id,s.id,n,invoiceNo,date,key,String(b.file_name||"").slice(0,120),ctx.user.id,now());
    logAudit({user:ctx.user,module:"会议收入",action:"登记赞助开票",target:p.id,
      detail:id+"；合同："+s.id+"；开票金额："+n,ip:ctx.ip});
    return {id,summary:incomeSummary(p.id,p.budget)};
  });
}
module.exports={register,incomeSummary};
