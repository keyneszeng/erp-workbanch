"use strict";
/**
 * Public event proposals are a separate intake channel, NOT internal project
 * initiation. No projects, approvals, members or workflow rows are created.
 */
const crypto=require("node:crypto");
const {db}=require("../lib/db");
const {bad,forbidden}=require("../lib/util");
const {isSuper}=require("../lib/rbac");
const FORMS=new Set(["线下","线上","混合"]);
function str(v,max,label,{required=true}={}){
 if(typeof v!=="string")throw bad(label+"格式不正确");
 const s=v.trim();
 if((required&&!s)||s.length>max||/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(s))
  throw bad(label+"不能为空或超过"+max+"字");
 return s;
}
function validate(input){
 if(!input||typeof input!=="object"||Array.isArray(input))throw bad("申请内容格式不正确");
 // Honeypot is checked before database writes.
 if(input.website)throw bad("提交内容无效");
 const topic=str(input.topic,120,"活动主题");
 const event_date=str(input.event_date,10,"活动日期");
 if(!/^\d{4}-\d{2}-\d{2}$/.test(event_date)||
    (!Number.isFinite(Date.parse(event_date+"T00:00:00.000Z")) || new Date(event_date+"T00:00:00.000Z").toISOString().slice(0,10)!==event_date))
    throw bad("请选择有效活动日期");
 const event_time=str(input.event_time,5,"活动时间");
 if(!/^([01]\d|2[0-3]):[0-5]\d$/.test(event_time))throw bad("请选择有效活动开始时间");
 const form=str(input.form,10,"活动形式");
 if(!FORMS.has(form))throw bad("活动形式只能是线上、线下或混合");
 // Amount is expressed as a currency decimal, disallow exponent and negatives.
 if(!/^(0|[1-9]\d{0,10})(?:\.\d{1,2})?$/.test(String(input.budget??"")))
    throw bad("预算须为不超过两位小数的人民币金额");
 const budget=Number(input.budget);
 if(!Number.isFinite(budget)||budget>10000000000)throw bad("预算金额超出允许范围");
 const agenda=str(input.agenda,3000,"活动议程");
 const contact_name=str(input.contact_name,60,"联系人");
 const contact_phone=str(input.contact_phone,30,"联系电话");
 if(!/^[+\d][\d\s+()\-]{5,29}$/.test(contact_phone))throw bad("请填写有效联系电话");
 const contact_info=str(input.contact_info||"",200,"补充联系方式",{required:false});
 if(input.consent!==true)throw bad("请同意个人信息用于本次活动联系及管理");
 return {topic,event_date,event_time,form,budget,agenda,contact_name,contact_phone,contact_info};
}
const fingerprint=ip=>crypto.createHash("sha256").update(
 String(process.env.ERP_PUBLIC_PROPOSAL_HASH_SALT||"erp-proposal")+"|"+String(ip||"unknown")
).digest("hex");
function register(router){
 router.post("/api/public/event-proposals",async ctx=>{
  if(process.env.ERP_PUBLIC_PROPOSALS_ENABLED==="0")
   throw Object.assign(new Error("公众活动申请入口暂未开放"),{status:503,code:"PUBLIC_PROPOSALS_DISABLED"});
  const v=validate(ctx.body);
  // Alibaba Cloud nginx overwrites X-Real-IP with its verified client IP.
  // Trust it only when reverse-proxy mode is enabled and the connection is local.
  const proxyIp=String(ctx.req?.headers?.["x-real-ip"]||"");
  const trustedProxy=process.env.ERP_TRUST_PROXY==="1"&&
    ["127.0.0.1","::1","::ffff:127.0.0.1"].includes(String(ctx.ip));
  const sourceIp=trustedProxy&&/^[a-f\d.:]{3,45}$/i.test(proxyIp)?proxyIp:ctx.ip;
  const hash=fingerprint(sourceIp),at=new Date().toISOString();
  const since=new Date(Date.now()-60*60*1000).toISOString();
  const recent=db.prepare("SELECT COUNT(*) AS n FROM public_event_proposals WHERE submitter_fingerprint=? AND received_at>=?").get(hash,since);
  if(Number(recent?.n)>=8)
   throw Object.assign(new Error("提交过于频繁，请稍后再试"),{status:429,code:"PUBLIC_PROPOSAL_RATE_LIMIT"});
  const id="PP-"+crypto.randomBytes(12).toString("hex");
  db.prepare("INSERT INTO public_event_proposals "+
   "(id,topic,event_date,event_time,form,budget,agenda,contact_name,contact_phone,contact_info,consent_at,received_at,submitter_fingerprint,status) "+
   "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
   .run(id,v.topic,v.event_date,v.event_time,v.form,v.budget,v.agenda,v.contact_name,v.contact_phone,v.contact_info,at,at,hash,"已接收");
  return {reference:id,status:"已接收",message:"活动申请已送达总管理员收件箱，此提交不进入内部立项审批流程"};
 });
 router.get("/api/admin/public-event-proposals",async ctx=>{
  if(!isSuper(ctx.user))throw forbidden("只有总管理员可查看公众活动申请与联系方式");
  const page=Math.max(1,Math.min(10000,Number(ctx.query.page)||1));
  const size=Math.max(1,Math.min(100,Number(ctx.query.size)||30));
  const total=Number(db.prepare("SELECT COUNT(*) AS n FROM public_event_proposals").get().n);
  const rows=db.prepare("SELECT id,topic,event_date,event_time,form,budget,agenda,contact_name,contact_phone,contact_info,received_at,status "+
     "FROM public_event_proposals ORDER BY received_at DESC,id DESC LIMIT ? OFFSET ?").all(size,(page-1)*size);
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
}
module.exports={register,validate};
