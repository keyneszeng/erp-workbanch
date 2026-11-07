"use strict";
/** OCR material comparison: suggestions only; the reviewer, never OCR, makes the final decision. */
const crypto=require("node:crypto"),{db}=require("./db"),{storage}=require("./storage");
const {now,conflict}=require("./util"),{isDemoMode}=require("./runtime");
const ocr=require("./ocr-engine"),{laborSheetInfo}=require("./labor-sop");
const {contractPool}=require("./labor-contracts"),{demandSopState}=require("./meeting-demand-sop");
const {sponsorRights}=require("./sponsor-rights");
const office=require("./verify-office-text");
const OCR_TYPES=new Set(["jpg","png","pdf"]),MAX_FILES=32;
const KINDS={
 1:["会议通知","招商函","串场"],2:["终版议程","签到表","讲者照片"],
 3:["签到表","在线记录","直播数据","在线时长","会议截图"],
 4:["终版议程","课件"],5:["劳务表","劳务收集表","合同"],
 6:["终版议程","会务协议","合同","发票","会务发票"],
 7:["权益照片","赞助合同","合同"]
};
const norm=x=>String(x||"").normalize("NFKC").replace(/[\s\u3000,，.;；：:—-]/g,"").toLowerCase();
const sha=x=>crypto.createHash("sha256").update(JSON.stringify(x)).digest("hex");
const contains=(text,term)=>!!norm(term)&&norm(text).includes(norm(term));
const dateContains=(text,date)=>{
 const [y,m,d]=String(date||"").split("-");
 return !!y&&[y+"-"+m+"-"+d,y+"/"+Number(m)+"/"+Number(d),y+"年"+Number(m)+"月"+Number(d)+"日"].some(v=>contains(text,v));
};
const cmp=(name,value,detail,source=[])=>({name,status:value===true?"一致":value===false?"不一致":"无法确认",detail:String(detail||"").slice(0,180),source});
const ids=a=>a.map(x=>x.materialId);
function materials(pid,no){
 return db.prepare("SELECT id,kind,name,version,file_key,file_name FROM materials WHERE pid=? AND (deleted_at IS NULL OR deleted_at='') AND file_key IS NOT NULL AND file_key<>'' ORDER BY id").all(pid)
 .filter(m=>(KINDS[no]||[]).includes(m.kind)&&!(m.kind==="终版议程"&&m.version==="历史版")).slice(0,MAX_FILES);
}
function cache(m,pid){
 return db.prepare("SELECT recognized_text,engine,mode,pages,total_pages,truncated FROM material_ocr_results WHERE material_id=? AND pid=? AND file_key=?").get(m.id,pid,m.file_key);
}
function persist(m,pid,result,operator){
 db.prepare("INSERT INTO material_ocr_results(material_id,pid,file_key,recognized_text,suggestions_json,engine,mode,pages,total_pages,truncated,updated_at,updated_by) VALUES (?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(material_id) DO UPDATE SET file_key=excluded.file_key,recognized_text=excluded.recognized_text,suggestions_json=excluded.suggestions_json,engine=excluded.engine,mode=excluded.mode,pages=excluded.pages,total_pages=excluded.total_pages,truncated=excluded.truncated,updated_at=excluded.updated_at,updated_by=excluded.updated_by")
 .run(m.id,pid,m.file_key,result.text,JSON.stringify(m.kind==="终版议程"?ocr.parseAgenda(result.text):[]),
  result.engine,result.mode,result.pages,result.totalPages,result.truncated?1:0,now(),operator);
}
async function scan(pid,no,operator){
 if(!isDemoMode()&&(!ocr.enabled()||storage().name!=="fs"))
  throw Object.assign(new Error("当前部署未启用真实OCR，请在阿里云ECS配置 ERP_OCR_ENABLED=1、Tesseract 和 Poppler"),{status:503,code:"OCR_NOT_CONFIGURED"});
 let processed=0;
 for(const m of materials(pid,no)){
  if(cache(m,pid))continue;
  const ext=m.file_key.split(".").pop().toLowerCase();
  if((!OCR_TYPES.has(ext)&&!office.SUPPORTED.has(ext))||isDemoMode())continue; // 测试环境不捏造OCR。
  const file=await storage().get(m.file_key);
  if(!file)continue;
  try{persist(m,pid,OCR_TYPES.has(ext)?await ocr.recognize(file.buffer,ext):office.extract(file.buffer,ext),operator);processed++;}
  catch(e){
   if(["OCR_DISABLED","OCR_ENGINE_MISSING","OCR_UNAVAILABLE","OCR_TIMEOUT"].includes(e.code))throw e;
   // 损坏原件在报告里明确标为“无法确认”，其余原件仍可正常识别。
  }
 }
 return {...report(pid,no),processed};
}
function amounts(t){
 const list=[];
 for(const x of String(t||"").matchAll(/(?:价税合计|合计金额|发票金额|总金额|金额|人民币|[¥￥]|Total)\s*[:：]?\s*[¥￥]?\s*([0-9][0-9,]*(?:\.[0-9]{1,2})?)/gi)){
  const n=Number(x[1].replace(/,/g,""));
  if(n>0&&n<1e9)list.push(n);
 }
 return [...new Set(list)];
}
function report(pid,no){
 const p=db.prepare("SELECT id,name,assoc,date,form FROM projects WHERE id=?").get(pid);
 const docs=materials(pid,no).map(m=>{
  const r=cache(m,pid),ext=m.file_key.split(".").pop().toLowerCase();
  return {materialId:m.id,kind:m.kind,name:m.name,fileName:m.file_name,fileKey:m.file_key,
   version:m.version,mode:r?.mode||null,pages:r?.pages||0,totalPages:r?.total_pages||0,
   truncated:!!r?.truncated,state:r?"recognized":OCR_TYPES.has(ext)||office.SUPPORTED.has(ext)?"not-recognized":"unsupported",
   text:r?.recognized_text||""};
 });
 const by=k=>docs.filter(x=>x.kind===k),txt=k=>by(k).map(x=>x.text).filter(Boolean).join("\n");
 const checks=[],add=(name,value,detail,source=[])=>checks.push(cmp(name,value,detail,source));
 const agenda=txt("终版议程"),agendaDocs=by("终版议程");
 let invoiceAmount=null;
 if(no===1){
  const letters=[...by("会议通知"),...by("招商函")],hosts=by("串场");
  add("函件与串场原件",letters.length&&hosts.length?true:null,"函件"+letters.length+"份、串场"+hosts.length+"份",ids([...letters,...hosts]));
  for(const [name,value,test] of [["会议标题",p.name,contains],["会议日期",p.date,dateContains],["所属协会",p.assoc,contains]]){
   const a=letters.some(x=>x.text&&test(x.text,value)),b=hosts.some(x=>x.text&&test(x.text,value));
   add(name,!letters.some(x=>x.text)||!hosts.some(x=>x.text)?null:a&&b,
    "函件："+(a?"已识别":"未找到")+"，串场："+(b?"已识别":"未找到"),ids([...letters,...hosts]));
  }
  add("原件盖章真实性",null,"OCR无法验证实体印章或签章法律效力，需人工查看");
 }else if(no===2){
  const people=[...new Set(ocr.parseAgenda(agenda).map(x=>x.speaker))],att=txt("签到表"),photos=by("讲者照片");
  add("议程讲者",people.length?true:null,"识别到"+people.length+"名讲者",ids(agendaDocs));
  add("签到表讲者信息",people.length&&att?people.every(n=>contains(att,n)):null,
    "签到表中匹配"+people.filter(n=>contains(att,n)).length+"/"+people.length+"名讲者",ids(by("签到表")));
  add("讲者照片",people.length&&photos.length?people.every(n=>photos.some(x=>contains(x.name,n))):null,
    "已上传"+photos.length+"份照片；真人身份及重复照片仍需人工核对",ids(photos));
 }else if(no===3){
  if(["线下","混合"].includes(p.form))
   add("线下签到表",txt("签到表")?true:null,"签到表文字识别不代表签字真实",ids(by("签到表")));
  if(["线上","混合"].includes(p.form)){
   const online=docs.filter(x=>/在线|直播|时长/.test(x.kind));
   const minutes=online.flatMap(x=>[...x.text.matchAll(/(?:有效时长|在线时长|讲者时长)\s*[:：]?\s*(\d{1,4})\s*分钟/g)].map(x=>Number(x[1])));
   add("在线时长超过30分钟",minutes.length?minutes.every(x=>x>30):null,
    minutes.length?"识别时长："+minutes.join("、")+"分钟":"未提取到有效在线时长",ids(online));
  }
 }else if(no===4){
  const topics=ocr.parseAgenda(agenda).map(x=>x.topic),courses=by("课件");
  add("终版议程课题",topics.length?true:null,"OCR识别"+topics.length+"个主题",ids(agendaDocs));
  for(const file of courses){
   const first=file.text.split("\n").slice(0,15).join("\n");
   const matched=topics.some(x=>contains(first,x));
   add("课件："+String(file.name).slice(0,50),first&&topics.length?matched:null,
    matched?"课件标题与终版议程匹配":"未找到可靠的课题匹配，需人工核对",[file.materialId]);
  }
  if(!courses.length)add("课件原件",null,"缺少已上传课件");
 }else if(no===5){
  const labor=[...by("劳务表"),...by("劳务收集表")],contracts=by("合同");
  const names=[...new Set(labor.flatMap(x=>[...x.text.matchAll(/(?:姓名|讲者|专家)\s*[:：]?\s*([\u4e00-\u9fa5]{2,5})/g)].map(m=>m[1])))];
  add("劳务原件",labor.some(x=>x.text)?true:null,"劳务表OCR只用于核验；银行账号不显示或保存到核销证据",ids(labor));
  add("个人合同原件",contracts.length?true:null,"合同"+contracts.length+"份；须人工核对姓名、费用及银行账号",ids(contracts));
  add("劳务姓名与个人合同",names.length?names.every(name=>contracts.some(x=>contains(x.name,name)||contains(x.fileName,name))):null,
    names.length?"提取"+names.length+"位姓名并比对已上传个人合同登记":"未可靠提取劳务名单，需人工核查",ids([...labor,...contracts]));
 }else if(no===6){
  const d=demandSopState(db,pid);
  const agreements=[...by("会务协议"),...by("合同")].filter(x=>x.kind==="会务协议"||/会务协议|会务合同|会议服务合同/.test(x.name));
  const invoices=[...by("发票"),...by("会务发票")];
  const extracted=invoices.map(x=>amounts(x.text));
  invoiceAmount=extracted.length&&extracted.every(x=>x.length===1)?extracted.reduce((n,x)=>n+Math.round(x[0]*100),0)/100:null;
  add("会议主题",agenda&&agreements.some(x=>x.text)?contains(agenda,p.name)&&agreements.some(x=>contains(x.text,p.name)):null,
    "以议程和会务协议OCR原文比较",ids([...agendaDocs,...agreements]));
  add("会议日期",agenda&&agreements.some(x=>x.text)?dateContains(agenda,p.date)&&agreements.some(x=>dateContains(x.text,p.date)):null,
    "预计日期："+p.date,ids([...agendaDocs,...agreements]));
  add("协议甲方",agreements.some(x=>x.text)?agreements.some(x=>contains(x.text,p.assoc)):null,
    "应为项目所属协会",ids(agreements));
  add("需求预算与合同金额",d.contractCount?Math.round(d.budgetTotal*100)===Math.round(d.contractTotal*100):null,
    "预算"+d.budgetTotal+"元，已签合同"+d.contractTotal+"元");
  add("发票金额三方一致",invoiceAmount!=null?
    Math.round(invoiceAmount*100)===Math.round(d.budgetTotal*100)&&Math.round(invoiceAmount*100)===Math.round(d.contractTotal*100):null,
    invoiceAmount!=null?"OCR提取发票"+invoiceAmount+"元":"未能可靠提取唯一发票金额",ids(invoices));
 }else if(no===7){
  const rights=sponsorRights(db,pid);
  add("赞助权益类别",rights.requiredRights.length&&rights.requiredRights.every(x=>x.confirmed)?true:null,
    "已确认权益"+rights.requiredRights.length+"项");
  for(const r of rights.requiredRights){
   const pictures=rights.photos.filter(x=>Number(x.sponsor_right_id)===Number(r.id)&&x.file_key);
   add("权益交付："+r.category,null,pictures.length+"份照片，OCR无法判断实际交付及照片真实性",pictures.map(x=>x.id));
  }
 }
 for(const file of docs.filter(x=>x.state!=="recognized"))
  add("文件识别："+file.name,null,file.state==="unsupported"?
    "该格式无法直接OCR，请补充 PDF/JPG/PNG 原件":"文件缺失、无文字或未识别成功",[file.materialId]);
 for(const file of docs.filter(x=>x.truncated))
  add("超出扫描页数："+file.name,null,"共"+file.totalPages+"页，仅识别前"+file.pages+"页，需人工核对剩余页面",[file.materialId]);
 if(!docs.length)add("原件",null,"没有本步骤可以扫描的有效文件");
 const fingerprint={
  docs:docs.map(x=>[x.materialId,x.fileKey,x.version,x.state,x.mode,x.text?sha(x.text):null]),
  project:[p.name,p.assoc,p.date,p.form],
  demand:no===6?demandSopState(db,pid).signature:null,
  rights:no===7?sponsorRights(db,pid).signature:null
 };
 const token=sha({pid,no,fingerprint});
 const evidence={origin:"ocr-assisted-human-review",scanToken:token,
  sources:docs.map(x=>({materialId:x.materialId,kind:x.kind,fileKey:x.fileKey,state:x.state,pages:x.pages,totalPages:x.totalPages,truncated:x.truncated})),
  checkSummary:{match:checks.filter(x=>x.status==="一致").length,mismatch:checks.filter(x=>x.status==="不一致").length,
    uncertain:checks.filter(x=>x.status==="无法确认").length},
  ...(no===2?{matchedSources:["终版议程","签到表","讲者照片"]}:{}),
  ...(no===5?{laborSourceSignature:laborSheetInfo(db,pid).signature,contractPoolSignature:contractPool(db,pid).signature}:{}),
  ...(no===6?{demandSopSignature:demandSopState(db,pid).signature}:{}),
  ...(no===7?{rightsSignature:sponsorRights(db,pid).signature}:{})
 };
 return {pid,no,token,scanned:docs.filter(x=>x.state==="recognized").length,total:docs.length,
  invoiceAmount,checks,evidence,summary:evidence.checkSummary,
  files:docs.map(({text,fileKey,...x})=>({...x,
    preview:String(text).replace(/(?:\d[ -]?){10,25}/g,"[敏感数字已隐藏]").split("\n").filter(Boolean).slice(0,3).join(" · ").slice(0,160)})),
  warning:"OCR和文本比对仅供人工参考；印章真实性、人员身份、照片权益及未识别页必须查原件确认。"};
}
function verifiedReport(pid,no,token){
 const result=report(pid,no);
 if(!token||token!==result.token)throw conflict("OCR原件或识别结果发生变化，请重新扫描","OCR_REPORT_STALE");
 return result;
}
module.exports={scan,report,verifiedReport,listMaterials:materials,amounts,MAX_FILES};
