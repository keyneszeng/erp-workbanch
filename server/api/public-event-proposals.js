"use strict";
/**
 * Public event proposals are a separate intake channel, NOT internal project
 * initiation. No projects, approvals, members or workflow rows are created.
 */
const crypto=require("node:crypto");
const {db,transaction}=require("../lib/db");
const {now}=require("../lib/util");
const {nextMeetingId}=require("../lib/meeting-codes");
const {bad,forbidden}=require("../lib/util");
const {isSuper}=require("../lib/rbac");
const {logAudit}=require("../lib/audit");
const {sniffMime}=require("../lib/storage");
const office=require("../lib/verify-office-text");
const ocr=require("../lib/ocr-engine");
const {parseTaxFeeRate}=require("../lib/budget-fee");
const FORMS=new Set(["线下","线上","混合"]);
// 公众申请按中国标准时间的实际提交日编号，不使用活动举办日或机器本地时区。
// 例如 P20261125001；每天重新从 001 开始，超 999 时自然扩展位数。
function proposalSubmissionDay(date=new Date()){
 const parts=new Intl.DateTimeFormat("en-GB",{
  timeZone:"Asia/Shanghai",year:"numeric",month:"2-digit",day:"2-digit"
 }).formatToParts(date);
 const part=type=>parts.find(x=>x.type===type)?.value||"";
 return part("year")+part("month")+part("day");
}
/** 同一个 transaction() 中先分配流水、再检查限流并保存申请。 */
function nextPublicProposalId(database,day){
 if(!/^\d{8}$/.test(day))throw bad("公众申请编号日期无效");
 // 首次写入即占用写锁，同日并发分配不会读取到相同的 last_seq。
 database.prepare("INSERT INTO public_proposal_sequences(day,last_seq) VALUES (?,1) "+
  "ON CONFLICT(day) DO UPDATE SET last_seq=last_seq+1").run(day);
 const seq=Number(database.prepare("SELECT last_seq FROM public_proposal_sequences WHERE day=?").get(day)?.last_seq);
 if(!Number.isSafeInteger(seq)||seq<1)throw bad("公众申请编号生成失败");
 return "P"+day+String(seq).padStart(3,"0");
}

function str(v,max,label,{required=true}={}){
 if(typeof v!=="string")throw bad(label+"格式不正确");
 const s=v.trim();
 if((required&&!s)||s.length>max||/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(s))
  throw bad(label+"不能为空或超过"+max+"字");
 return s;
}
function validDate(s){
 if(!/^\d{4}-\d{2}-\d{2}$/.test(s))return false;
 const t=Date.parse(s+"T00:00:00.000Z");
 return Number.isFinite(t)&&new Date(t).toISOString().slice(0,10)===s;
}
function publicPeriod(input){
 const event_date=str(input.event_date,10,"举办开始日期");
 if(!validDate(event_date))throw bad("请选择有效举办开始日期");
 const event_end_date=str(input.event_end_date||event_date,10,"举办结束日期");
 if(!validDate(event_end_date))throw bad("请选择有效举办结束日期");
 const event_time=str(input.event_time,5,"举办开始时间");
 if(!/^([01]\d|2[0-3]):[0-5]\d$/.test(event_time))throw bad("请选择有效活动开始时间");
 const event_end_time=str(input.event_end_time||event_time,5,"举办结束时间");
 if(!/^([01]\d|2[0-3]):[0-5]\d$/.test(event_end_time))throw bad("请选择有效活动结束时间");
 if(event_end_date<event_date||(event_end_date===event_date&&event_end_time<event_time))
   throw bad("举办结束时间不能早于开始时间");
 const days=1+Math.round((Date.parse(event_end_date+"T00:00:00Z")-Date.parse(event_date+"T00:00:00Z"))/86400000);
 if(days>60)throw bad("举办时间段不能超过60个自然日");
 return {event_date,event_end_date,event_time,event_end_time,days};
}
function validate(input){
 if(!input||typeof input!=="object"||Array.isArray(input))throw bad("申请内容格式不正确");
 // Honeypot is checked before database writes.
 if(input.website)throw bad("提交内容无效");
 const topic=str(input.topic,120,"活动主题");
 const {event_date,event_end_date,event_time,event_end_time,days}=publicPeriod(input);
 const form=str(input.form,10,"活动形式");
 if(!FORMS.has(form))throw bad("活动形式只能是线上、线下或混合");
 // Amount is expressed as a currency decimal, disallow exponent and negatives.
 if(!/^(0|[1-9]\d{0,10})(?:\.\d{1,2})?$/.test(String(input.budget??"")))
    throw bad("预算须为不超过两位小数的人民币金额");
 const budget=Number(input.budget);
 if(!Number.isFinite(budget)||budget>10000000000)throw bad("预算金额超出允许范围");
 const agenda=str(input.agenda,3000,"活动议程");
 const requested_assoc=str(input.requested_assoc||"",40,"意向所属协会",{required:false});
 const dept=str(input.dept||"",40,"承办部门",{required:false});
 const people=input.people===undefined||input.people===""?0:Number(input.people);
 if(!Number.isInteger(people)||people<0||people>100000)throw bad("预计参会人数应为0至100000的整数");
 const tax_fee_rate=parseTaxFeeRate(input.tax_fee_rate??0);
 const contact_name=str(input.contact_name,60,"联系人");
 const contact_phone=str(input.contact_phone,30,"联系电话");
 if(!/^[+\d][\d\s+()\-]{5,29}$/.test(contact_phone))throw bad("请填写有效联系电话");
 const contact_info=str(input.contact_info||"",200,"补充联系方式",{required:false});
 if(input.consent!==true)throw bad("请同意个人信息用于本次活动联系及管理");
 return {topic,event_date,event_end_date,event_time,event_end_time,days,form,budget,agenda,requested_assoc,dept,people,tax_fee_rate,contact_name,contact_phone,contact_info};
}
// Lightweight anti-abuse limiter for anonymous recognition requests. Never
// expose model access without file-size/type checks and per-source throttling.
const recentOcr=new Map();
function ocrGuard(ip){
 const at=Date.now(),key=fingerprint(ip),items=(recentOcr.get(key)||[]).filter(t=>at-t<3600000);
 if(items.length>=6)throw Object.assign(new Error("议程识别过于频繁，请一小时后再试"),{status:429,code:"PUBLIC_OCR_RATE_LIMIT"});
 items.push(at);recentOcr.set(key,items);
 if(recentOcr.size>2000)for(const [k,v] of recentOcr){if(v.at(-1)<at-3600000)recentOcr.delete(k)}
}
const fingerprint=ip=>crypto.createHash("sha256").update(
 String(process.env.ERP_PUBLIC_PROPOSAL_HASH_SALT||"erp-proposal")+"|"+String(ip||"unknown")
).digest("hex");
function publicSourceIp(ctx){
 const proxyIp=String(ctx.req?.headers?.["x-real-ip"]||"");
 const trustedProxy=process.env.ERP_TRUST_PROXY==="1"&&
   ["127.0.0.1","::1","::ffff:127.0.0.1"].includes(String(ctx.ip));
 return trustedProxy&&/^[a-f\d.:]{3,45}$/i.test(proxyIp)?proxyIp:ctx.ip;
}
async function recognizeAgenda(body,ip,{publicAccess=false}={}){
  if(body?.website)throw bad("提交内容无效");
  const filename=str(body?.filename||"",120,"议程文件名");
  const ext=filename.split(".").pop().toLowerCase();
  const accepted=new Set(["pdf","png","jpg","jpeg","docx","pptx","xlsx","txt"]);
  if(!accepted.has(ext))throw bad("议程识别支持 PDF、JPG、PNG、DOCX、PPTX、XLSX、TXT");
  const encoded=String(body?.content_base64||"");
  if(!encoded||encoded.length>2.8*1024*1024||!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded))
   throw bad("议程文件编码无效或超过2MB");
  const buffer=Buffer.from(encoded,"base64");
  if(!buffer.length||buffer.length>2*1024*1024)throw bad("议程文件不能超过2MB");
  const mime=sniffMime(buffer,filename);
  const expected={
   pdf:"application/pdf",png:"image/png",jpg:"image/jpeg",jpeg:"image/jpeg",
   docx:"application/vnd.openxmlformats-officedocument.wordprocessingml.document",
   pptx:"application/vnd.openxmlformats-officedocument.presentationml.presentation",
   xlsx:"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
   txt:"text/plain"
  };
  if(!mime||mime!==expected[ext])throw bad("文件内容与格式不符，拒绝识别");
  if(publicAccess)ocrGuard(ip);
  let result;
  if(ext==="pdf"){
   result=await ocr.extractPdfText(buffer,{maxPages:10});
   if(!result.text.trim()){
    if(!ocr.enabled())throw bad("该PDF无可读取文字层，当前服务器未启用扫描件OCR");
    result=await ocr.recognize(buffer,"pdf",{maxPages:10});
   }
  }else if(["png","jpg","jpeg"].includes(ext)){
   if(!ocr.enabled())throw bad("图片OCR尚未启用，请先在服务器配置RapidOCR");
   result=await ocr.recognize(buffer,ext==="jpeg"?"jpg":ext);
  }else result=office.extract(buffer,ext);
  const text=ocr.cleanText(result.text||"").slice(0,3000);
  if(!text)throw bad("文件未识别到可填写的议程文字，请手动填写");
  return {agenda:text,engine:result.engine||"",pages:result.pages||1,
   totalPages:result.totalPages||1,truncated:!!result.truncated,
   message:"已识别议程，请核对并修改后提交"};
}
function register(router){
 router.post("/api/public/event-proposals/agenda-ocr",async ctx=>{
  if(process.env.ERP_PUBLIC_PROPOSALS_ENABLED==="0")
   throw Object.assign(new Error("公众活动申请入口暂未开放"),{status:503,code:"PUBLIC_PROPOSALS_DISABLED"});
  return recognizeAgenda(ctx.body,publicSourceIp(ctx),{publicAccess:true});
 });
 router.post("/api/public/event-proposals",async ctx=>{
  if(process.env.ERP_PUBLIC_PROPOSALS_ENABLED==="0")
   throw Object.assign(new Error("公众活动申请入口暂未开放"),{status:503,code:"PUBLIC_PROPOSALS_DISABLED"});
  const v=validate(ctx.body);
  const received=new Date(),at=received.toISOString();
  const day=proposalSubmissionDay(received),hash=fingerprint(publicSourceIp(ctx));
  const since=new Date(received.getTime()-60*60*1000).toISOString();
  // 流水分配、限流和写入在同一事务；提交失败回滚流水，避免重复与虚假占号。
  const id=transaction(()=>{
   const allocated=nextPublicProposalId(db,day);
   const recent=db.prepare("SELECT COUNT(*) AS n FROM public_event_proposals WHERE submitter_fingerprint=? AND received_at>=?").get(hash,since);
   if(Number(recent?.n)>=8)
    throw Object.assign(new Error("提交过于频繁，请稍后再试"),{status:429,code:"PUBLIC_PROPOSAL_RATE_LIMIT"});
   db.prepare("INSERT INTO public_event_proposals "+
    "(id,topic,event_date,event_time,form,budget,agenda,contact_name,contact_phone,contact_info,consent_at,received_at,submitter_fingerprint,status,"+
    "event_end_date,event_end_time,requested_assoc,dept,people,tax_fee_rate) "+
    "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
    .run(allocated,v.topic,v.event_date,v.event_time,v.form,v.budget,v.agenda,v.contact_name,v.contact_phone,v.contact_info,at,at,hash,"已接收",
      v.event_end_date,v.event_end_time,v.requested_assoc,v.dept,v.people,v.tax_fee_rate);
   return allocated;
  });
  return {reference:id,status:"已接收",message:"活动申请已送达总管理员收件箱，此提交不进入内部立项审批流程"};
 });
 router.get("/api/admin/public-event-proposals",async ctx=>{
  if(!isSuper(ctx.user))throw forbidden("只有总管理员可查看公众活动申请与联系方式");
  const page=Math.max(1,Math.min(10000,Number(ctx.query.page)||1));
  const size=Math.max(1,Math.min(100,Number(ctx.query.size)||30));
  const total=Number(db.prepare("SELECT COUNT(*) AS n FROM public_event_proposals").get().n);
  const rows=db.prepare("SELECT p.id,p.topic,p.event_date,p.event_time,p.event_end_date,p.event_end_time,p.requested_assoc,p.dept,p.people,p.tax_fee_rate,p.form,p.budget,p.agenda,p.contact_name,p.contact_phone,p.contact_info,p.received_at,p.status,p.handled_at,p.handled_by,p.handling_note,l.project_id "+
     "FROM public_event_proposals p LEFT JOIN public_proposal_project_links l ON l.proposal_id=p.id "+
     "ORDER BY p.received_at DESC,p.id DESC LIMIT ? OFFSET ?").all(size,(page-1)*size);
  return {rows,total,page,size};
 });
 router.post("/api/admin/public-event-proposals/:id/process",async ctx=>{
  if(!isSuper(ctx.user))throw forbidden("只有总管理员可以处理公众活动申请");
  const id=String(ctx.params.id||"");
  const row=db.prepare("SELECT id,status FROM public_event_proposals WHERE id=?").get(id);
  if(!row)throw Object.assign(new Error("公众活动申请不存在"),{status:404,code:"NOT_FOUND"});
  if(row.status==="已归档")return {id,status:row.status,message:"该申请已处理"};
  const note=String(ctx.body?.note||"").trim();
  if(note.length>1000)throw bad("处理备注不能超过1000字");
  const at=new Date().toISOString();
  db.prepare("UPDATE public_event_proposals SET status='已归档',handled_at=?,handled_by=?,handling_note=? WHERE id=? AND status='已接收'")
   .run(at,ctx.user.id,note,id);
  require("../lib/audit").logAudit({user:ctx.user,module:"公众活动申请",action:"处理公众活动申请",target:id,detail:note||"已处理并归档",ip:ctx.ip});
  return {id,status:"已归档",handled_at:at,message:"申请已处理并归档"};
 });
 router.post("/api/admin/public-event-proposals/:id/convert",async ctx=>{
  if(!isSuper(ctx.user))throw forbidden("只有总管理员可以将公众活动申请转为内部立项");
  const id=String(ctx.params.id||"");
  const assoc=String(ctx.body?.assoc||"").trim();
  if(!require("../lib/associations").has(assoc))throw bad("请选择有效的所属协会");
  const output=transaction(()=>{
   const previous=db.prepare("SELECT project_id FROM public_proposal_project_links WHERE proposal_id=?").get(id);
   if(previous)return {project:{id:previous.project_id,status:db.prepare("SELECT status FROM projects WHERE id=?").get(previous.project_id)?.status||"草稿"},alreadyConverted:true};
   const p=db.prepare("SELECT * FROM public_event_proposals WHERE id=?").get(id);
   if(!p)throw Object.assign(new Error("公众活动申请不存在"),{status:404,code:"NOT_FOUND"});
   const projectId=nextMeetingId(db,assoc,p.event_date),at=now();
   const fields=["id","name","assoc","form","date","days","budget","tax_fee_rate","people",
    "owner","owner_id","phone","dept","agenda","public_event_time","public_contact_name",
    "public_contact_info","event_start_time","event_end_date","event_end_time",
    "status","status_at","created_by","created_at","updated_at"];
   const lastDate=p.event_end_date||p.event_date;
   const dayCount=1+Math.round((Date.parse(lastDate+"T00:00:00Z")-Date.parse(p.event_date+"T00:00:00Z"))/86400000);
   const vals=[projectId,p.topic,assoc,p.form,p.event_date,Math.min(60,Math.max(1,dayCount)),Number(p.budget),
    Number(p.tax_fee_rate)||0,Number(p.people)||0,
    ctx.user.name,ctx.user.id,p.contact_phone,p.dept||"",p.agenda,p.event_time,p.contact_name,
    p.contact_info||"",p.event_time,lastDate,p.event_end_time||p.event_time,
    "草稿",at,ctx.user.id,at,at];
   db.prepare("INSERT INTO projects ("+fields.join(",")+") VALUES ("+fields.map(()=>"?").join(",")+")").run(...vals);
   db.prepare("INSERT OR IGNORE INTO project_members(project_id,user_id,role) VALUES (?,?,?)").run(projectId,ctx.user.id,"创建人");
   db.prepare("INSERT INTO public_proposal_project_links(proposal_id,project_id,converted_by,converted_at) VALUES (?,?,?,?)")
    .run(id,projectId,ctx.user.id,at);
   db.prepare("UPDATE public_event_proposals SET status='已归档', handled_at=COALESCE(handled_at,?), handled_by=COALESCE(handled_by,?) WHERE id=?")
    .run(at,ctx.user.id,id);
   return {project:{id:projectId,status:"草稿"},alreadyConverted:false};
  });
  if(!output.alreadyConverted)logAudit({user:ctx.user,module:"项目管理",action:"公众活动申请转内部立项",target:output.project.id,
    detail:"来源申请 "+id+"；总管理员创建草稿，未提交审批",ip:ctx.ip});
  return {...output,sourceProposalId:id,
    message:output.alreadyConverted?"该公众申请已有内部项目，已返回原项目":"已转入内部立项并保存为草稿（未提交审批）"};
 });
}
module.exports={register,validate,recognizeAgenda,proposalSubmissionDay,nextPublicProposalId};
