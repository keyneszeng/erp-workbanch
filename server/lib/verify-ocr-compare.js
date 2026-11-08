"use strict";
/** OCR material comparison: suggestions only; the reviewer, never OCR, makes the final decision. */
const crypto=require("node:crypto"),{db}=require("./db"),{storage}=require("./storage");
const {now,conflict}=require("./util"),{isDemoMode}=require("./runtime");
const ocr=require("./ocr-engine"),{laborSheetInfo}=require("./labor-sop");
const {contractPool,linkLaborContracts}=require("./labor-contracts"),{demandSopState}=require("./meeting-demand-sop");
const {sponsorRights}=require("./sponsor-rights");
const office=require("./verify-office-text");
const agendaEvidence=require("./verify-agenda-evidence");
const {extractInvoiceAmount}=require("./invoice-extract");
const OCR_TYPES=new Set(["jpg","png","pdf"]),MAX_FILES=32;
const KINDS={
 1:["会议通知","招商函","串场"],2:["终版议程","讲者照片"],
 3:["签到表","在线记录","直播数据","在线时长","会议截图"],
 4:["终版议程","课件"],5:["劳务表","劳务登记表","劳务收集表"],
 6:[],
 7:[]
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
 const docs=db.prepare("SELECT id,kind,name,version,file_key,file_name FROM materials WHERE pid=? AND (deleted_at IS NULL OR deleted_at='') AND file_key IS NOT NULL AND file_key<>'' ORDER BY id").all(pid);
 const expertIds=no===5?new Set(contractPool(db,pid).rows.map(x=>Number(x.id))):null;
 if(no===6){
  const d=demandSopState(db,pid);
  const ids=new Set([...d.agreements,...d.invoices].map(x=>Number(x.id)));
  return docs.filter(m=>ids.has(Number(m.id))).slice(0,MAX_FILES);
 }
 if(no===7){
  const sponsors=sponsorRights(db,pid);
  const keys=new Set(sponsors.contracts.map(x=>x.file_key).filter(Boolean));
  const photos=new Set(sponsors.photos.filter(x=>x.file_key).map(x=>Number(x.id)));
  return docs.filter(m=>photos.has(Number(m.id)) ||
    (["合同","赞助合同"].includes(m.kind)&&keys.has(m.file_key))).slice(0,MAX_FILES);
 }
 return docs.filter(m=>((KINDS[no]||[]).includes(m.kind)||(expertIds?.has(Number(m.id))))
  &&!(m.kind==="终版议程"&&((no===2||no===4)?m.version!=="终版":m.version==="历史版"))).slice(0,MAX_FILES);
}
function cache(m,pid){
 const row=db.prepare("SELECT recognized_text,engine,mode,pages,total_pages,truncated FROM material_ocr_results WHERE material_id=? AND pid=? AND file_key=?").get(m.id,pid,m.file_key);
 if(!row)return null;
 const ext=m.file_key.split(".").pop().toLowerCase();
 // 原生 Office/TXT 文本并非 OCR，仍可复用；图片和扫描 PDF 必须来自 RapidOCR。
 // Previous XLSX reader appended the entire shared-string pool, including unused names,
 // so its cached "recognized" result cannot be trusted for speaker verification.
 if(ext==="xlsx"&&row.engine!==office.XLSX_ENGINE)return null;
 if(!OCR_TYPES.has(ext))return office.SUPPORTED.has(ext)?row:null;
 return ocr.providerMatches(row.engine)?row:null;
}
function persist(m,pid,result,operator){
 db.prepare("INSERT INTO material_ocr_results(material_id,pid,file_key,recognized_text,suggestions_json,engine,mode,pages,total_pages,truncated,updated_at,updated_by) VALUES (?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(material_id) DO UPDATE SET file_key=excluded.file_key,recognized_text=excluded.recognized_text,suggestions_json=excluded.suggestions_json,engine=excluded.engine,mode=excluded.mode,pages=excluded.pages,total_pages=excluded.total_pages,truncated=excluded.truncated,updated_at=excluded.updated_at,updated_by=excluded.updated_by")
 .run(m.id,pid,m.file_key,result.text,JSON.stringify(m.kind==="终版议程"?ocr.parseAgenda(result.text):[]),
  result.engine,result.mode,result.pages,result.totalPages,result.truncated?1:0,now(),operator);
}
async function scan(pid,no,operator){
 const docs=materials(pid,no);
 // Step 6 is a materials-link check; invoice OCR is not a prerequisite.
 if(no===6)return {...report(pid,no),processed:0};
 const available=ocr.enabled()&&storage().name==="fs";
 // Native Office files (including XLSX attendance) never require RapidOCR.
 // On demo installs do not simulate image recognition, but do read real Office bytes.
 const officePresent=docs.some(m=>office.SUPPORTED.has(m.file_key.split(".").pop().toLowerCase()));
 if(!isDemoMode()&&!available&&!officePresent&&no!==7&&no!==6)
  throw Object.assign(new Error("当前部署未启用 RapidOCR，请在阿里云 ECS 配置 ERP_OCR_ENABLED=1，安装 RapidOCR (ONNX Runtime CPU) 和 Poppler；Excel原生表格可不依赖 RapidOCR 解析"),{status:503,code:"OCR_NOT_CONFIGURED"});
 // Step 7 can always be reviewed from the original signed sponsor agreements
 // and photos; image OCR cannot prove that contractual rights were delivered.
 let processed=0;
 for(const m of docs){
  if(cache(m,pid))continue;
  const ext=m.file_key.split(".").pop().toLowerCase();
  const nativeOffice=office.SUPPORTED.has(ext);
  if(!nativeOffice&&(!OCR_TYPES.has(ext)||isDemoMode()||!available))continue;
  const file=await storage().get(m.file_key);
  if(!file?.buffer)continue;
  try{
   const result=nativeOffice?office.extract(file.buffer,ext):await ocr.recognize(file.buffer,ext);
   if(result?.text?.trim()){persist(m,pid,result,operator);processed++;}
  }catch(e){
   if(["OCR_DISABLED","OCR_ENGINE_MISSING","OCR_PROVIDER_MISCONFIGURED","OCR_UNAVAILABLE","OCR_TIMEOUT"].includes(e.code))throw e;
   // Corrupt/unreadable originals remain 'not recognized' in the report; never
   // pretend a failed or ambiguous document was a verified attendance list.
  }
 }
 return {...report(pid,no),processed};
}
// Compatibility helper: only the VAT-inclusive total is meaningful for an invoice.
function amounts(text){
 const value=extractInvoiceAmount(text);
 return value===null?[]:[value];
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
  // Step 2 is strictly FINAL agenda -> speaker photo original filenames.
  // Attendance belongs to step 3 and never affects this result.
  const people=agendaEvidence.agendaSpeakers(agenda),photos=by("讲者照片");
  const photoNames=photos.map(x=>agendaEvidence.photoName({file_name:x.fileName,name:x.name}));
  const matched=agendaEvidence.compareNames(people,photoNames);
  const invalid=photoNames.filter(x=>!x).length;
  add("终版议程讲者提取",agendaDocs.length===1&&people.length?true:null,
    agendaDocs.length===1&&people.length?"从当前终版议程提取"+people.length+"位讲者":"尚未从唯一的当前终版议程可靠提取姓名",ids(agendaDocs));
  const checkable=agendaDocs.length===1&&people.length&&photos.length;
  const status=!checkable?null:invalid?false:matched.matched;
  const problems=[];
  if(matched.missing.length)problems.push("缺少："+matched.missing.join("、"));
  if(matched.extra.length)problems.push("多出："+matched.extra.join("、"));
  if(matched.duplicate.length)problems.push("重复："+matched.duplicate.join("、"));
  if(invalid)problems.push("无法从文件名提取姓名："+invalid+"份");
  add("讲者照片姓名与终版议程",status,
    "终版议程"+people.length+"位、照片"+photos.length+"份；"+
    (problems.join("；")|| (status===true?"逐人姓名完全一致":"需要核对原件及照片文件名")),
    ids([...agendaDocs,...photos]));
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
  const topics=agendaEvidence.agendaTopics(agenda),courses=by("课件");
  const allowed=new Set(topics.map(agendaEvidence.topicKey));
  add("终版议程课题",agendaDocs.length===1&&topics.length?true:null,
    agendaDocs.length===1&&topics.length?"从当前终版议程提取"+topics.length+"个主题":"无法从唯一当前终版议程提取课题",ids(agendaDocs));
  for(const file of courses){
   const courseTopics=agendaEvidence.courseTopics(file.text,topics);
   const notFound=courseTopics.filter(topic=>!allowed.has(agendaEvidence.topicKey(topic)));
   const canCompare=agendaDocs.length===1&&topics.length&&courseTopics.length&&!file.truncated;
   add("课件："+String(file.name).slice(0,50),canCompare?notFound.length===0:null,
    canCompare?notFound.length?"课件课题不在终版议程："+notFound.join("、").slice(0,90):
      "已提取"+courseTopics.length+"个课件主题，均在当前终版议程中":
      "课件主题未可靠提取，或原件未完整识别；需打开终版议程与课件核对",
    ids([...agendaDocs,file]));
  }
  if(!courses.length)add("课件原件",null,"缺少已上传课件");
 }else if(no===5){
  const labor=[...by("劳务表"),...by("劳务登记表"),...by("劳务收集表")];
  const pool=contractPool(db,pid);
  const contractIds=new Set(pool.rows.map(x=>Number(x.id)));
  const contracts=docs.filter(x=>contractIds.has(Number(x.materialId)));
  const names=[...new Set(labor.flatMap(x=>{
    const text=String(x.text||"");
    const labeled=[...text.matchAll(/(?:^|\n)[ \t]*(?:姓名|讲者姓名|专家姓名|讲者|专家)[ \t]*[:：][ \t]*([\u4e00-\u9fa5]{2,5})/g)].map(m=>m[1]);
    // Native XLSX uses a tab-separated row per attendee. Only accept the
    // explicit 姓名 column: do not extract random Chinese words from a contract.
    const lines=text.split("\n"),header=lines.findIndex(row=>row.split("\t").some(cell=>cell.trim()==="姓名"));
    if(header>=0){
      const col=lines[header].split("\t").findIndex(cell=>cell.trim()==="姓名");
      for(const line of lines.slice(header+1)){
        if(/^工作表\s+\d+/.test(line))break;
        const name=String(line.split("\t")[col]||"").trim();
        if(/^[\u4e00-\u9fa5]{2,5}$/.test(name)&&name!=="姓名")labeled.push(name);
      }
    }
    return labeled;
  }))];
  const linked=names.length?linkLaborContracts(db,pid,names):null;
  add("劳务登记表原件",labor.some(x=>x.text)?true:null,
    "已关联"+labor.length+"份劳务登记表；银行账号不显示或保存到核销证据",ids(labor));
  add("劳务专家合同原件",contracts.length?true:null,
    "仅关联劳务专家类别或明确标注专家劳务的合同，共"+contracts.length+"份",ids(contracts));
  add("劳务姓名与专家合同",names.length?linked.missing.length===0&&linked.ambiguous.length===0:null,
    names.length?"提取"+names.length+"位人员，匹配"+linked.linked.length+"份专家合同；缺失"+
      linked.missing.length+"位，歧义"+linked.ambiguous.length+"位":"未可靠提取劳务名单，需人工核查",
    ids([...labor,...contracts]));
 }else if(no===6){
  const d=demandSopState(db,pid);
  const contractIds=new Set(d.agreements.map(x=>Number(x.id)));
  const invoiceIds=new Set(d.invoices.map(x=>Number(x.id)));
  const agreements=docs.filter(x=>contractIds.has(Number(x.materialId)));
  const invoices=docs.filter(x=>invoiceIds.has(Number(x.materialId)));
  // Step 6 requires a linked invoice original, not OCR extraction of its amount.
  // Keep invoice text recognition optional; it must not block a linked-file check.
  invoiceAmount=null;
  add("会务需求表",d.required?d.confirmed:null,
    d.required?"已登记需求表，确认归档："+(d.confirmed?"是":"否")+"；预算"+d.budgetTotal+"元":"未建立会务需求表");
  add("已签会务合同原件",d.contractCount&&agreements.length?true:null,
    "已签「会务需求」合同"+d.contractCount+"份，关联原件"+agreements.length+"份",ids(agreements));
  add("会务需求表与会务合同金额一致",d.contractCount?
    Math.round(d.budgetTotal*100)===Math.round(d.contractTotal*100):null,
    "需求表"+d.budgetTotal+"元，会务合同"+d.contractTotal+"元",ids(agreements));
  add("已关联会务发票原件",invoices.length>0,
    invoices.length?"已关联"+invoices.length+"份会务发票原件":"尚未关联会务发票原件",ids(invoices));
 }else if(no===7){
  const rights=sponsorRights(db,pid);
  add("赞助合同与权益来源",rights.activeContracts.length?true:null,
    "已签署赞助合同"+rights.activeContracts.length+"份；涉及权益内容"+rights.rights.length+
      "项、权益照片"+rights.photos.filter(x=>x.file_key).length+"份");
  add("赞助权益类别",rights.requiredRights.length&&rights.requiredRights.every(x=>x.confirmed)?true:null,
    "已确认权益"+rights.requiredRights.length+"项");
  for(const r of rights.requiredRights){
   const pictures=rights.photos.filter(x=>Number(x.sponsor_right_id)===Number(r.id)&&x.file_key);
   add("权益交付："+r.category,null,pictures.length+"份照片，OCR无法判断实际交付及照片真实性",pictures.map(x=>x.id));
  }
 }
 for(const file of docs.filter(x=>x.state!=="recognized"&&no!==6&&!(no===2&&x.kind==="讲者照片")))
  add("文件识别："+file.name,null,file.state==="unsupported"?
    "该格式无法直接OCR，请补充 PDF/JPG/PNG 原件":"文件缺失、无文字或未识别成功",[file.materialId]);
 for(const file of docs.filter(x=>x.truncated&&no!==6))
  add("超出扫描页数："+file.name,null,"共"+file.totalPages+"页，仅识别前"+file.pages+"页，需人工核对剩余页面",[file.materialId]);
 if(!docs.length)add("原件",null,"没有本步骤可以扫描的有效文件");
 const fingerprint={
  docs:docs.map(x=>[x.materialId,x.fileKey,x.name,x.fileName,x.version,x.state,x.mode,x.text?sha(x.text):null]),
  project:[p.name,p.assoc,p.date,p.form],
  demand:no===6?demandSopState(db,pid).signature:null,
  laborContracts:no===5?contractPool(db,pid).signature:null,
  rights:no===7?sponsorRights(db,pid).signature:null
 };
 const token=sha({pid,no,fingerprint});
 const evidence={origin:"ocr-assisted-human-review",scanToken:token,
  sources:docs.map(x=>({materialId:x.materialId,kind:x.kind,fileKey:x.fileKey,state:x.state,pages:x.pages,totalPages:x.totalPages,truncated:x.truncated})),
  checkSummary:{match:checks.filter(x=>x.status==="一致").length,mismatch:checks.filter(x=>x.status==="不一致").length,
    uncertain:checks.filter(x=>x.status==="无法确认").length},
  ...(no===2?{matchedSources:["终版议程","讲者照片"]}:{}),
  ...(no===5?{laborSourceSignature:laborSheetInfo(db,pid).signature,contractPoolSignature:contractPool(db,pid).signature}:{}),
  ...(no===6?{demandSopSignature:demandSopState(db,pid).signature}:{}),
  ...(no===7?{rightsSignature:sponsorRights(db,pid).signature}:{})
 };
 return {pid,no,token,scanned:docs.filter(x=>x.state==="recognized").length,total:docs.length,
  invoiceAmount,checks,evidence,summary:evidence.checkSummary,
  ...(no===6?{demandSheet:(d=>({exists:d.required,confirmed:d.confirmed,
    budgetTotal:d.budgetTotal,needCount:d.needCount,contractTotal:d.contractTotal}))(demandSopState(db,pid))}:{}),
  ...(no===7?{sponsorContracts:sponsorRights(db,pid).contracts.map(x=>({
    id:x.id,enterprise:x.enterprise,status:x.status,fileName:x.file_name,fileKey:x.file_key}))}:{}),
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
