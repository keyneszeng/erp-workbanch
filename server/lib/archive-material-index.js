"use strict";
/**
 * Project-scoped source catalogue for the digital dossier.
 * Files are collected from the business owner tables, not guessed from the
 * materials upload table. No cross-project ID or client-supplied file key.
 */
const {db}=require("./db");
const {createReportPdf}=require("./archive-pdf");
const {invitationPdf}=require("./prep-invitation");
const {canonicalMaterialKind}=require("./constants");

const GROUPS=Object.freeze([
 "立项通知","会议说明书","招商函","赞助企业合同","进款凭证",
 "赞助企业合同关联发票","会议照片(现场照片和权益照片)","签到表",
 "劳务收集表","专家劳务协议","串场文件","课件","会务协议",
 "会务需求单","会务合同关联发票"
]);
const OTHER="其他材料";
const RANK=new Map([...GROUPS,OTHER].map((k,i)=>[k,i]));
const limitText=(s,n=240)=>String(s??"").replace(/[\u0000-\u001f\u007f]/g," ").trim().slice(0,n);

function classifyMaterial(row){
 const k=canonicalMaterialKind(limitText(row.kind,70));
 const words=[k,row.name,row.file_name].map(x=>String(x||"")).join(" ");
 if(/立项通知|项目通知函|立项文件|会议通知/.test(k))return GROUPS[0];
 if(/会议说明书|会议说明|会务说明/.test(k))return GROUPS[1];
 if(/招商函|企业邀请/.test(k))return GROUPS[2];
 if(/赞助合同|赞助企业合同|企业赞助/.test(k))return GROUPS[3];
 if(/进款凭证|收款凭证|到账回单/.test(k))return GROUPS[4];
 if(/赞助发票|企业赞助发票/.test(k))return GROUPS[5];
 if(/现场照片|权益照片|讲者照片|会议照片|会议截图|照片|摄影/.test(k))return GROUPS[6];
 if(/签到|参会记录|在线记录|考勤/.test(k))return GROUPS[7];
 if(/劳务表|劳务收集/.test(k))return GROUPS[8];
 if(/劳务协议|专家劳务|专家协议/.test(k))return GROUPS[9];
 if(/串场|主持稿/.test(k))return GROUPS[10];
 if(/课件|演示文稿|授课PPT/.test(k))return GROUPS[11];
 if(/会务协议|会务合同|合同/.test(k)){
  if(/劳务|专家/.test(words))return GROUPS[9];
  if(/赞助/.test(words))return GROUPS[3];
  return GROUPS[12];
 }
 if(/需求单|会务需求/.test(k))return GROUPS[13];
 if(/发票|税票/.test(k))return GROUPS[14];
 // Do not guess the category from an ambiguous filename when the user
 // explicitly entered a different material category.
 return OTHER;
}
/**
 * The 15-category dossier order is an invariant, not a client preference.
 * Preserve the source's native insertion order inside each category:
 * business-owner originals before upload mirrors; SQLite rows already arrive
 * by created_at/id or numeric material.id. A caller may rearrange files only
 * within the same category.
 */
function sourceRank(source){
 const kind=RANK.has(source.kind)?source.kind:classifyMaterial(source);
 return RANK.get(kind)??RANK.get(OTHER);
}
function sortDossierSources(sources){
 return sources.map((source,position)=>({source,position,rank:sourceRank(source)}))
  .sort((a,b)=>a.rank-b.rank||a.position-b.position)
  .map(x=>x.source);
}
function listArchiveSources(project){
 const pid=project.id,seen=new Set(),sources=[];
 function add(group,id,name,opts={}){
  if(!group||!id)return;
  const key=opts.file_key||null;
  if(key&&seen.has(key))return; // The same original appears in material mirrors.
  if(key)seen.add(key);
  sources.push({
   source_id:id,kind:group,name:limitText(name,160)||"未命名资料",
   file_key:key,file_name:opts.file_name||null,
   file_mime:opts.file_mime||null,file_size:opts.file_size||0,
   generated:!!opts.generated,source_type:opts.source_type||"材料库",
   ...(opts.virtual?{virtual:opts.virtual}:{})
  });
 }
 // Business owner tables first: each file has an unambiguous document type.
 for(const r of db.prepare("SELECT id,enterprise,contract_no,file_key,file_name FROM meeting_sponsor_contracts WHERE pid=? ORDER BY created_at,id").all(pid)){
  if(r.file_key)add(GROUPS[3],"sponsor-contract:"+r.id,r.enterprise+" · "+r.contract_no,
   {...r,source_type:"企业赞助合同"});
 }
 for(const r of db.prepare("SELECT id,amount,payment_ref,file_key,file_name FROM meeting_sponsor_receipts WHERE pid=? ORDER BY created_at,id").all(pid)){
  if(r.file_key)add(GROUPS[4],"sponsor-receipt:"+r.id,"到账回单 "+r.payment_ref+" · ¥"+Number(r.amount||0).toFixed(2),
   {...r,source_type:"赞助收款"});
 }
 for(const r of db.prepare("SELECT id,invoice_no,amount,file_key,file_name FROM meeting_sponsor_invoices WHERE pid=? ORDER BY created_at,id").all(pid)){
  if(r.file_key)add(GROUPS[5],"sponsor-invoice:"+r.id,"赞助关联发票 "+r.invoice_no,
   {...r,source_type:"赞助开票"});
 }
 for(const r of db.prepare("SELECT id,name,vendor,category,status,file_key,file_name,file_mime,file_size FROM contracts WHERE pid=? AND deleted_at IS NULL ORDER BY created_at,id").all(pid)){
  if(!r.file_key)continue;
  const category=r.category==="企业赞助"?GROUPS[3]:r.category==="劳务专家"?GROUPS[9]:GROUPS[12];
  add(category,"contract:"+r.id,r.name+" · "+r.vendor,{...r,source_type:"项目合同"});
 }
 // Generated enterprise invitation snapshots are real records, not unsigned
 // files from a user-supplied URL. Rendering occurs only on download.
 for(const r of db.prepare("SELECT id,snapshot_json,status FROM prep_invitations WHERE pid=? AND type='enterprise' AND status<>'已撤销' ORDER BY created_at,id").all(pid)){
  try{
   const snapshot=JSON.parse(r.snapshot_json);
   add(GROUPS[2],"invitation:"+r.id,(snapshot.subject||"招商邀请函")+"（"+r.status+"）",{
    generated:true,source_type:"企业邀请快照",file_name:r.id+"-招商函.pdf",
    file_mime:"application/pdf",virtual:{type:"invitation",snapshot}
   });
  }catch{ /* historical malformed snapshot: never fake a valid original */ }
 }
 // Normal materials and custom uploads that have not already been included.
 const materials=db.prepare("SELECT id,kind,name,version,file_key,file_name,file_mime,file_size FROM materials WHERE pid=? AND (deleted_at IS NULL OR deleted_at='') AND file_key IS NOT NULL AND file_key<>'' ORDER BY id").all(pid);
 for(const r of materials)add(classifyMaterial(r),"material:"+r.id,r.name||r.file_name,{
  ...r,source_type:"材料收集"
 });
 // Synthetic PDFs are explicitly marked as system summaries. They do not
 // pretend to be stamped approval letters or an externally signed original.
 if(!sources.some(x=>x.kind===GROUPS[0])){
  const n=db.prepare("SELECT snapshot_json,approved_by,approved_at,backfilled FROM project_notices WHERE pid=?").get(pid);
  const fallback=db.prepare("SELECT title,body FROM project_initiation_letters WHERE pid=?").get(pid);
  let snap=null;try{if(n)snap=JSON.parse(n.snapshot_json)}catch{}
  const note=n?(n.backfilled?"历史补发立项通知（系统摘要）":"立项通知（审批快照摘要）"):"项目立项信息（系统摘要，未找到正式通知快照）";
  add(GROUPS[0],"auto:notice",note,{
   generated:true,source_type:"立项/通知快照",file_name:"立项通知-系统摘要.pdf",
   file_mime:"application/pdf",virtual:{type:"notice",snapshot:snap,
    letter:fallback,approved_by:n?.approved_by||"",approved_at:n?.approved_at||""}
  });
 }
 if(!sources.some(x=>x.kind===GROUPS[1])){
  add(GROUPS[1],"auto:description","会议说明书（系统项目数据摘要）",{
   generated:true,source_type:"项目基本信息",file_name:"会议说明书-系统摘要.pdf",
   file_mime:"application/pdf",virtual:{type:"description"}
  });
 }
 if(!sources.some(x=>x.kind===GROUPS[13])){
  const sheet=db.prepare("SELECT confirmed,confirmed_by,confirmed_at FROM demand_sheets WHERE pid=?").get(pid);
  if(sheet){
   const rows=db.prepare("SELECT grp,item,need,spec,quantity,unit_price,budget FROM demand_items WHERE pid=? ORDER BY ordering,id").all(pid);
   if(rows.length)add(GROUPS[13],"auto:demand","会务需求单（系统登记汇总）",{
    generated:true,source_type:"会务需求",file_name:"会务需求单-系统摘要.pdf",
    file_mime:"application/pdf",virtual:{type:"demand",sheet,rows}
   });
  }
 }
 return sortDossierSources(sources);
}
function publicSource(s){
 return {source_id:s.source_id,kind:s.kind,name:s.name,file_name:s.file_name,
  file_mime:s.file_mime,file_size:s.file_size,generated:s.generated,source_type:s.source_type};
}
function categorySummary(sources){
 return [...GROUPS,OTHER].map(kind=>({
  kind,count:sources.filter(s=>s.kind===kind).length,
  generated:sources.filter(s=>s.kind===kind&&s.generated).length
 }));
}
function toPdfLines(project,source){
 const v=source.virtual||{};
 const b=(x)=>({kind:"body",text:limitText(x,600)});
 const heading=(x)=>({kind:"section",text:limitText(x,180)});
 const intro=[heading("会议编号："+project.id),b("会议名称："+project.name),
  b("所属协会："+project.assoc),b("会议日期："+project.date+"；会期："+(project.days||1)+"天")];
 if(v.type==="notice"){
  const s=v.snapshot;
  return [heading("立项资料说明"),...intro,
   ...(s?[b("审批快照时间："+v.approved_at+"；审批人："+v.approved_by),
    b("通知函标题："+(s["通知函标题"]||"")),
    b("立项函标题："+(s["立项函标题"]||"")),
    b(s["立项函正文"]||"")]:
    [b("本页仅为系统项目摘要，不代表正式审批通知或已盖章原件。"),
     b("立项函标题："+(v.letter?.title||"未留存")),
     b(v.letter?.body||"请查看项目基本资料及历史审批记录。")])];
 }
 if(v.type==="description")return [heading("会议说明书（系统生成）"),...intro,
  b("会议形式："+project.form),b("负责人："+(project.owner||"未登记")),
  b("预计参会人数："+(project.people||0)),b("会议预算：¥"+Number(project.budget||0).toFixed(2)),
  b("会议议程："+(project.agenda||"未登记")),b("此说明书根据当前项目数据生成，不等于已签署或盖章的会议文件。")];
 if(v.type==="demand")return [heading("会务需求单（系统生成）"),...intro,
  b("确认状态："+(v.sheet.confirmed?"已确认":"未确认")),
  b("确认人："+(v.sheet.confirmed_by||"—")+"，确认日期："+(v.sheet.confirmed_at||"—")),
  ...v.rows.map(r=>b(r.grp+" / "+r.item+" / "+r.need+" / "+(r.spec||"")+" / 数量："+(r.quantity||"—")+
   " / 单价："+(r.unit_price||"—")+" / 预算："+(r.budget||"—")))];
 return [heading("系统项目资料"),...intro];
}
function buildVirtualPdf(project,source){
 if(source.virtual?.type==="invitation")return invitationPdf(source.virtual.snapshot);
 return createReportPdf(toPdfLines(project,source),source.kind,{footer:"会规智云 · 系统登记内容摘要 · 非盖章原件"});
}
/** Resolve server-side file keys / generated PDFs for existing PDF bundler. */
async function pdfMaterials(project,selected,store){
 const cache=new Map();
 const mapped=selected.map(s=>{
  if(!s.generated)return {...s};
  const syntheticKey="virtual:"+s.source_id;
  cache.set(syntheticKey,buildVirtualPdf(project,s));
  return {...s,file_key:syntheticKey,file_name:s.file_name||s.kind+".pdf",
   file_mime:"application/pdf"};
 });
 return {materials:mapped,store:{name:store.name,get:key=>cache.has(key)?
  Promise.resolve({buffer:cache.get(key),mime:"application/pdf"}):store.get(key)}};
}
module.exports={GROUPS,OTHER,classifyMaterial,sourceRank,sortDossierSources,listArchiveSources,publicSource,categorySummary,pdfMaterials,buildVirtualPdf,toPdfLines};
