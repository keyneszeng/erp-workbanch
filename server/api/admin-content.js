"use strict";
// Superadmin-only content corrections. IDs, provenance, file bytes, credentials and historical approvals are not mutable.
const {db,transaction}=require("../lib/db");
const {isSuper}=require("../lib/rbac");
const {getProject}=require("../lib/workflow");
const {bad,conflict,forbidden,notFound,now}=require("../lib/util");
const {logAudit}=require("../lib/audit");
const f=(k,l,t="text",required=false,opts=null)=>({k,l,t,required,...(opts?{opts}:{})});
const projectStatuses=["草稿","待审批","已立项","筹备中","执行中","待核销","已核销","已结算","已归档"];
const TYPES={
 project:{table:"projects",pk:"id",self:true,label:"立项与项目资料",fields:[
  f("name","项目名称","text",true),f("assoc","所属协会","text",true),f("form","会议形式","text",true),
  f("date","会议日期","date",true),f("days","会议天数","int",true),
  f("budget","会议预算","money",true),f("tax_fee_rate","税费管理费率","rate",true),
  f("people","参会人数","int",true),f("owner","负责人"),f("phone","联系电话"),
  f("dept","部门"),f("agenda","会议议程","long"),f("public_event_time","活动时间"),
  f("public_contact_name","公众活动联系人"),f("public_contact_info","公众活动联系信息"),
  f("status","项目状态","enum",true,projectStatuses)
 ]},
 contracts:{table:"contracts",label:"会务合同及已签署合同",fields:[
  f("name","合同名称","text",true),f("vendor","签约方","text",true),f("amount","合同金额","money",true),
  f("sign_date","签署日期","date"),f("category","合同类别"),f("remark","备注","long"),
  f("status","合同状态","enum",true,["草稿","待签署","已签署","已终止"])
 ]},
 materials:{table:"materials",label:"材料收集",fields:[
  f("kind","材料类别","text",true),f("name","材料名称","text",true),f("version","材料版本")
 ]},
 payments:{table:"payments",label:"付款单及付款记录",fields:[
  f("type","付款类型","text",true),f("payee","收款方","text",true),
  f("payee_bank","开户行"),f("payee_account","银行账户"),
  f("amount","付款金额","money",true),f("invoice_no","发票号码"),
  f("period","归属期间"),f("remark","备注","long"),
  f("status","付款状态","enum",true,["待审批","已审批","已驳回","已付款"])
 ]},
 settlements:{table:"settlements",label:"结算单（结余自动计算）",fields:[
  f("income","结算收入","money",true),f("expense","结算支出","money",true),
  f("tax_fee_rate","税费管理费率","rate"),f("payee","结算对象"),
  f("payee_bank","开户行"),f("payee_account","银行账号")
 ]},
 sponsor_contracts:{table:"meeting_sponsor_contracts",label:"企业赞助合同",fields:[
  f("enterprise","赞助企业","text",true),f("contract_no","合同编号","text",true),
  f("amount","赞助金额","money",true),f("status","赞助状态","text",true)
 ]},
 sponsor_receipts:{table:"meeting_sponsor_receipts",label:"赞助到账记录",fields:[
  f("amount","到账金额","money",true),f("payment_ref","银行流水号","text",true),
  f("received_date","到账日期","date",true)
 ]},
 sponsor_invoices:{table:"meeting_sponsor_invoices",label:"赞助发票",fields:[
  f("amount","发票金额","money",true),f("invoice_no","发票号","text",true),
  f("issued_date","开票日期","date",true)
 ]},
 sponsor_rights:{table:"sponsor_rights",label:"企业赞助权益",fields:[
  f("category","权益类别","text",true),f("confirmed","是否确认","bool",true,["0","1"])
 ]},
 demand_items:{table:"demand_items",label:"会务需求明细",fields:[
  f("grp","需求分组","text",true),f("item","需求事项","text",true),
  f("note","事项备注","long"),f("need","是否需要","enum",true,["需要","不需要"]),
  f("spec","规格说明"),f("owner","负责人"),f("due","交付日期","date"),
  f("budget","预算金额"),f("quantity","数量"),f("unit_price","单价"),
  f("status","执行状态","text",true),f("ordering","排序","int")
 ]},
 demand_sheets:{table:"demand_sheets",pk:"pid",self:true,label:"需求单确认状态",fields:[
  f("confirmed","已归档","bool",true,["0","1"])
 ]},
 verify_steps:{table:"verify_steps",pk:"step_no",label:"七步核销结果",fields:[
  f("name","核销事项","text",true),
  f("result","核销结果","enum",true,["待判定","通过","不通过","已解例外"]),
  f("remark","核销备注","long"),f("invoice_amount","核对发票金额","money")
 ]},
 exceptions:{table:"exceptions",label:"核销例外单",fields:[
  f("step_label","例外类别"),f("reason","问题说明","long",true),
  f("status","处理状态","text",true),f("comment","处理意见","long")
 ]},
 approvals:{table:"approvals",label:"审批单",fields:[
  f("title","审批事项","text",true),f("amount","审批金额","money"),
  f("sla","审批时限"),f("comment","审批意见","long"),
  f("status","审批状态","text",true)
 ]},
 initiation_letters:{table:"project_initiation_letters",pk:"pid",self:true,label:"内部立项函正文",fields:[
  f("title","立项函标题","text",true),f("body","立项函正文","long",true)
 ]},
 guests:{table:"guests",label:"会议嘉宾",fields:[
  f("name","姓名","text",true),f("org","单位"),f("title","职务"),
  f("phone","联系电话"),f("status","嘉宾状态","text",true)
 ]},
 tasks:{table:"tasks",label:"筹备任务",fields:[
  f("name","任务名称","text",true),f("owner","负责人"),f("due","交付日期","date"),
  f("status","任务状态","text",true),f("priority","优先级")
 ]},
 issues:{table:"issues",label:"项目问题与风险",fields:[
  f("title","问题名称","text",true),f("level","风险级别"),
  f("owner","负责人"),f("status","处理状态","text",true)
 ]},
 material_tasks:{table:"meeting_material_tasks",label:"材料核对任务",fields:[
  f("kind","材料类别","text",true),f("speaker","讲者","text",true),
  f("topic","课题","text",true),f("status","任务状态","text",true)
 ]},
 invitations:{table:"prep_invitations",label:"企业及嘉宾邀请",fields:[
  f("recipient_email","收件人邮箱"),f("expires_at","有效期限"),
  f("channel","邀请渠道"),f("status","邀请状态","text",true)
 ]}
};
const NUMERIC_IDS=new Set(["materials","sponsor_rights","demand_items","guests","tasks","issues","meeting_material_tasks"]);
function admin(ctx){if(!isSuper(ctx.user))throw forbidden("此功能仅总管理员可以查看与修改");}
function schema(k){const t=TYPES[k];if(!t)throw bad("不存在此修订类别");return t;}
function recordId(t,raw){
 const s=String(raw??"").trim();if(!s||s.length>100)throw bad("记录编号无效");
 if(t.pk==="step_no"||NUMERIC_IDS.has(t.table)){if(!/^[1-9]\d{0,12}$/.test(s))throw bad("记录编号无效");return Number(s);}
 return s;
}
function where(t){return t.self?(t.pk||"id")+"=?":"pid=? AND "+(t.pk||"id")+"=?";}
function keys(t,pid,id){return t.self?[pid]:[pid,id];}
function read(t,pid,id){return db.prepare("SELECT * FROM "+t.table+" WHERE "+where(t)).get(...keys(t,pid,id));}
function parse(f,v){
 if(v==null||String(v).trim()===""){
  if(f.required)throw bad(f.l+"不能留空");
  return null;
 }
 if(["money","rate","int","bool"].includes(f.t)){
  const n=Number(v);
  if(!Number.isFinite(n)||n<0||n>1e9)throw bad(f.l+"必须是有效的非负数字");
  if(["int","bool"].includes(f.t)&&!Number.isSafeInteger(n))throw bad(f.l+"必须是整数");
  if(f.t==="bool"&&![0,1].includes(n))throw bad(f.l+"取值无效");
  if(f.t==="rate"&&(n>100||Math.abs(n*100-Math.round(n*100))>1e-7))throw bad(f.l+"必须为0～100的最多两位小数");
  if(f.t==="money"&&Math.abs(n*100-Math.round(n*100))>1e-7)throw bad(f.l+"最多两位小数");
  return n;
 }
 const s=String(v).trim();
 if(s.length>(f.t==="long"?12000:800))throw bad(f.l+"长度超限");
 if(f.t==="enum"&&!f.opts.includes(s))throw bad(f.l+"选项无效");
 if(f.t==="date"&&!/^\d{4}-\d{2}-\d{2}$/.test(s))throw bad(f.l+"请填写YYYY-MM-DD");
 return s;
}
function redact(k,v){return /bank|account|phone|contact|email|token|password/i.test(k)?"（敏感内容已修订）":String(v??"（空）").slice(0,90);}
function logDetail(oldValue,newValue,reason,id){
 return "记录："+id+"；"+Object.keys(newValue).map(k=>k+"："+redact(k,oldValue[k])+"→"+redact(k,newValue[k])).join("；").slice(0,2600)+"；原因："+reason;
}
function register(router){
 router.get("/api/admin/content/types",async ctx=>{
  admin(ctx);return {types:Object.entries(TYPES).map(([key,t])=>({key,label:t.label,fields:t.fields}))};
 });
 router.get("/api/admin/content/projects",async ctx=>{
  admin(ctx);const q=String(ctx.query.q||"").trim();if(q.length>80)throw bad("查询过长");
  const like="%"+q+"%";
  return {rows:db.prepare("SELECT id,name,assoc,status FROM projects WHERE id LIKE ? OR name LIKE ? OR assoc LIKE ? ORDER BY date DESC,id DESC LIMIT 100").all(like,like,like)};
 });
 router.get("/api/admin/content/:pid/:kind",async ctx=>{
  admin(ctx);const p=getProject(ctx.params.pid),t=schema(ctx.params.kind);
  const page=Number(ctx.query.page||1),size=Number(ctx.query.size||30);
  if(!Number.isInteger(page)||page<1||page>100000||!Number.isInteger(size)||size<1||size>100)throw bad("分页参数无效");
  const filter=t.self?(t.pk||"id")+"=?":"pid=?";
  const total=db.prepare("SELECT COUNT(*) AS n FROM "+t.table+" WHERE "+filter).get(p.id).n;
  const cols=[...new Set([t.pk||"id",...(t.self?[]:["pid"]),...t.fields.map(f=>f.k),...(t.table==="settlements"?["profit"]:[])])];
  const rows=db.prepare("SELECT "+cols.join(",")+" FROM "+t.table+" WHERE "+filter+" ORDER BY "+(t.pk||"id")+" DESC LIMIT ? OFFSET ?").all(p.id,size,(page-1)*size);
  return {project:{id:p.id,name:p.name,status:p.status},rows,total,page,size,pages:Math.max(1,Math.ceil(total/size)),
   fields:t.fields,label:t.label,kind:ctx.params.kind};
 });
 router.get("/api/admin/content/:pid/:kind/:id/history",async ctx=>{
  admin(ctx);const pid=getProject(ctx.params.pid).id,t=schema(ctx.params.kind),id=recordId(t,ctx.params.id);
  if(!read(t,pid,id))throw notFound("记录不存在");
  return {rows:db.prepare("SELECT id,reason,before_json,after_json,changed_by,changed_at FROM admin_content_revisions WHERE pid=? AND entity_type=? AND record_id=? ORDER BY id DESC LIMIT 50").all(pid,ctx.params.kind,String(id))};
 });
 router.patch("/api/admin/content/:pid/:kind/:id",async ctx=>{
  admin(ctx);const pid=getProject(ctx.params.pid).id,kind=ctx.params.kind,t=schema(kind),id=recordId(t,ctx.params.id);
  const b=ctx.body||{},reason=String(b.reason||"").trim();
  if(reason.length<8||reason.length>500)throw bad("请填写8～500字的修订原因");
  if(!b.changes||typeof b.changes!=="object"||Array.isArray(b.changes))throw bad("必须提交修改字段");
  if(!b.expected||typeof b.expected!=="object"||Array.isArray(b.expected))throw bad("需要修改前原值以防止覆盖其他修改");
  const allowed=new Map(t.fields.map(f=>[f.k,f])),keysChanged=Object.keys(b.changes);
  if(!keysChanged.length||keysChanged.length>t.fields.length)throw bad("请选择需要修改的字段");
  const before=read(t,pid,id);if(!before)throw notFound("业务记录不存在");
  const patch={};
  for(const k of keysChanged){
   if(!allowed.has(k))throw bad("禁止修改该字段："+k);
   if(!Object.prototype.hasOwnProperty.call(b.expected,k)||JSON.stringify(before[k])!==JSON.stringify(b.expected[k]))
    throw conflict("记录已发生变化，请刷新后重新修改","CONTENT_CHANGED");
   const value=parse(allowed.get(k),b.changes[k]);
   if(JSON.stringify(value)!==JSON.stringify(before[k]))patch[k]=value;
  }
  if(!Object.keys(patch).length)return {row:before,message:"内容无变化"};
  if(kind==="contracts"&&(patch.status==="已签署"||(!("status" in patch)&&before.status==="已签署"))&&!(patch.sign_date||before.sign_date))
   throw bad("已签署合同必须具有签署日期");
  if(kind==="settlements"&&("income" in patch||"expense" in patch))
   patch.profit=Math.round((Number(patch.income??before.income)-Number(patch.expense??before.expense))*100)/100;
  if(kind==="payments"&&patch.status==="已付款"&&!before.paid_at)patch.paid_at=now();
  const at=now();
  const row=transaction(()=>{
   const latest=read(t,pid,id);
   if(!latest)throw notFound("记录已删除");
   for(const k of keysChanged)if(JSON.stringify(latest[k])!==JSON.stringify(before[k]))
    throw conflict("保存前记录发生变化","CONTENT_CHANGED");
   db.prepare("UPDATE "+t.table+" SET "+Object.keys(patch).map(k=>k+"=?").join(",")+" WHERE "+where(t))
    .run(...Object.values(patch),...keys(t,pid,id));
   const next=read(t,pid,id);
   const oldFields=Object.fromEntries(Object.keys(patch).map(k=>[k,before[k]]));
   const newFields=Object.fromEntries(Object.keys(patch).map(k=>[k,next[k]]));
   db.prepare("INSERT INTO admin_content_revisions(pid,entity_type,record_id,reason,before_json,after_json,changed_by,changed_at) VALUES (?,?,?,?,?,?,?,?)")
    .run(pid,kind,String(id),reason,JSON.stringify(oldFields),JSON.stringify(newFields),ctx.user.name,at);
   logAudit({user:ctx.user,module:"总管理员内容修订",action:"强制修订："+t.label,target:pid,
    detail:logDetail(oldFields,newFields,reason,id),ip:ctx.ip});
   return next;
  });
  const safe=Object.fromEntries([t.pk||"id",...(t.self?[]:["pid"]),...t.fields.map(f=>f.k),...(t.table==="settlements"?["profit"]:[])].map(k=>[k,row[k]]));
  return {row:safe,message:"更正已保存；历史版本已保留。涉及账目、合同或核销时请复核关联记录"};
 });
}
module.exports={register,TYPES};
