"use strict";
/**
 * 已签署合同的受控更正：申请 -> 独立审批 -> 保留旧版并发布新证据 -> 只重核受影响步骤。
 * 不使用旧的 replace-file 直接覆盖已签署原件；结算或付款后的财务更正另走专门流程。
 */
const {db,transaction}=require("../lib/db");
const {now,nextId,bad,notFound,conflict,forbidden,cents}=require("../lib/util");
const {assertCan,assertProjectVisible,can,isSuper}=require("../lib/rbac");
const {getProject,settlementOf}=require("../lib/workflow");
const {assertUploadAttachable}=require("../lib/upload-ownership");
const {storage,sniffMime,ALLOWED_MIME,MAX_BYTES,safeName}=require("../lib/storage");
const {logAudit}=require("../lib/audit");

const TYPES=Object.freeze({file_correction:"合同原件纠错",supplement:"补充协议／合同变更",terminate:"合同解除／终止"});
const FILE_KEY=/^[a-f0-9]{32}\.(jpg|png|webp|gif|pdf|ppt|doc|pptx|docx|xls|xlsx|csv|txt)$/;
const TERMINAL=["已结算","已归档"];
function contract(id){
  const c=db.prepare("SELECT * FROM contracts WHERE id=? AND deleted_at IS NULL").get(id);
  if(!c)throw notFound("合同不存在或已删除");
  return c;
}
function mutationGuard(c,p){
  if(TERMINAL.includes(p.status)||settlementOf(p.id))
    throw conflict("项目已有结算或归档记录，不能直接更正合同；请办理财务结算更正","SETTLED_CONTRACT_LOCKED");
  if(db.prepare("SELECT 1 FROM payments WHERE pid=? AND status<>'已驳回' LIMIT 1").get(p.id))
    throw conflict("项目已有付款或请款记录，合同更正须先完成付款及财务调整流程","PAYMENT_RECONCILIATION_REQUIRED");
  if(c.status!=="已签署")throw conflict("只有已签署合同可发起合同更正，草稿请走现有签署流程","CONTRACT_NOT_SIGNED");
}
function requestRow(id){
  const r=db.prepare("SELECT * FROM contract_amendments WHERE id=?").get(id);
  if(!r)throw notFound("合同更正申请不存在");
  return r;
}
function affectedSteps(c){
  if(c.category==="企业赞助")return [7];
  if(c.category==="劳务专家")return [5];
  return [6];
}
async function validateFile(key,p,user){
  if(!FILE_KEY.test(key))throw bad("请上传 PDF、图片或 Office 格式的有效合同更正证明");
  assertUploadAttachable(key,p.id,user);
  const file=await storage().get(key);
  if(!file || !file.buffer || !file.buffer.length)throw notFound("上传的更正附件不存在");
  if(file.buffer.length>MAX_BYTES)throw bad("单份合同更正文件超过服务器大小限制");
  const mime=sniffMime(file.buffer,key);
  if(!mime || ALLOWED_MIME[mime]!==key.split(".").pop())throw bad("文件内容与扩展名不匹配");
  return {fileSize:file.buffer.length,fileMime:mime};
}
function register(router){
  router.get("/api/contracts/:id/amendments",async ctx=>{
    if(!can(ctx.user,"contract:write")&&!can(ctx.user,"contract:approve"))
      throw forbidden("没有合同管理权限");
    const c=contract(ctx.params.id),p=getProject(c.pid);assertProjectVisible(ctx.user,p);
    const rows=db.prepare("SELECT * FROM contract_amendments WHERE contract_id=? ORDER BY created_at DESC,id DESC").all(c.id);
    return {contractId:c.id,rows};
  });

  router.post("/api/contracts/:id/amendments",async ctx=>{
    assertCan(ctx.user,"contract:write","没有合同更正申请权限");
    const c=contract(ctx.params.id),p=getProject(c.pid);assertProjectVisible(ctx.user,p);
    mutationGuard(c,p);
    const b=ctx.body||{};
    const kind=String(b.kind||"");
    if(!Object.prototype.hasOwnProperty.call(TYPES,kind))throw bad("请选择合法的合同更正类型");
    const reason=String(b.reason||"").trim();
    if(reason.length<8||reason.length>500)throw bad("更正理由必须为 8～500 字");
    const key=String(b.file_key||"");
    if(!key||key===c.file_key)throw bad("须上传不同于原版的已签署更正协议或证明文件");
    const {fileSize,fileMime}=await validateFile(key,p,ctx.user);
    const name=safeName(String(b.file_name||key));
    const signedSponsor=c.category==="企业赞助";
    if(signedSponsor && kind==="terminate")
      throw conflict("赞助合同解除涉及权益清算，必须先办理单独的赞助终止与权益清算流程","SPONSOR_TERMINATION_REQUIRES_SETTLEMENT");
    let nextAmount=null;
    if(b.new_amount!==undefined && b.new_amount!==null && b.new_amount!==""){
      if(kind!=="supplement")throw bad("只有补充协议／合同变更允许调整合同金额");
      nextAmount=Number(b.new_amount);
      if(!Number.isFinite(nextAmount)||nextAmount<=0||nextAmount>1e9||cents(nextAmount)/100!==nextAmount)
        throw bad("变更后金额应大于零，最多两位小数且不超过10亿元");
    }
    if(signedSponsor && nextAmount!==null){
      const sponsor=db.prepare("SELECT * FROM meeting_sponsor_contracts WHERE ledger_contract_id=?").get(c.id);
      if(!sponsor)throw conflict("赞助合同台账关联缺失，请联系管理员修复","SPONSOR_LEDGER_MISSING");
      if(db.prepare("SELECT 1 FROM meeting_sponsor_receipts WHERE sponsor_id=? UNION SELECT 1 FROM meeting_sponsor_invoices WHERE sponsor_id=?").get(sponsor.id,sponsor.id))
        throw conflict("赞助合同已有回款或开票，金额更正需先进行收入对账","SPONSOR_RECONCILIATION_REQUIRED");
      const others=db.prepare("SELECT COALESCE(SUM(amount),0) AS n FROM meeting_sponsor_contracts WHERE pid=? AND status='已签署' AND id<>?").get(p.id,sponsor.id);
      if(cents(others.n)+cents(nextAmount)>cents(p.budget))
        throw conflict("调整后已签赞助合同总额不能超过会议预算","SPONSOR_BUDGET_EXCEEDED");
    }
    if(db.prepare("SELECT 1 FROM contract_amendments WHERE contract_id=? AND status='待审批'").get(c.id))
      throw conflict("这份合同已有待审批更正申请，请先完成该申请","AMENDMENT_PENDING");
    const at=now();
    const result=transaction(()=>{
      const current=contract(c.id),currentP=getProject(c.pid);
      mutationGuard(current,currentP);
      if(current.file_key!==c.file_key||cents(current.amount)!==cents(c.amount))
        throw conflict("合同已经更新，请重新打开并核对新版本","CONTRACT_CHANGED");
      if(db.prepare("SELECT 1 FROM contract_amendments WHERE contract_id=? AND status='待审批'").get(c.id))
        throw conflict("已有待审批更正申请","AMENDMENT_PENDING");
      const id=nextId(db,"contract_amendments","id","CA");
      const approvalId=nextId(db,"approvals","id","AP");
      db.prepare("INSERT INTO contract_amendments (id,contract_id,pid,kind,reason,old_amount,new_amount,old_status,old_file_key,old_file_name,new_file_key,new_file_name,new_file_size,new_file_mime,status,requested_by_id,requested_by,created_at,approval_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
        .run(id,c.id,p.id,kind,reason,c.amount,nextAmount,c.status,c.file_key,c.file_name,key,name,fileSize,fileMime,"待审批",ctx.user.id,ctx.user.name,at,approvalId);
      db.prepare("INSERT INTO approvals (id,type,title,pid,ref_id,amount,by_user,sla,status,created_at,submitted_by_id) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
        .run(approvalId,"合同更正审批",TYPES[kind]+"："+c.name,p.id,id,nextAmount===null?c.amount:nextAmount,ctx.user.name,"2 个工作日","待审批",at,ctx.user.id);
      return {id,approvalId};
    });
    logAudit({user:ctx.user,module:"合同更正",action:"发起更正申请",target:p.id,
      detail:result.id+"；合同 "+c.id+"；"+TYPES[kind]+"；待独立审批",ip:ctx.ip});
    return {...result,message:"更正申请已提交，原合同和核销结论保持不变，等待管理员审批"};
  });
}

/** 与通用审批中心共用审批权限和审计；拒绝与生效都在一个事务内。 */
function decide(ctx,approval,approve,comment){
  const a=requestRow(approval.ref_id);
  const c=contract(a.contract_id),p=getProject(c.pid);
  assertProjectVisible(ctx.user,p);
  assertCan(ctx.user,"contract:approve","只有合同审批人员可以审核更正");
  if(approval.pid!==p.id||a.pid!==p.id||a.approval_id!==approval.id)
    throw conflict("更正申请和审批记录关联不一致","AMENDMENT_APPROVAL_MISMATCH");
  if(a.status!=="待审批")throw conflict("该合同更正申请已经处理","AMENDMENT_ALREADY_DECIDED");
  if(!isSuper(ctx.user)&&Number(a.requested_by_id)===Number(ctx.user.id))
    throw conflict("更正申请人与审批人必须分离","NEED_SECOND_PERSON");
  if(!approve && String(comment||"").trim().length<4)
    throw bad("驳回更正申请须填写至少4字原因");
  if(approve){
    mutationGuard(c,p);
    if(c.status!==a.old_status||c.file_key!==a.old_file_key||cents(c.amount)!==cents(a.old_amount))
      throw conflict("合同已发生其他修改，旧申请不能覆盖当前版本","CONTRACT_CHANGED");
    const own=db.prepare("SELECT 1 FROM uploaded_files WHERE file_key=? AND pid=?").get(a.new_file_key,p.id);
    if(!own)throw conflict("更正附件已丢失或不属于当前项目，请重新申请","AMENDMENT_FILE_MISSING");
    if(a.kind==="supplement"&&a.new_amount!==null&&c.category==="企业赞助"){
      const sponsor=db.prepare("SELECT * FROM meeting_sponsor_contracts WHERE ledger_contract_id=?").get(c.id);
      if(!sponsor)throw conflict("赞助合同关联缺失","SPONSOR_LEDGER_MISSING");
      if(db.prepare("SELECT 1 FROM meeting_sponsor_receipts WHERE sponsor_id=? UNION SELECT 1 FROM meeting_sponsor_invoices WHERE sponsor_id=?").get(sponsor.id,sponsor.id))
        throw conflict("赞助回款或开票已发生，禁止直接改金额","SPONSOR_RECONCILIATION_REQUIRED");
      const others=db.prepare("SELECT COALESCE(SUM(amount),0) AS n FROM meeting_sponsor_contracts WHERE pid=? AND status='已签署' AND id<>?").get(p.id,sponsor.id);
      if(cents(others.n)+cents(a.new_amount)>cents(p.budget))
        throw conflict("新合同赞助总额超过会议预算","SPONSOR_BUDGET_EXCEEDED");
    }
  }
  const stamp=now(),tag=TYPES[a.kind]||a.kind;
  transaction(()=>{
    const current=requestRow(a.id);
    if(current.status!=="待审批")throw conflict("该更正已被其他人处理","AMENDMENT_ALREADY_DECIDED");
    if(approve){
      // 旧合同材料软归档，但保留旧 file_key 原件字节与审计，供版本追溯。
      db.prepare("UPDATE materials SET deleted_at=?,deleted_by=? WHERE pid=? AND kind='合同' AND file_key=? AND deleted_at IS NULL")
        .run(stamp,"合同更正版本归档",p.id,c.file_key);
      db.prepare("INSERT INTO materials(pid,kind,name,version,uploader,created_at,file_key,file_name,file_size,file_mime) VALUES (?,?,?,?,?,?,?,?,?,?)")
        .run(p.id,"合同",c.id+" · "+c.name,a.kind==="terminate"?"终止证明":"更正生效",ctx.user.name,stamp,
          a.new_file_key,a.new_file_name,a.new_file_size,a.new_file_mime);
      if(c.category==="企业赞助"){
        db.prepare("UPDATE meeting_sponsor_contracts SET file_key=?,file_name=?,amount=?,rights_scan_status='需重新核对',rights_scan_note='合同更正后须人工复核权益' WHERE ledger_contract_id=?")
          .run(a.new_file_key,a.new_file_name,a.new_amount===null?c.amount:a.new_amount,c.id);
        db.prepare("UPDATE sponsor_rights SET confirmed=0 WHERE sponsor_id IN (SELECT id FROM meeting_sponsor_contracts WHERE ledger_contract_id=?)").run(c.id);
      }
      db.prepare("UPDATE contracts SET file_key=?,file_name=?,file_size=?,file_mime=?,amount=?,status=? WHERE id=? AND deleted_at IS NULL")
        .run(a.new_file_key,a.new_file_name,a.new_file_size,a.new_file_mime,
          a.new_amount===null?c.amount:a.new_amount,a.kind==="terminate"?"已终止":"已签署",c.id);
      const steps=affectedSteps(c);
      for(const n of steps){
        db.prepare("UPDATE verify_steps SET result='待判定',remark=?,evidence_json=NULL,invoice_amount=NULL,checked_by=NULL,checked_at=NULL WHERE pid=? AND step_no=?")
          .run("合同更正 "+a.id+" 已生效，请仅重新核验受影响步骤",p.id,n);
      }
      if(p.status==="已核销")db.prepare("UPDATE projects SET status='待核销',updated_at=? WHERE id=?").run(stamp,p.id);
    }
    db.prepare("UPDATE contract_amendments SET status=?,decided_by_id=?,decided_by=?,decided_at=?,decision_note=? WHERE id=?")
      .run(approve?"已生效":"已驳回",ctx.user.id,ctx.user.name,stamp,String(comment||"").slice(0,500),a.id);
    db.prepare("UPDATE approvals SET status=?,decided_by=?,decided_at=?,decided_by_id=?,comment=? WHERE id=?")
      .run(approve?"已通过":"已驳回",ctx.user.name,stamp,ctx.user.id,String(comment||""),approval.id);
  });
  logAudit({user:ctx.user,module:"合同更正",action:approve?"更正审批生效":"更正审批驳回",target:p.id,
    detail:a.id+"；合同 "+c.id+"；"+tag+(approve?"；旧原件留存；待复核步骤 "+affectedSteps(c).join("、"):""),ip:ctx.ip});
  return {message:approve?"更正已生效，历史原件保留；仅受影响的核销步骤需要重新核验":"合同更正已驳回，原合同不变",
    amendmentId:a.id,affectedSteps:approve?affectedSteps(c):[]};
}
module.exports={register,decide,TYPES};
