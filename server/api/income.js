"use strict";
/** 赞助收入与会务支出严格分账。原件、银行回单和开票证据分别归档。 */
const {db,transaction}=require("../lib/db");
const {now,today,nextId,bad,conflict,notFound,cents}=require("../lib/util");
const {getProject,assertNotFrozen}=require("../lib/workflow");
const {assertProjectVisible,assertCan,assertModule,isSuper,can}=require("../lib/rbac");
const {assertUploadAttachable}=require("../lib/upload-ownership");
const {logAudit}=require("../lib/audit");
const {isDemoMode}=require("../lib/runtime");
const {storage}=require("../lib/storage");
const ocr=require("../lib/ocr-engine");
const {normalizedCategories,sponsorRights}=require("../lib/sponsor-rights");
const {extractSponsorContract,extractLedgerContract}=require("../lib/sponsor-contract-extract");
const office=require("../lib/verify-office-text");
const {linkedSponsor}=require("../lib/sponsor-ledger");
const {extractInvoice}=require("../lib/invoice-extract");
const {extractBankReceipt}=require("../lib/bank-receipt-extract");

const KEY=/^[a-f0-9]{32}\.(jpg|png|webp|gif|pdf|ppt|doc|docx|xls|xlsx|pptx|csv|txt)$/;
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
// 专项权限：协会财务只获得赞助收入管理权，不授予普通支出合同审批权。
const sponsorManager=user=>isSuper(user)||user?.role==="finance";
// 回款及开票登记不改变核销结论；已有付款执行授权可登记至结算前。
const canRecordIncome=user=>sponsorManager(user)||can(user,"payment:pay");
const incomeFrozen=p=>["已结算","已归档"].includes(p.status)||!!db.prepare("SELECT 1 FROM settlements WHERE pid=?").get(p.id);
function writable(ctx,p,perm){
  assertProjectVisible(ctx.user,p);
  if(perm==="payment:pay"){
    if(!canRecordIncome(ctx.user))assertCan(ctx.user,perm,"需要付款执行权限才能登记赞助回款及开票");
  }else if(!(sponsorManager(ctx.user)&&perm==="contract:write"))assertCan(ctx.user,perm);
  assertNotFrozen(p,"会议赞助收入");
  if(incomeFrozen(p))throw conflict("会议已结算，赞助收入已冻结","FROZEN");
  if(p.status==="已核销"&&perm!=="payment:pay"&&!sponsorManager(ctx.user))throw conflict("项目已核销，仅总管理员和协会财务可维护赞助合同","INCOME_FROZEN");
}
function assertSponsorManager(ctx,p){
  assertProjectVisible(ctx.user,p);
  if(!sponsorManager(ctx.user))throw require("../lib/util").forbidden("仅总管理员和协会财务可修改已登记的赞助合同及收入凭证");
  writable(ctx,p,"contract:write");
}
function resetSponsorVerification(p,reason){
  const at=now();
  const changed=db.prepare("UPDATE verify_steps SET result='待判定',remark=?,evidence_json=NULL,invoice_amount=NULL,checked_by=NULL,checked_at=NULL WHERE pid=? AND step_no=7 AND result<>'待判定'").run(reason,p.id);
  if(p.status==="已核销"&&changed.changes)
    db.prepare("UPDATE projects SET status='待核销',updated_at=? WHERE id=?").run(at,p.id);
}

/** 预览时只产生候选字段，不写入合同，不触发审批或权益确认。 */
async function scanContract(fileKey,ledger=false,category=""){
  const ext=String(fileKey||"").split(".").pop().toLowerCase();
  const blank={vendor:"",enterprise:"",amount:null,rightsContent:[]};
  const manual=note=>({status:"需人工补录",fields:blank,note,engine:"",truncated:false,mode:""});
  const native=office.SUPPORTED.has(ext);
  if(!native&&!["pdf","png","jpg"].includes(ext))
    return manual("当前格式无法提取合同文字。请上传可搜索 PDF、JPG、PNG 或带文字的 DOCX，或人工核对原件填写。");
  try{
    const file=await storage().get(fileKey);
    if(!file?.buffer)return manual("原件未能读取，请重新上传文件。");
    let extracted;
    if(native){
      extracted=office.extract(file.buffer,ext);
    }else if(ext==="pdf"){
      // Searchable PDFs do not need RapidOCR; otherwise previously every PDF preview
      // was blank whenever ERP_OCR_ENABLED was unset, even if it contained a text layer.
      let pdfText=null,readError=null;
      try{pdfText=await ocr.extractPdfText(file.buffer);}
      catch(e){readError=e;}
      const text=String(pdfText?.text||"").trim();
      if(text.length>=25||/(?:合同|协议|金额|甲方|乙方|签约方|人民币)/u.test(text)){
        extracted=pdfText;
      }else if(ocr.enabled()&&storage().name==="fs"){
        extracted=await ocr.recognize(file.buffer,"pdf");
      }else if(readError){
        return manual("PDF 文字解析不可用（"+String(readError.code||"PDF_TEXT_ERROR")+"）。请在服务器安装 poppler-utils，扫描图片型 PDF 还需启用 RapidOCR；或先人工填写。");
      }else{
        return manual("该 PDF 没有可用的文字层，属于图片扫描件。请在服务器启用 RapidOCR 以识别文字，或手工填写。");
      }
    }else{
      if(!ocr.enabled()||storage().name!=="fs")
        return manual("图片 OCR 尚未启用或当前部署不支持本地 OCR。请在阿里云配置 RapidOCR（ERP_OCR_ENABLED=1），或人工核对原件填写。");
      extracted=await ocr.recognize(file.buffer,ext);
    }
    if(!extracted?.text?.trim())
      return manual("原件中没有可识别的文字，请检查是否是扫描图片、加密 PDF 或纯图片 Word；也可人工填写。");
    return ledger?extractLedgerContract(extracted.text,extracted,{category}):extractSponsorContract(extracted.text,extracted);
  }catch(e){
    return manual("合同文字识别失败（"+String(e.code||"SCAN_ERROR")+"），请检查原件与服务器 OCR 配置，或手工核对后填写。");
  }
}
/**
 * Invoice preview uses the same built-in RapidOCR/PDF-text/native-Office reader as
 * contracts, but an invoice-specific parser (price = tax-inclusive total).
 * An OCR preview is read-only and never registers an invoice.
 */
async function scanFinancialEvidence(fileKey,kind){
 const receipt=kind==="receipt",name=receipt?"银行转账单":"发票";
 const ext=String(fileKey||"").split(".").pop().toLowerCase();
 const fields=receipt?{paymentRef:"",amount:null}:{invoiceNo:"",amount:null};
 const empty=note=>({status:"需人工补录",fields,note,engine:"",mode:"",truncated:false});
 const native=office.SUPPORTED.has(ext);
 if(!native&&!["pdf","png","jpg"].includes(ext))
  return empty("不支持从该格式读取文字，请上传 PDF、JPG、PNG 或带文字的 DOCX 原件。");
 try{
  const file=await storage().get(fileKey);
  if(!file?.buffer)return empty(name+"文件读取失败，请重新上传原件。");
  let result;
  if(native)result=office.extract(file.buffer,ext);
  else if(ext==="pdf"){
   let pdf=null,readError=null;
   try{pdf=await ocr.extractPdfText(file.buffer);}catch(e){readError=e;}
   const text=String(pdf?.text||"").trim();
   const looksUseful=receipt?/(?:银行流水|交易流水|流水号|回单编号|转款金额|转账金额|到账金额|交易金额)/u:
     /(?:发票号码|价税合计|开票金额|发票金额)/u;
   if(text.length>=30||looksUseful.test(text))
    result=pdf;
   else if(ocr.enabled()&&storage().name==="fs")
    result=await ocr.recognize(file.buffer,"pdf");
   else if(readError)
    return empty("PDF 文字解析不可用（"+String(readError.code||"PDF_TEXT_ERROR")+"），请安装 poppler-utils；扫描 PDF 还需要启用 RapidOCR。");
   else return empty("该 PDF 没有可用文字层，请启用服务器内置 RapidOCR 识别扫描图片，或人工填写。");
  }else{
   if(!ocr.enabled()||storage().name!=="fs")
    return empty(name+"图片识别需要阿里云服务器启用 RapidOCR（ERP_OCR_ENABLED=1）及本地文件存储。");
   result=await ocr.recognize(file.buffer,ext);
  }
  if(!result?.text?.trim())return empty(name+"原件没有可提取的文字，请更换清晰原件或人工填写。");
  return receipt?extractBankReceipt(result.text,result):extractInvoice(result.text,result);
 }catch(e){
  return empty(name+" OCR 未完成（"+String(e.code||"SCAN_ERROR")+"），请检查原件、RapidOCR 服务与配置并人工核对。");
 }
}
async function scanInvoice(fileKey){return scanFinancialEvidence(fileKey,"invoice");}
async function scanBankReceipt(fileKey){return scanFinancialEvidence(fileKey,"receipt");}
async function scanRights(fileKey){
  const scanned=await scanContract(fileKey);
  const categories=scanned.fields.rightsContent;
  return {status:categories.length?"待确认":"需人工补录",
    note:scanned.note,categories};
}
function saveRights(pid,contractId,categories,source,confirmed){
  const ins=db.prepare("INSERT INTO sponsor_rights(pid,sponsor_id,category,source,confirmed,updated_at) VALUES(?,?,?,?,?,?)");
  for(const category of categories)ins.run(pid,contractId,category,source,confirmed?1:0,now());
}
function register(router){
  router.get("/api/projects/:id/income",async ctx=>{
    const p=getProject(ctx.params.id);
    assertProjectVisible(ctx.user,p);
    if(!sponsorManager(ctx.user)&&!can(ctx.user,"contract:write")&&!can(ctx.user,"contract:approve")&&
       !can(ctx.user,"payment:pay")&&!can(ctx.user,"payment:approve"))
      throw require("../lib/util").forbidden("无权查看赞助合同与财务回款");
    const frozen=incomeFrozen(p),unlocked=!frozen&&(p.status!=="已核销"||sponsorManager(ctx.user));
    return {pid:p.id,summary:incomeSummary(p.id,p.budget),permissions:{
      editContracts:unlocked&&(sponsorManager(ctx.user)||can(ctx.user,"contract:write")),
      correctContracts:!frozen&&sponsorManager(ctx.user),
      approveContracts:unlocked&&can(ctx.user,"contract:approve"),
      recordFinance:!frozen&&canRecordIncome(ctx.user),frozen},
      rights:sponsorRights(db,p.id).rights,
      contracts:db.prepare("SELECT * FROM meeting_sponsor_contracts WHERE pid=? ORDER BY created_at DESC").all(p.id),
      receipts:db.prepare("SELECT * FROM meeting_sponsor_receipts WHERE pid=? ORDER BY created_at DESC").all(p.id),
      invoices:db.prepare("SELECT * FROM meeting_sponsor_invoices WHERE pid=? ORDER BY created_at DESC").all(p.id)};
  });
  router.post("/api/projects/:id/income/contracts/scan",async ctx=>{
    const p=getProject(ctx.params.id);
    writable(ctx,p,"contract:write");
    const key=evidence(ctx,p,ctx.body?.file_key);
    const preview=await scanContract(key);
    return {...preview,file_key:key,contractNoNote:"合同编号将在保存时由系统自动生成"};
  });
  router.post("/api/projects/:id/income/receipts/scan",async ctx=>{
    const p=getProject(ctx.params.id);
    writable(ctx,p,"payment:pay");
    const key=evidence(ctx,p,ctx.body?.file_key);
    // Preview never writes a financial receipt; registration stays in the original endpoint.
    const preview=await scanBankReceipt(key);
    return {...preview,file_key:key};
  });
  router.post("/api/projects/:id/income/invoices/scan",async ctx=>{
    const p=getProject(ctx.params.id);
    writable(ctx,p,"payment:pay");
    const key=evidence(ctx,p,ctx.body?.file_key);
    const preview=await scanInvoice(key);
    // The source text is never exposed; result is a read-only candidate.
    return {...preview,file_key:key};
  });
  router.post("/api/projects/:id/income/contracts",async ctx=>{
    const p=getProject(ctx.params.id);writable(ctx,p,"contract:write");
    const b=ctx.body||{};
    const enterprise=String(b.enterprise||"").trim();
    if(enterprise.length<2||enterprise.length>100)
      throw bad("请填写有效的赞助企业名称（2～100 字）");
    const total=amount(b.amount);
    const key=evidence(ctx,p,b.file_key);
    const manual=b.rightsCategories==null?null:normalizedCategories(b.rightsCategories);
    const extracted=manual!==null?{status:"待确认",note:"权益内容已预填，须对照合同原件逐项确认",categories:manual}:
      await scanRights(key);
    writable(ctx,getProject(p.id),"contract:write"); // OCR 期间可能已结算
    const id=nextId(db,"meeting_sponsor_contracts","id","SC");
    const contractNo=id; // 唯一业务编号由系统生成，不接受客户端提供的合同号。
    db.prepare("INSERT INTO meeting_sponsor_contracts(id,pid,enterprise,contract_no,amount,status,file_key,file_name,created_by,created_at,rights_scan_status,rights_scan_note) VALUES (?,?,?,?,?,'待确认',?,?,?,?,?,?)")
      .run(id,p.id,enterprise,contractNo,total,key,String(b.file_name||"").slice(0,120),ctx.user.id,now(),
        extracted.status,extracted.note);
    saveRights(p.id,id,extracted.categories,manual!==null?"draft":"ocr",false);
    logAudit({user:ctx.user,module:"会议收入",action:"登记赞助合同",target:p.id,
      detail:id+"；企业："+enterprise+"；合同金额："+total,ip:ctx.ip});
    return {id,contractNo,status:"待确认",summary:incomeSummary(p.id,p.budget),
      rightsScanStatus:extracted.status,rightsScanNote:extracted.note,rightsCategories:extracted.categories};
  });
  // 修改已登记赞助合同；原编号、签署状态及已有财务流水保持不变。
  router.patch("/api/projects/:id/income/contracts/:cid",async ctx=>{
    const p=getProject(ctx.params.id);assertSponsorManager(ctx,p);
    const s=sponsor(p.id,ctx.params.cid),b=ctx.body||{};
    if(s.status==="已驳回")throw conflict("已驳回合同请重新登记","SPONSOR_CONTRACT_REJECTED");
    const enterprise="enterprise" in b?String(b.enterprise||"").trim():s.enterprise;
    if(enterprise.length<2||enterprise.length>100)throw bad("请填写有效的赞助企业名称（2～100 字）");
    const total="amount" in b?amount(b.amount):s.amount;
    const received=db.prepare("SELECT COALESCE(SUM(amount),0) AS n FROM meeting_sponsor_receipts WHERE sponsor_id=?").get(s.id).n;
    const invoiced=db.prepare("SELECT COALESCE(SUM(amount),0) AS n FROM meeting_sponsor_invoices WHERE sponsor_id=?").get(s.id).n;
    if(cents(total)<Math.max(cents(received),cents(invoiced)))
      throw conflict("修改后合同金额不能低于已到账或已开票金额，请先核对收入凭证","SPONSOR_AMOUNT_BELOW_EVIDENCE");
    const replacement=!!b.file_key&&b.file_key!==s.file_key;
    const key=replacement?evidence(ctx,p,b.file_key):s.file_key;
    const name=replacement?String(b.file_name||"").slice(0,120):s.file_name;
    const ledger=s.ledger_contract_id?db.prepare("SELECT * FROM contracts WHERE id=? AND pid=? AND category='企业赞助' AND deleted_at IS NULL").get(s.ledger_contract_id,p.id):null;
    if(s.ledger_contract_id&&!ledger)throw conflict("关联合同台账记录缺失","SPONSOR_LEDGER_MISSING");
    transaction(()=>{
      assertSponsorManager(ctx,getProject(p.id));
      db.prepare("UPDATE meeting_sponsor_contracts SET enterprise=?,amount=?,file_key=?,file_name=? WHERE id=?").run(enterprise,total,key,name,s.id);
      if(ledger){
        db.prepare("UPDATE contracts SET vendor=?,amount=?,file_key=?,file_name=? WHERE id=?").run(enterprise,total,key,name,ledger.id);
        db.prepare("UPDATE approvals SET amount=? WHERE type='合同审批' AND ref_id=? AND status='待审批'").run(total,ledger.id);
      }
      if(replacement){
        // 原件保留为历史版，绝不删除旧证据。
        db.prepare("UPDATE materials SET version='历史版' WHERE pid=? AND file_key=? AND kind='合同' AND deleted_at IS NULL").run(p.id,s.file_key);
        const old=db.prepare("SELECT 1 FROM materials WHERE pid=? AND file_key=? AND deleted_at IS NULL").get(p.id,s.file_key);
        const ins=db.prepare("INSERT INTO materials(pid,kind,name,version,uploader,created_at,file_key,file_name) VALUES(?,?,?,?,?,?,?,?)");
        if(!old&&s.file_key)ins.run(p.id,"合同",s.contract_no+" · 原赞助合同","历史版",ctx.user.name,now(),s.file_key,s.file_name);
        ins.run(p.id,"合同",s.contract_no+" · 企业赞助合同","v1",ctx.user.name,now(),key,name);
        db.prepare("UPDATE meeting_sponsor_contracts SET rights_scan_status='需重新核对',rights_scan_note='合同原件已更换，须重新核对权益' WHERE id=?").run(s.id);
        db.prepare("UPDATE sponsor_rights SET confirmed=0 WHERE sponsor_id=?").run(s.id);
        resetSponsorVerification(p,"赞助合同原件已更换，须重新核对权益");
      }
    });
    logAudit({user:ctx.user,module:"会议收入",action:"修改赞助合同",target:p.id,
      detail:s.id+"；企业："+s.enterprise+" → "+enterprise+"；金额："+s.amount+" → "+total+(replacement?"；原件已替换并保留历史版":""),ip:ctx.ip});
    return {id:s.id,contractNo:s.contract_no,summary:incomeSummary(p.id,p.budget)};
  });
  // Available to meeting-material operators: populate "权益照片" second-level dropdown.
  router.get("/api/projects/:id/sponsor-rights",async ctx=>{
    const p=getProject(ctx.params.id);assertProjectVisible(ctx.user,p);
    if(!sponsorManager(ctx.user)&&!can(ctx.user,"material:write")&&!can(ctx.user,"verify:check")&&
       !can(ctx.user,"contract:write")&&!can(ctx.user,"contract:approve"))
      throw require("../lib/util").forbidden("无权查看该项目赞助权益");
    const data=sponsorRights(db,p.id);
    return {contracts:data.contracts,rights:data.rights,photos:data.photos};
  });
  // OCR suggestions are never final until this explicit, audited review.
  router.patch("/api/projects/:id/income/contracts/:cid/rights",async ctx=>{
    const p=getProject(ctx.params.id);writable(ctx,p,"contract:write");
    const contract=sponsor(p.id,ctx.params.cid);
    if(contract.status==="已驳回")throw conflict("已驳回的赞助合同不可修改权益","SPONSOR_CONTRACT_REJECTED");
    const categories=normalizedCategories(ctx.body?.categories);
    if(!categories.length && ctx.body?.confirmNoRights!==true)
      throw bad("权益清单不得为空；如合同明确没有权益，须人工选择「确认无权益」");
    const old=db.prepare("SELECT id,category FROM sponsor_rights WHERE sponsor_id=? ORDER BY id").all(contract.id);
    const byCategory=new Map(old.map(x=>[x.category,x]));
    for(const item of old.filter(x=>!categories.includes(x.category))){
      const photos=db.prepare("SELECT COUNT(*) AS n FROM materials WHERE sponsor_right_id=? AND (deleted_at IS NULL OR deleted_at='')").get(item.id);
      if(photos.n)throw conflict("权益「"+item.category+"」已有照片，请先将照片关联到正确类目后再删除该项","RIGHT_HAS_PHOTOS");
    }
    const insert=db.prepare("INSERT INTO sponsor_rights(pid,sponsor_id,category,source,confirmed,updated_at) VALUES(?,?,?,?,1,?)");
    const update=db.prepare("UPDATE sponsor_rights SET confirmed=1,source='manual',updated_at=? WHERE id=?");
    for(const category of categories){
      const oldOne=byCategory.get(category);
      if(oldOne)update.run(now(),oldOne.id);
      else insert.run(p.id,contract.id,category,"manual",now());
    }
    for(const item of old)if(!categories.includes(item.category))
      db.prepare("DELETE FROM sponsor_rights WHERE id=?").run(item.id);
    db.prepare("UPDATE meeting_sponsor_contracts SET rights_scan_status=?,rights_scan_note=? WHERE id=?")
      .run(categories.length?"已确认":"确认无权益","人工核对赞助合同权益条目后确认",contract.id);
    resetSponsorVerification(p,"赞助权益内容已更新，须重新核验");
    logAudit({user:ctx.user,module:"会议收入",action:"确认赞助权益类目",target:p.id,
      detail:contract.id+"；权益类目 "+categories.length+" 项",ip:ctx.ip});
    return {contractId:contract.id,rights:db.prepare("SELECT * FROM sponsor_rights WHERE sponsor_id=? ORDER BY id").all(contract.id)};
  });
  router.post("/api/projects/:id/income/contracts/:cid/decide",async ctx=>{
    const p=getProject(ctx.params.id);writable(ctx,p,"contract:approve");
    if(!isSuper(ctx.user)&&ctx.user.role!=="assoc")
      throw require("../lib/util").forbidden("只有协会管理员或总管理员可以确认赞助合同签署");
    const s=sponsor(p.id,ctx.params.cid);
    if(s.status!=="待确认")throw conflict("赞助合同不在待确认状态","INCOME_CONTRACT_LOCKED");
    const approve=ctx.body?.approve;
    if(typeof approve!=="boolean")throw bad("必须明确提交审批通过或驳回");
    if(!approve && String(ctx.body?.reason||"").trim().length<4)throw bad("驳回理由至少 4 字");
    // 会议预算取立项数据，仅作预算对照，不限制赞助合同收入。
    const status=approve?"已签署":"已驳回";
    const ledger=s.ledger_contract_id
      ? db.prepare("SELECT id,pid,status,category FROM contracts WHERE id=? AND pid=? AND deleted_at IS NULL").get(s.ledger_contract_id,p.id)
      : null;
    if(s.ledger_contract_id&&(!ledger||ledger.category!=="企业赞助"))
      throw conflict("关联合同台账记录缺失，请联系管理员修复","SPONSOR_LEDGER_MISSING");
    if(ledger&&ledger.status!=="待签署")
      throw conflict("合同台账还没有提交签署审批，不能从会议收入直接确认","SPONSOR_LEDGER_NOT_SUBMITTED");
    if(ledger&&!isDemoMode()){
      const pending=db.prepare("SELECT id FROM approvals WHERE type='合同审批' AND ref_id=? AND status='待审批'").get(ledger.id);
      if(!pending)throw conflict("请先在合同台账提交有效签署审批","SIGN_APPROVAL_REQUIRED");
    }
    transaction(()=>{
      db.prepare("UPDATE meeting_sponsor_contracts SET status=?,approved_by=?,approved_at=? WHERE id=?")
        .run(status,ctx.user.id,now(),s.id);
      if(approve)resetSponsorVerification(p,"新增已签署赞助合同，须重新核对权益");
      if(ledger){
        db.prepare("UPDATE contracts SET status=?,sign_date=? WHERE id=?")
          .run(approve?"已签署":"草稿",approve?today():"",ledger.id);
        db.prepare("UPDATE approvals SET status=?,decided_by=?,decided_at=?,comment=? WHERE type='合同审批' AND ref_id=? AND status='待审批'")
          .run(approve?"已通过":"已驳回",ctx.user.name,now(),approve?"会议收入确认赞助合同已签署":String(ctx.body.reason).trim(),ledger.id);
      }
    });
    logAudit({user:ctx.user,module:"会议收入",action:approve?"确认赞助合同":"驳回赞助合同",target:p.id,
      detail:s.id+(approve?"；确认合同已签署":"；原因："+String(ctx.body.reason).trim()),ip:ctx.ip});
    return {id:s.id,status,summary:incomeSummary(p.id,p.budget)};
  });
  // 凭证纠错须保留原编号与审计记录，并仍受单份合同金额限制。
  for(const kind of ["receipts","invoices"]){
    const receipt=kind==="receipts",table=receipt?"meeting_sponsor_receipts":"meeting_sponsor_invoices";
    const refCol=receipt?"payment_ref":"invoice_no",dateCol=receipt?"received_date":"issued_date";
    router.patch("/api/projects/:id/income/"+kind+"/:rid",async ctx=>{
      const p=getProject(ctx.params.id);assertSponsorManager(ctx,p);
      const old=db.prepare("SELECT * FROM "+table+" WHERE id=? AND pid=?").get(ctx.params.rid,p.id);
      if(!old)throw notFound("收入凭证不存在");
      const s=sponsor(p.id,old.sponsor_id),b=ctx.body||{};
      const n="amount" in b?amount(b.amount):old.amount;
      const ref=String(b[receipt?"paymentRef":"invoiceNo"]??old[refCol]).trim();
      if(receipt?ref.length<3||ref.length>100:!/^[\w\-]{6,50}$/.test(ref))throw bad("凭证编号格式不正确");
      const date=stamp(b[receipt?"receivedDate":"issuedDate"]??old[dateCol],receipt?"到账日期":"开票日期");
      const others=db.prepare("SELECT COALESCE(SUM(amount),0) AS n FROM "+table+" WHERE sponsor_id=? AND id<>?").get(s.id,old.id).n;
      if(cents(others)+cents(n)>cents(s.amount))throw conflict("累计金额不能超过该企业签署的赞助合同金额","INCOME_OVER_CONTRACT");
      if(!receipt&&db.prepare("SELECT 1 FROM meeting_sponsor_invoices WHERE invoice_no=? AND id<>?").get(ref,old.id))throw conflict("该开票号码已登记","INVOICE_DUPLICATE");
      const replacement=!!b.file_key&&b.file_key!==old.file_key;
      const key=replacement?evidence(ctx,p,b.file_key):old.file_key;
      const name=replacement?String(b.file_name||"").slice(0,120):old.file_name;
      transaction(()=>{
        assertSponsorManager(ctx,getProject(p.id));
        if(replacement&&old.file_key)db.prepare("INSERT INTO materials(pid,kind,name,version,uploader,created_at,file_key,file_name) VALUES(?,?,?,?,?,?,?,?)")
          .run(p.id,receipt?"赞助回款凭证":"发票",old.id+" · 原收入凭证","历史版",ctx.user.name,now(),old.file_key,old.file_name);
        db.prepare("UPDATE "+table+" SET amount=?,"+refCol+"=?,"+dateCol+"=?,file_key=?,file_name=? WHERE id=?").run(n,ref,date,key,name,old.id);
      });
      logAudit({user:ctx.user,module:"会议收入",action:receipt?"修改赞助回款":"修改赞助开票",target:p.id,
        detail:old.id+"；金额："+old.amount+" → "+n+"；编号："+old[refCol]+" → "+ref+"；日期："+old[dateCol]+" → "+date+(replacement?"；原件已替换并保留历史版":""),ip:ctx.ip});
      return {id:old.id,summary:incomeSummary(p.id,p.budget)};
    });
  }
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
module.exports={register,incomeSummary,scanContract,scanInvoice,scanBankReceipt};
