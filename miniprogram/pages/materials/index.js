const app=getApp();
const MAX_MATERIAL_FILES_PER_BATCH=10;
const MAX_FILE_BYTES=20*1024*1024;
const CONTRACT_TYPES=[{value:"会务需求",label:"会务协议"},{value:"劳务专家",label:"劳务协议"},{value:"企业赞助",label:"企业赞助合同"}];
const frozenStatus=s=>["已核销","已结算","已归档"].includes(s);
const emptyContract=()=>({categoryIndex:0,name:"",vendor:"",amount:"",rightsText:"",statusIndex:0,signDate:"",file:null,scanNote:""});
// 相册图片没有原始文件名（wxfile://tmp_xxx.jpg），无法按文件名关联讲者，
// 因此讲者照片额外提供「相册选图 → 逐张填姓名」的通道，姓名拼成文件名后走同一套上传。
let speakerSeq=0;
Page({
 data:{projects:[],index:0,pid:"",directoryOpen:true,directoryLoading:false,directoryError:"",directorySearch:"",directoryProjects:[],directoryStats:null,allMaterials:false,materialStats:{count:0,uploaded:0,kinds:0},kindCounts:[],historyCounts:[],kind:"课件",name:"",error:"",busy:false,uploaded:"",
  // 类别由服务端统一下发；不维护独立的客户端类别清单。
  activeKinds:[],historyKinds:[],disabledKinds:[],categoryDisabled:false,materialRows:[],visibleFiles:[],filesLoading:false,
  custom:false,customKind:"",locked:false,canMaterialWrite:false,canMaterialRead:false,canContractRead:false,canMaterialReplace:false,materialMutationLocked:false,batchResults:[],speakerFiles:[],deletingId:0,
  archiveAllowed:false,archiveOpen:false,archiveSources:[],archiveCustomWatermark:false,archiveWatermarkMode:0,archiveWatermarkOptions:["操作员＋时间","无水印","自定义水印"],archiveWatermarkText:"",historyContract:"",historyRows:[],contractMode:false,contractsLoading:false,contractRows:[],contractError:"",canUploadContract:false,
  contractTypes:CONTRACT_TYPES,contractStatuses:["草稿","待签署","已签署"],contractDraft:emptyContract(),contractNotice:"",
  sponsorRights:[{id:"",label:"请选择赞助权益类目"}],rightIndex:0,rightId:""},
 onLoad(q){if(q.pid)this.setData({pid:q.pid,directoryOpen:false});},
 onShow(){if(!this.data.busy&&!this.data.archiveOpen)return this.load();},
 async load(){
  if(!this.data.pid)return this.loadDirectory();
  this.setData({directoryOpen:false});
  try{
   const r=await app.api("/projects?page=1&size=100");
   const projects=(r.rows||[]).slice();
   // 归档项目可能在后续分页；不只显示最近100场会议。
   const pages=Number(r.pages)||Math.ceil(Number(r.total||projects.length)/100);
   for(let page=2;page<=pages;page++){
    const next=await app.api("/projects?page="+page+"&size=100");
    for(const p of next.rows||[])if(!projects.some(x=>x.id===p.id))projects.push(p);
   }
   // 指定项目可能不在第一页；不能悄悄把材料归档到另一场会议。
   if(this.data.pid&&!projects.some(x=>x.id===this.data.pid)){
    try{
     const one=await app.api("/projects/"+encodeURIComponent(this.data.pid));
     if(one.project)projects.unshift(one.project);
    }catch(e){this.setData({error:"指定会议不可访问："+e.message});return;}
   }
   let index=projects.findIndex(x=>x.id===this.data.pid);if(index<0)index=0;
   const p=projects[index];
   this.setData({projects,index,pid:p?.id||"",archiveAllowed:false,locked:!p||["已结算","已归档"].includes(p.status),canMaterialWrite:false,canMaterialRead:false,canContractRead:false,canMaterialReplace:false,materialMutationLocked:!p||frozenStatus(p.status),
     materialRows:[],visibleFiles:[],historyKinds:[],filesLoading:!!p,contractRows:[],contractError:"",contractsLoading:false,canUploadContract:false});
   if(p){await this.loadKinds(p.id);if(this.data.contractMode&&this.data.canContractRead)await this.loadContracts(p.id);else if(this.data.kind==="权益照片"&&this.data.canMaterialWrite&&!this.data.locked)await this.loadRights(p.id);}
  }catch(e){this.setData({error:e.message});}
 },
 async loadDirectory(){
  const seq=(this._directorySeq||0)+1;this._directorySeq=seq;
  this.setData({directoryOpen:true,directoryLoading:true,directoryError:"",directoryProjects:[],directoryStats:null});
  try{
   const d=await app.api("/materials?page=1&size=1");
   if(this._directorySeq!==seq||!this.data.directoryOpen)return;
   const projects=(d.projects||[]).map(p=>({...p,have:p.have||[]}));
   this.setData({projects,directoryStats:{projects:projects.length,uploaded:projects.filter(p=>p.uploadedCount>0).length,total:d.total??0}});
   this.filterDirectory();
  }catch(e){
   if(this._directorySeq!==seq||!this.data.directoryOpen)return;
   // Project-only grants can still open the project detail, without granting materials-directory access.
   if(e.status===403||e.status===404){
    try{
     const r=await app.api("/projects?page=1&size=100"),projects=(r.rows||[]).slice();
     const pages=Number(r.pages)||Math.ceil(Number(r.total||projects.length)/100);
     for(let n=2;n<=pages;n++){
      const next=await app.api("/projects?page="+n+"&size=100");
      for(const p of next.rows||[])if(!projects.some(x=>x.id===p.id))projects.push(p);
     }
     if(this._directorySeq!==seq||!this.data.directoryOpen)return;
     this.setData({projects,directoryStats:null});this.filterDirectory();
    }catch(err){if(this._directorySeq===seq)this.setData({directoryError:err.message||"项目目录读取失败"});}
   }else this.setData({directoryError:e.message||"材料目录读取失败"});
  }finally{if(this._directorySeq===seq)this.setData({directoryLoading:false});}
 },
 filterDirectory(){
  const term=String(this.data.directorySearch||"").trim().toLowerCase();
  this.setData({directoryProjects:this.data.projects.filter(p=>!term||[p.id,p.name,p.status].some(v=>String(v||"").toLowerCase().includes(term)))});
 },
 searchDirectory(e){this.setData({directorySearch:e.detail.value});this.filterDirectory();},
 async openDirectoryProject(e){
  if(this.data.busy||this.data.directoryLoading)return;
  const index=this.data.projects.findIndex(p=>p.id===e.currentTarget.dataset.pid);
  if(index<0)return;
  this._directorySeq=(this._directorySeq||0)+1;
  this.setData({directoryOpen:false,allMaterials:false,kind:"课件",custom:false,customKind:"",contractMode:false});
  await this.select({detail:{value:index}});
 },
 async backDirectory(){
  if(this.data.busy||this.data.archiveOpen)return;
  this._materialSeq=(this._materialSeq||0)+1;this._contractSeq=(this._contractSeq||0)+1;this._batch=null;
  this.setData({pid:"",directoryOpen:true,allMaterials:false,materialRows:[],visibleFiles:[],contractMode:false,canMaterialRead:false,canMaterialWrite:false,canMaterialReplace:false,canContractRead:false,archiveAllowed:false,activeKinds:[],historyKinds:[],kindCounts:[],historyCounts:[]});
  await this.loadDirectory();
 },
 toggleAllMaterials(e){
  if(this.data.busy)return;
  this.setData({allMaterials:e.currentTarget.dataset.mode==="all"});this.syncVisibleFiles();
 },
 // The selected category is the entry form and the persistent file list.
 syncVisibleFiles(){
  const raw=this.data.custom?String(this.data.customKind||"").trim():this.data.kind;
  const selected=raw==="劳务收集表"?"劳务表":raw;
  const rows=this.data.materialRows;
  const counts=k=>rows.filter(r=>r.kind===k).length;
  const chips=k=>({kind:k,count:counts(k),disabled:this.data.disabledKinds.includes(k)});
  this.setData({categoryDisabled:this.data.disabledKinds.includes(selected),visibleFiles:this.data.allMaterials?rows:rows.filter(row=>row.kind===selected),kindCounts:this.data.activeKinds.map(chips),historyCounts:this.data.historyKinds.map(chips),materialStats:{count:rows.length,uploaded:rows.filter(r=>!!r.file_key).length,kinds:new Set(rows.map(r=>r.kind)).size}});
 },
 async loadKinds(pid,{preserveError=false}={}){
  if(!pid)return;
  const seq=(this._materialSeq||0)+1;this._materialSeq=seq;
  this.setData({filesLoading:true});
  try{
   // 与 Web 项目详情共用材料记录、原件标识、权限及类别目录。
   const data=await app.api("/projects/"+encodeURIComponent(pid));
   if(this.data.pid!==pid||this._materialSeq!==seq)return;
   const status=data.project?.status||this.data.projects[this.data.index]?.status;
   const perms=app.globalData?.perms||[];
   const canMaterialRead=data.sectionAccess?.materials===true,canContractRead=data.sectionAccess?.contracts===true;
   const locked=!!data.settlement||["已结算","已归档"].includes(status);
   this.setData({archiveAllowed:status==="已归档"&&perms.includes("archive:download"),locked,materialMutationLocked:locked||frozenStatus(status),canMaterialRead,canContractRead,
    canMaterialWrite:canMaterialRead&&perms.includes("material:write"),canMaterialReplace:canMaterialRead&&perms.includes("material:file:replace"),contractMode:canContractRead&&this.data.contractMode});
   if(!canMaterialRead){this.setData({activeKinds:[],historyKinds:[],disabledKinds:[],materialRows:[],visibleFiles:[],filesLoading:false,contractMode:canContractRead,error:canContractRead?"":"当前账号无材料查看权限"});return;}
   // 兼容旧部署/历史档案：「劳务收集表」只作为数据别名，绝不重新进入可选类别。
   const normalizedKind=k=>k==="劳务收集表"?"劳务表":k;
   let shared=data.materialsStatus?.categoryCatalog;
   if(!shared){
    // 旧服务端缺少共享目录时，尽量使用原工作台的类别；只读用户即使无法进入
    // 工作台，也能查看项目详情已经授权返回的历史文件，不能因此丢失整个材料列表。
    try{
     const legacy=await app.api("/projects/"+encodeURIComponent(pid)+"/material-workbench");
     if(this.data.pid!==pid||this._materialSeq!==seq)return;
     shared=legacy.categoryCatalog||{active:legacy.kinds||[],history:[],disabled:(legacy.modules||[]).filter(m=>m.enabled===0).map(m=>m.kind)};
    }catch(err){
     if(this.data.pid!==pid||this._materialSeq!==seq)return;
     if(err.status===401)throw err;
     shared={active:[],history:(data.materials||[]).filter(m=>!m.deleted_at).map(m=>m.kind),disabled:data.materialsStatus?.disabled||[]};
     this.setData({canMaterialWrite:false});
    }
   }
   const catalog=shared.active||[];
   const retired=new Set(["合同","会务协议","劳务协议","企业赞助合同","赞助合同","劳务专家合同","专家劳务协议","劳务合同","会务合同"]);
   const disabled=(shared.disabled||[]).map(normalizedKind);
   const kinds=[...new Set(catalog.map(normalizedKind))]
     .filter(k=>!retired.has(k)&&!disabled.includes(k));
   const rightById=new Map((data.sponsorRights?.rights||[]).map(r=>[Number(r.id),r]));
   const sponsorById=new Map((data.sponsorRights?.contracts||[]).map(c=>[c.id,c]));
   const rows=(data.materials||[]).filter(row=>row&&row.kind&&!row.deleted_at)
     .map(row=>{const right=rightById.get(Number(row.sponsor_right_id));return {...row,filename:row.file_name||row.name||row.file_key,kind:normalizedKind(row.kind),contractEvidence:retired.has(row.kind),sponsor_right_category:row.sponsor_right_category||right?.category||"",sponsor_enterprise:row.sponsor_enterprise||sponsorById.get(right?.sponsor_id)?.enterprise||""};});
   const history=[...new Set([...(shared.history||[]),...rows.map(row=>row.kind)].map(normalizedKind))]
     .filter(k=>!kinds.includes(k)&&!retired.has(k)).sort();
   // 历史合同及劳务协议、会务协议仍保存在服务端，不进入材料收集的可选类别。
   const chosen=this.data.kind;
   const kind=kinds.includes(chosen)||history.includes(chosen)?chosen:(kinds.includes("课件")?"课件":kinds[0]||history[0]||"现场照片");
   this.setData({activeKinds:kinds,historyKinds:history,disabledKinds:disabled,materialRows:rows,kind,
     filesLoading:false,...(preserveError?{}:{error:""})});
   this.syncVisibleFiles();
  }catch(e){
   if(this.data.pid===pid&&this._materialSeq===seq){
    this.setData({filesLoading:false,archiveAllowed:false,canMaterialWrite:false,canMaterialReplace:false,canMaterialRead:false,canContractRead:false,materialRows:[],visibleFiles:[],activeKinds:[],historyKinds:[],error:"材料文件列表读取失败："+e.message});
   }
  }
 },
 async select(e){if(this.data.busy||this.data.archiveOpen)return;this._batch=null;const index=Number(e.detail.value),p=this.data.projects[index];
  if(!p)return;
  this.setData({archiveOpen:false,archiveSources:[],archiveAllowed:false,index,pid:p.id,locked:["已结算","已归档"].includes(p.status),materialMutationLocked:frozenStatus(p.status),canMaterialWrite:false,canMaterialRead:false,canMaterialReplace:false,canContractRead:false,uploaded:"",
   batchResults:[],speakerFiles:[],materialRows:[],visibleFiles:[],activeKinds:[],historyKinds:[],disabledKinds:[],categoryDisabled:false,contractRows:[],contractError:"",contractsLoading:false,canUploadContract:false,contractDraft:emptyContract(),contractNotice:""});
  await this.loadKinds(p.id);
  if(this.data.pid!==p.id)return;
  if(this.data.contractMode&&this.data.canContractRead){await this.loadContracts(p.id);return;}
  if(this.data.kind==="权益照片"&&this.data.canMaterialWrite&&!this.data.locked)this.loadRights(p.id);else this.setData({sponsorRights:[{id:"",label:"请选择赞助权益类目"}],rightIndex:0,rightId:""});
 },
 chooseKind(e){
  if(this.data.busy)return;
  this._batch=null;const kind=e.currentTarget.dataset.kind;
  this.setData({kind,custom:false,customKind:"",uploaded:"",error:"",batchResults:[],speakerFiles:[],contractMode:false,allMaterials:false});
  this.syncVisibleFiles();
  if(kind==="权益照片"&&this.data.canMaterialWrite&&!this.data.locked)this.loadRights(this.data.pid);
 },
 // 与 Web 项目材料面板一致：合同是正式合同目录入口，不作为普通材料上传。
 chooseContracts(){
  if(this.data.busy||!this.data.pid)return;
  this._batch=null;
  this.setData({contractMode:true,custom:false,uploaded:"",error:"",batchResults:[],speakerFiles:[],...(this.data.contractMode?{}:{contractDraft:emptyContract(),contractNotice:""})});
  return this.loadContracts(this.data.pid);
 },
 async loadContracts(pid){
  const seq=(this._contractSeq||0)+1;this._contractSeq=seq;
  this.setData({historyContract:"",historyRows:[],contractsLoading:true,contractRows:[],contractError:"",canUploadContract:false});
  try{
   const data=await app.api("/projects/"+encodeURIComponent(pid));
   if(this.data.pid!==pid||this._contractSeq!==seq)return;
   if(data.sectionAccess?.contracts!==true){
    this.setData({contractsLoading:false,canContractRead:false,contractError:"当前账号无合同目录查看权限，请联系管理员授权"});return;
   }
   const labels={"会务需求":"会务协议","劳务专家":"劳务协议","企业赞助":"企业赞助合同"};
   const status=data.project?.status||this.data.projects[this.data.index]?.status;
   const perms=app.globalData?.perms||[],write=perms.includes("contract:write"),approve=perms.includes("contract:approve");
   const sealed=!!data.settlement||["已结算","已归档"].includes(status),mutable=!sealed&&!frozenStatus(status);
   const specialAdmin=status==="已归档"&&app.globalData?.user?.role==="admin";
   const rows=(data.contracts||[]).filter(c=>!c.deleted_at).map(c=>{
    const materialId=(data.materials||[]).find(m=>m.kind==="合同"&&!m.deleted_at&&m.file_key===c.file_key)?.id||null;
    return {id:c.id,name:c.name,vendor:c.vendor||"",category:labels[c.category]||c.category||"合同",categoryValue:c.category,
    status:c.status,fileKey:c.file_key||"",fileName:c.file_name||"",amount:Number(c.amount||0).toFixed(2),signDate:c.sign_date||"",creator:c.created_by_name||"",createdAt:c.created_at||"",remark:c.remark||"",materialId,
    canEdit:!sealed&&["草稿","待签署","已签署"].includes(c.status)&&(c.status==="已签署"?approve:write),
    canReplace:mutable&&perms.includes("material:file:replace")&&!!c.file_key&&!!materialId&&c.category!=="企业赞助",
    canReviewReplace:mutable&&approve&&c.status==="待签署",
    canDelete:mutable&&write&&(c.status==="已签署"?approve:["草稿","待签署"].includes(c.status)),
    canArchiveDelete:specialAdmin&&["草稿","待签署","已签署"].includes(c.status)&&c.category!=="企业赞助",
    canSubmit:mutable&&write&&c.status==="草稿",canSign:mutable&&approve&&c.status==="待签署",
    canHistory:write||approve,canAmend:!sealed&&write&&c.status==="已签署"};
   });
   this.setData({contractsLoading:false,contractRows:rows,canUploadContract:write&&mutable,canContractRead:true});
  }catch(e){
   if(this.data.pid===pid&&this._contractSeq===seq)this.setData({contractsLoading:false,contractError:"合同目录读取失败："+e.message});
  }
 },
 // 合同只通过正式合同接口登记，服务端同步归档原件；不重复调用普通材料接口。
 contractDraftInput(e){
  if(this.data.busy)return;
  const key=e.currentTarget.dataset.key;
  if(!["name","vendor","amount","rightsText"].includes(key))return;
  this.setData({contractDraft:{...this.data.contractDraft,[key]:e.detail.value}});
 },
 contractStatusChange(e){
  const index=Number(e.detail.value);
  if(!this.data.busy&&this.data.contractStatuses[index])this.setData({contractDraft:{...this.data.contractDraft,statusIndex:index}});
 },
 contractDateChange(e){
  if(!this.data.busy)this.setData({contractDraft:{...this.data.contractDraft,signDate:e.detail.value}});
 },
 contractCategoryChange(e){
  if(this.data.busy)return;
  const index=Number(e.detail.value);
  if(!CONTRACT_TYPES[index])return;
  // 更换分类后需重新核对识别结果（尤其劳务报酬与普通合同金额）。
  this.setData({contractDraft:{...this.data.contractDraft,categoryIndex:index,amount:"",vendor:"",rightsText:"",scanNote:"分类已变更，请核对原件并手工填写，或重新选择文件识别。"}});
 },
 async pickContractFile(e){
  if(this.data.busy||!this.data.contractMode||!this.data.canUploadContract||!this.data.pid)return;
  const pid=this.data.pid;
  const photo=e?.currentTarget?.dataset?.source==="photo";
  this.setData({busy:true,contractNotice:""});
  try{
   const result=await new Promise((resolve,reject)=>photo?
    wx.chooseMedia({count:1,mediaType:["image"],sourceType:["album","camera"],success:resolve,fail:reject}):
    wx.chooseMessageFile({count:1,type:"file",extension:["pdf","doc","docx","ppt","pptx","xls","xlsx","csv","txt","jpg","jpeg","png","webp","gif"],success:resolve,fail:reject}));
   const f=result.tempFiles?.[0];
   if(!f)return;
   const filePath=f.tempFilePath||f.path;
   const ext=/\.png$/i.test(filePath)?"png":/\.webp$/i.test(filePath)?"webp":"jpg";
   const name=String(f.name||(photo?"合同-"+Date.now()+"."+ext:"")).trim();
   if(!name||name.length>120||! /\.(pdf|docx?|pptx?|xlsx?|csv|txt|jpe?g|png|webp|gif)$/i.test(name))throw Error("请选择有效合同文件");
   if(!filePath||Number(f.size)>MAX_FILE_BYTES)throw Error("合同文件不可超过20 MB");
   if(this.data.pid!==pid||!this.data.contractMode)throw Error("会议已变化，请重新选择");
   const draft={...this.data.contractDraft,name:name.replace(/\.[^.]+$/,"").slice(0,80),vendor:"",amount:"",file:null,scanNote:"正在上传合同原件…"};
   this.setData({contractDraft:draft});
   const raw=await new Promise((resolve,reject)=>wx.getFileSystemManager().readFile({filePath,success:r=>resolve(r.data),fail:reject}));
   if(!raw?.byteLength||raw.byteLength>MAX_FILE_BYTES)throw Error("合同文件为空或超过20 MB");
   const up=await app.api("/uploads?pid="+encodeURIComponent(pid),"POST",raw,{"Content-Type":"application/octet-stream","X-File-Name":encodeURIComponent(name)});
   draft.file=up;draft.scanNote="正在识别合同信息…";this.setData({contractDraft:{...draft}});
   try{
    const scan=await app.api("/contracts/scan","POST",{pid,file_key:up.key,category:CONTRACT_TYPES[draft.categoryIndex].value});
    const fields=scan.fields||{};
    draft.vendor=String(fields.vendor||fields.enterprise||"").slice(0,80);
    if(fields.amount!==null&&fields.amount!==undefined)draft.amount=String(fields.amount);
    if(Array.isArray(fields.rightsContent))draft.rightsText=fields.rightsContent.map(x=>typeof x==="string"?x:x.category||"").filter(Boolean).join("\n");
    draft.scanNote=scan.note||"识别完成，请人工核对签约方和合同金额。";
   }catch(err){draft.scanNote="OCR 未完成，可手工填写后保存："+(err.message||"识别失败");}
   this.setData({contractDraft:{...draft}});
  }catch(err){
   if(!/cancel/i.test(String(err?.errMsg||err?.message||"")))this.setData({contractNotice:err.message||"合同文件上传失败"});
  }finally{this.setData({busy:false});}
 },
 async saveContract(){
  if(this.data.busy||!this.data.contractMode||!this.data.canUploadContract||!this.data.pid)return;
  const pid=this.data.pid,d=this.data.contractDraft,amount=Number(d.amount);
  const name=String(d.name||"").trim(),vendor=String(d.vendor||"").trim(),category=CONTRACT_TYPES[d.categoryIndex]?.value;
  if(!d.file?.key||!category||!name||!vendor||name.length>80||vendor.length>80||!Number.isFinite(amount)||amount<=0||amount>1e9||Number(amount.toFixed(2))!==amount){
   this.setData({contractNotice:"请上传合同原件，选择类别并核对合同名称、签约方和有效金额（最多两位小数）"});return;
  }
  const status=this.data.contractStatuses[d.statusIndex];
  if(!status){this.setData({contractNotice:"请选择有效合同状态"});return;}
  if(status==="已签署"&&!d.signDate){this.setData({contractNotice:"请选择合同签署日期"});return;}
  this.setData({busy:true,contractNotice:""});
  try{
   const out=await app.api("/contracts","POST",{pid,category,name,vendor,amount,
    status,sign_date:d.signDate||"",
    ...(category==="企业赞助"&&d.rightsText.trim()?{rightsCategories:d.rightsText.split(/[\n；;]+/).map(x=>x.trim()).filter(Boolean)}:{}),
    file_key:d.file.key,file_name:d.file.name,file_size:d.file.size,file_mime:d.file.mime});
   this.setData({contractDraft:emptyContract(),contractNotice:(out.message||"合同已保存")+(out.warning?"；"+out.warning:"")});
   await this.loadContracts(pid);
   wx.showToast({title:"合同已保存",icon:"success"});
  }catch(err){this.setData({contractNotice:err.message||"合同保存失败，请核对后重试"});}
  finally{this.setData({busy:false});}
 },
 async openContractOriginal(e){
  if(!this.data.contractMode)return;
  const row=this.data.contractRows.find(c=>c.id===e.currentTarget.dataset.id);
  if(!row?.fileKey)return;
  try{await app.openOriginal(row.fileKey);}
  catch(err){wx.showToast({title:err.message||"无法查看合同原件",icon:"none"});}
 },
 // 与 Web 台账共用正式业务接口，所有写操作由服务端重新校验权限和冻结状态。
 contractRow(e){return this.data.contractRows.find(c=>c.id===e.currentTarget.dataset.id);},
 async confirmAction(title,content){
  const r=await new Promise((resolve,reject)=>wx.showModal({title,content,success:resolve,fail:reject}));
  return !!r.confirm;
 },
 async contractAction(e){
  if(this.data.busy||!this.data.contractMode)return;
  const c=this.contractRow(e),action=e.currentTarget.dataset.action,pid=this.data.pid;
  if(!c||!({"submit":c.canSubmit,"sign":c.canSign,"reject":c.canSign,"delete":c.canDelete,"archiveDelete":c.canArchiveDelete}[action]))return;
  this.setData({busy:true,contractNotice:""});
  try{
   let body={action};
   if(action==="archiveDelete"){
    const x=await new Promise((resolve,reject)=>wx.showModal({title:"总管理员特殊删除",editable:true,placeholderText:"填写8～500字修订原因",content:"仅允许不影响封存核销及结算的误录合同",success:resolve,fail:reject}));
    if(!x.confirm)return;
    body={reason:String(x.content||"").trim()};if(body.reason.length<8||body.reason.length>500)throw Error("特殊删除须填写8～500字原因");
   }else if(action==="reject"){
    const x=await new Promise((resolve,reject)=>wx.showModal({title:"驳回合同签署",editable:true,placeholderText:"填写驳回理由（4～500字）",success:resolve,fail:reject}));
    if(!x.confirm)return;
    body.reason=String(x.content||"").trim();
    if(body.reason.length<4||body.reason.length>500)throw Error("驳回理由须为4～500字");
   }else if(!await this.confirmAction(action==="delete"?"删除合同":action==="sign"?"确认签署":"提交签署",action==="delete"?"确认删除「"+c.name+"」？原件进入废件箱，已完成审批保留；不等同于解除法律合同。"+(c.categoryValue==="企业赞助"?" 未发生实际收入或权益的关联赞助台账将同步撤销。":"")+"":"确认办理「"+c.name+"」？"))return;
   if(this.data.pid!==pid)throw Error("会议已变化");
   const result=await app.api("/contracts/"+encodeURIComponent(c.id)+(action==="delete"?"":action==="archiveDelete"?"/archive-delete":"/transition"),action==="delete"?"DELETE":"POST",action==="delete"?null:body);
   this.setData({contractNotice:result.message||"操作成功"});
   await this.loadKinds(pid,{preserveError:true});await this.loadContracts(pid);
  }catch(err){this.setData({contractNotice:err.message||"操作失败"});}
  finally{this.setData({busy:false});}
 },
 async editContractCategory(e){
  if(this.data.busy)return;
  const c=this.contractRow(e),pid=this.data.pid;if(!c?.canEdit)return;
  this.setData({busy:true,contractNotice:""});
  try{
   const pick=await new Promise((resolve,reject)=>wx.showActionSheet({itemList:CONTRACT_TYPES.map(x=>x.label),success:resolve,fail:reject}));
   const category=CONTRACT_TYPES[pick.tapIndex]?.value;if(!category||category===c.categoryValue)return;
   if(!await this.confirmAction("修改合同类别","修改后退回草稿并重新核验。继续？"))return;
   if(this.data.pid!==pid)throw Error("会议已变化");
   const r=await app.api("/contracts/"+encodeURIComponent(c.id)+"/category","PATCH",{category,expected_category:c.categoryValue,expected_status:c.status});
   this.setData({contractNotice:r.message||"类别已修改"});
   await this.loadKinds(pid,{preserveError:true});await this.loadContracts(pid);
  }catch(err){if(!/cancel/i.test(String(err?.errMsg||"")))this.setData({contractNotice:err.message||"修改失败"});}
  finally{this.setData({busy:false});}
 },
 async chooseAndUploadOne(pid,kind){
  const r=await new Promise((resolve,reject)=>wx.chooseMessageFile({count:1,type:"file",extension:["pdf","doc","docx","ppt","pptx","xls","xlsx","csv","txt","jpg","jpeg","png","webp","gif"],success:resolve,fail:reject}));
  const f=r.tempFiles?.[0];if(!f)return null;
  const name=String(f.name||"").trim(),path=f.tempFilePath||f.path;
  if(!name||name.length>120||!path||Number(f.size)>MAX_FILE_BYTES||!/\.(pdf|docx?|pptx?|xlsx?|csv|txt|jpe?g|png|webp|gif)$/i.test(name))throw Error("请选择20 MB以内的有效文件");
  if(["讲者照片","权益照片"].includes(kind)&&!/\.(jpe?g|png|webp)$/i.test(name))throw Error("照片材料仅支持 JPG、PNG、WebP");
  const raw=await new Promise((resolve,reject)=>wx.getFileSystemManager().readFile({filePath:path,success:x=>resolve(x.data),fail:reject}));
  if(!raw?.byteLength||raw.byteLength>MAX_FILE_BYTES)throw Error("文件为空或超过20 MB");
  if(this.data.pid!==pid)throw Error("会议已变化");
  return app.api("/uploads?pid="+encodeURIComponent(pid),"POST",raw,{"Content-Type":"application/octet-stream","X-File-Name":encodeURIComponent(name)});
 },
 async replaceOriginal(e){
  if(this.data.busy||this.data.locked||this.data.materialMutationLocked)return;
  const pid=this.data.pid,contract=this.data.contractMode?this.contractRow(e):null;
  const item=contract?(contract.canReplace?{id:contract.materialId,file_key:contract.fileKey,kind:"合同"}:null):
    (this.data.canMaterialReplace?this.data.visibleFiles.find(x=>Number(x.id)===Number(e.currentTarget.dataset.id)):null);
  if(!item?.id||!item.file_key||(!contract&&item.contractEvidence))return;
  this.setData({busy:true,error:"",contractNotice:""});
  try{
   if(!await this.confirmAction("更换原件","替换后旧原件不再是当前文件；合同退回草稿，相关核销须重新核验。确认继续？"))return;
   const up=await this.chooseAndUploadOne(pid,item.kind);if(!up)return;
   const r=await app.api("/materials/"+encodeURIComponent(item.id)+"/file","PATCH",{expected_file_key:item.file_key,file_key:up.key,file_name:up.name});
   const msg=(r.message||"原件已替换")+(r.warning?"；"+r.warning:"");
   this.setData({uploaded:msg,contractNotice:msg});
   await this.loadKinds(pid,{preserveError:true});if(this.data.contractMode)await this.loadContracts(pid);
  }catch(err){if(!/cancel/i.test(String(err?.errMsg||"")))this.setData({error:err.message||"更换失败",contractNotice:err.message||"更换失败"});}
  finally{this.setData({busy:false});}
 },
 async reviewReplaceContract(e){
  if(this.data.busy)return;
  const c=this.contractRow(e),pid=this.data.pid;if(!c?.canReviewReplace)return;
  this.setData({busy:true,contractNotice:""});
  try{
   if(!await this.confirmAction("签署前更新原件","更换后仍为待签署，请重新核对合同内容再确认签署。"))return;
   const up=await this.chooseAndUploadOne(pid,"合同");if(!up)return;
   const result=await app.api("/contracts/"+encodeURIComponent(c.id)+"/replace-file","POST",{file_key:up.key,file_name:up.name});
   this.setData({contractNotice:(result.message||"原件已更新")+(result.warning?"；"+result.warning:"")});
   await this.loadKinds(pid,{preserveError:true});await this.loadContracts(pid);
  }catch(err){if(!/cancel/i.test(String(err?.errMsg||"")))this.setData({contractNotice:err.message||"更新失败"});}
  finally{this.setData({busy:false});}
 },
 async amendContract(e){
  if(this.data.busy)return;
  const c=this.contractRow(e),pid=this.data.pid;if(!c?.canAmend)return;
  this.setData({busy:true,contractNotice:""});
  try{
   const kinds=["file_correction","supplement","terminate"];
   const choice=await new Promise((resolve,reject)=>wx.showActionSheet({itemList:["合同原件纠错","补充协议／合同变更","合同解除／终止"],success:resolve,fail:reject}));
   const kind=kinds[choice.tapIndex];if(!kind)return;
   const reason=await new Promise((resolve,reject)=>wx.showModal({title:"合同更正理由",editable:true,placeholderText:"8～500字，说明更正原因",success:resolve,fail:reject}));
   if(!reason.confirm)return;
   const detail=String(reason.content||"").trim();if(detail.length<8||detail.length>500)throw Error("更正理由须为8～500字");
   let amount="";
   if(kind==="supplement"){
    const x=await new Promise((resolve,reject)=>wx.showModal({title:"变更后合同金额（选填）",editable:true,placeholderText:"留空表示金额不变",success:resolve,fail:reject}));
    if(!x.confirm)return;amount=String(x.content||"").trim();
    if(amount&&(!/^\\d+(?:\\.\\d{1,2})?$/.test(amount)||Number(amount)<=0||Number(amount)>1e9))throw Error("金额无效");
   }
   const up=await this.chooseAndUploadOne(pid,"合同");if(!up)return;
   if(!await this.confirmAction("提交合同更正","确认提交更正证明及申请？原合同在审批生效前保持不变。"))return;
   const result=await app.api("/contracts/"+encodeURIComponent(c.id)+"/amendments","POST",{kind,reason:detail,file_key:up.key,file_name:up.name,...(amount?{new_amount:Number(amount)}:{})});
   this.setData({contractNotice:result.message||"合同更正申请已提交"});await this.loadContracts(pid);
  }catch(err){if(!/cancel/i.test(String(err?.errMsg||"")))this.setData({contractNotice:err.message||"合同更正失败"});}
  finally{this.setData({busy:false});}
 },
 async contractHistory(e){
  const c=this.contractRow(e);if(!c?.canHistory||this.data.busy)return;
  try{
   const r=await app.api("/contracts/"+encodeURIComponent(c.id)+"/amendments");
   this.setData({historyContract:c.name,historyRows:(r.rows||[]).map(x=>({id:x.id,status:x.status,kind:x.kind,reason:x.reason,createdAt:x.created_at,oldKey:x.old_file_key,newKey:x.new_file_key,oldName:x.old_file_name,newName:x.new_file_name}))});
  }catch(err){this.setData({contractNotice:err.message||"版本历史读取失败"});}
 },
 closeHistory(){this.setData({historyContract:"",historyRows:[]});},
 async openHistoryOriginal(e){
  const key=e.currentTarget.dataset.key;if(!key||!(this.data.historyRows||[]).some(r=>r.oldKey===key||r.newKey===key))return;
  try{await app.openOriginal(key);}catch(err){wx.showToast({title:err.message||"原件查看失败",icon:"none"});}
 },
 async openArchive(){
  if(this.data.busy||!this.data.archiveAllowed||!this.data.pid)return;
  const pid=this.data.pid;this.setData({busy:true,archiveError:""});
  try{
   const data=await app.api("/projects/"+encodeURIComponent(pid)+"/archive-pdf/options");
   if(this.data.pid!==pid)return;
   this.setData({archiveOpen:true,archiveSources:(data.sources||[]).map(x=>({id:x.source_id,kind:x.kind,name:x.name,fileName:x.file_name||"",generated:!!x.generated,checked:true})),archiveCustomWatermark:data.can_customize_watermark===true,archiveWatermarkMode:0,archiveWatermarkText:""});
  }catch(err){this.setData({archiveError:err.message||"卷宗目录读取失败"});}
  finally{this.setData({busy:false});}
 },
 closeArchive(){if(!this.data.busy)this.setData({archiveOpen:false,archiveSources:[],archiveError:""});},
 selectArchiveAll(e){
  if(this.data.busy)return;
  const checked=e.currentTarget.dataset.all==="yes";
  this.setData({archiveSources:this.data.archiveSources.map(x=>({...x,checked}))});
 },
 toggleArchiveSource(e){
  if(this.data.busy)return;
  const id=e.currentTarget.dataset.id;
  this.setData({archiveSources:this.data.archiveSources.map(x=>x.id===id?{...x,checked:!x.checked}:x)});
 },
 moveArchiveSource(e){
  if(this.data.busy)return;
  const rows=this.data.archiveSources.slice(),i=rows.findIndex(x=>x.id===e.currentTarget.dataset.id),delta=Number(e.currentTarget.dataset.delta),j=i+delta;
  if(i<0||![-1,1].includes(delta)||!rows[j]||rows[i].kind!==rows[j].kind)return;
  [rows[i],rows[j]]=[rows[j],rows[i]];this.setData({archiveSources:rows});
 },
 archiveWatermarkChange(e){if(!this.data.busy&&this.data.archiveCustomWatermark)this.setData({archiveWatermarkMode:Number(e.detail.value)});},
 archiveWatermarkInput(e){if(!this.data.busy&&this.data.archiveCustomWatermark)this.setData({archiveWatermarkText:e.detail.value});},
 async exportArchive(e){
  if(this.data.busy||!this.data.archiveOpen||!this.data.archiveAllowed)return;
  const ids=this.data.archiveSources.filter(x=>x.checked).map(x=>x.id),format=e.currentTarget.dataset.format;
  if(!["pdf","pptx"].includes(format))return;
  if(!ids.length||ids.length>120){this.setData({archiveError:"请选择1～120份资料"});return;}
  const mode=this.data.archiveCustomWatermark?["default","none","custom"][this.data.archiveWatermarkMode]||"default":"default",text=this.data.archiveWatermarkText.trim();
  if(format==="pdf"&&mode==="custom"&&(!text||text.length>80)){this.setData({archiveError:"自定义水印须填写1～80字"});return;}
  this.setData({busy:true,archiveError:""});
  try{await app.openArchiveExport(this.data.pid,format,{source_ids:ids,...(format==="pdf"?{watermark_mode:mode,watermark_text:text}:{})});}
  catch(err){this.setData({archiveError:err.message||"生成失败"});}
  finally{this.setData({busy:false});}
 },
 async loadRights(pid){
  const empty=[{id:"",label:"请选择赞助合同 → 权益二级类目"}];
  this.setData({sponsorRights:empty,rightIndex:0,rightId:""});
  if(!pid)return;
  try{
   const d=await app.api("/projects/"+encodeURIComponent(pid)+"/sponsor-rights");
   if(this.data.pid!==pid)return;
   const contracts=new Map((d.contracts||[]).filter(x=>x.status==="已签署").map(x=>[x.id,x.enterprise]));
   const rights=(d.rights||[]).filter(x=>contracts.has(x.sponsor_id)).map(x=>({
     id:String(x.id),label:contracts.get(x.sponsor_id)+" · "+x.category+(x.confirmed?"":"（权益待人工确认）")
   }));
   this.setData({sponsorRights:empty.concat(rights),rightIndex:0,rightId:"",
     error:rights.length?"":"尚无已签赞助合同权益，请先在 Web 会议收入页人工确认权益类目"});
  }catch(e){if(this.data.pid===pid)this.setData({error:"权益类目读取失败："+e.message});}
 },
 pickRight(e){
  if(this.data.busy)return;this._batch=null;
  const i=Number(e.detail.value),row=this.data.sponsorRights[i];
  this.setData({rightIndex:i,rightId:row?.id||""});
 },
 chooseCustom(){
  if(this.data.busy||this.data.locked||!this.data.canMaterialWrite)return;
  this._batch=null;
  this.setData({custom:true,kind:"",customKind:"",rightId:"",uploaded:"",error:"",contractMode:false,allMaterials:false,
    batchResults:[],speakerFiles:[]});
  this.syncVisibleFiles();
 },
 input(e){
  const key=e.currentTarget.dataset.key;
  this.setData({[key]:e.detail.value});
  if(key==="customKind")this.syncVisibleFiles();
 },
 async addPhoto(){
  if(this.data.busy||this.data.locked||!this.data.canMaterialWrite)return;
  const kind=this.data.custom?this.data.customKind.trim():this.data.kind.trim();
  const speaker=kind==="讲者照片";
  if(speaker&&this.data.speakerFiles.length){
   this.setData({error:"已有一批讲者照片待命名，请先上传或移除后再选"});return;
  }
  try{
   const media=await new Promise((resolve,reject)=>wx.chooseMedia({
    count:MAX_MATERIAL_FILES_PER_BATCH,mediaType:["image"],sourceType:["album","camera"],success:resolve,fail:reject}));
   const chosen=media.tempFiles||[];
   if(!chosen.length)throw new Error("没有选中照片");
   const stamp=Date.now();
   const files=chosen.map((file,i)=>{
    const path=String(file.tempFilePath||file.path||"");
    const ext=/\.png$/i.test(path)?"png":/\.webp$/i.test(path)?"webp":"jpg";
    const safeKind=kind.replace(/[\\/:*?"<>|]/g,"_")||"照片";
    return {...file,path,ext,name:safeKind+"-"+stamp+"-"+(i+1)+"."+ext};
   });
   if(speaker){
    // 相册图片没有原始文件名，先让用户逐张填写讲者姓名，姓名即材料名称
    this.setData({speakerFiles:files.map(f=>({
     uid:++speakerSeq,path:f.path,size:Number(f.size)||0,ext:f.ext,name:"",error:""
    })),error:"",uploaded:""});
    return;
   }
   await this.uploadBatch(files);
  }catch(e){
   if(/cancel/i.test(String(e&&e.errMsg||"")))return;
   this.setData({error:e.message||"图片选择失败"});
  }
 },
 inputSpeakerName(e){
  const i=Number(e.currentTarget.dataset.index);
  const list=this.data.speakerFiles.slice();
  if(!list[i])return;
  list[i]={...list[i],name:e.detail.value,error:""};
  this.setData({speakerFiles:list});
 },
 removeSpeaker(e){
  if(this.data.busy)return;
  const i=Number(e.currentTarget.dataset.index);
  const list=this.data.speakerFiles.slice();
  if(!list[i])return;
  list.splice(i,1);
  this.setData({speakerFiles:list,error:""});
 },
 async uploadSpeakers(){
  if(this.data.busy||this.data.locked||!this.data.canMaterialWrite)return;
  const list=this.data.speakerFiles;
  if(!list.length){this.setData({error:"请先选择讲者照片"});return;}
  // 姓名即材料名称，必须逐张填写；缺失项就地标红，不静默跳过
  let invalid=false;
  const clean=raw=>String(raw||"").trim().replace(/\.(jpe?g|png|webp)$/i,"").trim();
  const checked=list.map(f=>{
   const name=clean(f.name);
   if(!name){invalid=true;return {...f,error:"请填写讲者姓名"};}
   if(name.length>120){invalid=true;return {...f,error:"姓名不能超过 120 字"};}
   return f;
  });
  if(invalid){this.setData({speakerFiles:checked,error:"请为每张照片填写讲者姓名"});return;}
  const files=list.map(f=>({
   tempFilePath:f.path,path:f.path,size:f.size,
   name:clean(f.name)+"."+f.ext
  }));
  await this.uploadBatch(files);
  this.setData({speakerFiles:[]});
 },
 async addFile(){
  if(this.data.busy||this.data.locked||!this.data.canMaterialWrite)return;
  try{
   const result=await new Promise((resolve,reject)=>wx.chooseMessageFile({
    count:MAX_MATERIAL_FILES_PER_BATCH,type:"file",
    extension:["ppt","pptx","xls","xlsx","doc","docx","pdf","csv","txt","jpg","jpeg","png","webp","gif"],
    success:resolve,fail:reject
   }));
   const files=(result.tempFiles||[]).map(f=>({...f,name:String(f.name||"").trim()}));
   if(!files.length)throw new Error("未选择文件");
   await this.uploadBatch(files);
  }catch(e){this.setData({error:e.message||"文件选择失败"});}
 },
 // 误传纠错：仅删除当前项目已正式登记的这份材料，绝不直接清理存储原件。
 // 后端执行权限/核销/合同冻结校验并软删除至总管理员废件箱。
 // 查看与写入是独立动作；结算/归档只冻结写入，不冻结已授权原件。
 async openMaterialOriginal(e){
  if(this.data.contractMode||this.data.filesLoading||!this.data.pid)return;
  const pid=this.data.pid,id=Number(e.currentTarget?.dataset?.id);
  if(!Number.isSafeInteger(id)||id<1||!this.data.visibleFiles.some(row=>Number(row.id)===id))return;
  try{
   const item=this.data.visibleFiles.find(row=>Number(row.id)===id);
   if(!this.data.canMaterialRead||!item?.file_key)throw Error("当前账号无材料原件查看权限或原件不存在");
   await app.openOriginal(item.file_key);
  }catch(err){if(this.data.pid===pid)wx.showToast({title:err.message||"无法查看材料原件",icon:"none"});}
 },
 async removeUploaded(e){
  if(this.data.busy||this.data.materialMutationLocked||this.data.locked||!this.data.canMaterialWrite||!this.data.pid)return;
  const id=Number(e.currentTarget?.dataset?.id);
  const pid=this.data.pid;
  const item=this.data.materialRows.find(row=>Number(row.id)===id);
  if(!Number.isSafeInteger(id)||id<1||!item||item.contractEvidence)return;
  const name=String(item.filename||"此材料");
  this.setData({busy:true,deletingId:id,error:"",uploaded:""});
  try{
   const confirm=await new Promise((resolve,reject)=>wx.showModal({
    title:"确认删除已上传材料",
    content:"确定删除「"+name+"」吗？删除后会从材料收集列表移除，原件留在废件箱，仅总管理员可以恢复。若已被合同或核销锁定，系统将拒绝删除。",
    confirmText:"删除",confirmColor:"#c0392b",cancelText:"取消",
    success:resolve,fail:reject
   }));
   if(!confirm.confirm)return;
   // 确认框打开期间如上下文已失效，必须终止而非删除别的会议原件。
   if(this.data.pid!==pid||!this.data.materialRows.some(row=>Number(row.id)===id))
    throw new Error("项目或材料已变化，请刷新后重试");
   await app.api("/materials/"+id,"DELETE");
   if(this.data.pid!==pid)return;
   // 服务端已成功软删时立即从本地列表移除，即使随后的刷新网络失败也不误显示。
   this.setData({materialRows:this.data.materialRows.filter(row=>Number(row.id)!==id)});
   this.syncVisibleFiles();
   await this.loadKinds(pid,{preserveError:true});
   this.setData({uploaded:"已删除「"+name+"」，如需恢复请联系总管理员"});
   wx.showToast({title:"已删除",icon:"success"});
  }catch(err){
   if(this.data.pid===pid)this.setData({error:"删除失败："+(err?.message||"请重试")});
  }finally{
   this.setData({busy:false,deletingId:0});
  }
 },
 async retryFailed(){if(this._batch&&!this.data.busy)await this.uploadBatch(null);},
 async uploadBatch(files){
  if(this.data.busy)return;
  const raw=this.data.custom?this.data.customKind.trim():this.data.kind.trim();
  const kind=raw==="劳务收集表"?"劳务表":raw;
  if(this.data.locked||!this.data.canMaterialWrite||this.data.filesLoading||this.data.disabledKinds.includes(kind)){
   this.setData({error:"当前材料类别不可上传，请等待目录加载或选择未停用类别"});return;
  }
  if(["合同","会务协议","劳务协议","企业赞助合同","赞助合同","劳务专家合同","专家劳务协议","劳务合同","会务合同"].includes(kind)){
   this.setData({error:"企业赞助合同、会务协议和劳务协议请点击上方「合同」类目统一上传"});return;
  }
  const final=kind==="终版议程";
  const pid=this.data.pid;
  if(!pid||!kind||kind.length>20){
   this.setData({error:"请先选择会议及有效材料类别（20字以内）"});return;
  }
  if(kind==="权益照片"&&(!this.data.rightId||
    !this.data.sponsorRights.some(x=>x.id===this.data.rightId))){
   this.setData({error:"请先选择对应的赞助权益二级类目"});return;
  }
  if(files){
   if(files.length>MAX_MATERIAL_FILES_PER_BATCH||!files.length){
    this.setData({error:"单批只能上传1至"+MAX_MATERIAL_FILES_PER_BATCH+"份材料"});return;
   }
   for(const f of files){
    if(!f.name||f.name.length>120||
      !/\.(ppt|pptx|xls|xlsx|doc|docx|pdf|csv|txt|jpg|jpeg|png|webp|gif)$/i.test(f.name)){
     this.setData({error:"文件名无效或格式不支持，请选择真实的图片、PDF或Office文件"});return;
    }
    if(["讲者照片","权益照片"].includes(kind)&&!/\.(jpg|jpeg|png|webp)$/i.test(f.name)){
     this.setData({error:kind+"只支持 JPG/PNG/WebP 图片"});return;
    }
    if(Number(f.size)>MAX_FILE_BYTES){
     this.setData({error:"每份材料不能超过20 MB："+f.name});return;
    }
   }
   this._batch={
    pid,kind,final,rightId:this.data.rightId,
    files:files.map(file=>({file,name:file.name,status:"待上传",error:"",done:false,speaker:""}))
   };
  }
  const batch=this._batch;
  if(!batch||batch.pid!==pid||batch.kind!==kind||batch.rightId!==this.data.rightId){
   this.setData({error:"项目或材料类别已变化，请重新选择文件"});return;
  }
  this.setData({busy:true,error:"",uploaded:""});
  const sync=()=>this.setData({batchResults:batch.files.map(f=>({
    name:f.name,status:f.status,error:f.error,speaker:f.speaker
  }))});
  sync();
  let cursor=0,stop=false;
  const queue=batch.files.filter(f=>!f.done);
  const worker=async()=>{
   while(cursor<queue.length&&!stop){
    const item=queue[cursor++];
    item.status="上传中";item.error="";sync();
    try{
     const raw=await new Promise((resolve,reject)=>wx.getFileSystemManager().readFile({
      filePath:item.file.tempFilePath||item.file.path,success:r=>resolve(r.data),fail:reject
     }));
     const uploaded=await app.api("/uploads?pid="+encodeURIComponent(pid),"POST",raw,
      {"Content-Type":"application/octet-stream","X-File-Name":encodeURIComponent(item.name)});
     item.status="归档中";sync();
     const saved=await app.api("/projects/"+encodeURIComponent(pid)+"/materials","POST",{
      kind,name:item.name,version:final?"终版":"v1",file_key:uploaded.key,
      file_name:uploaded.name,file_size:uploaded.size,file_mime:uploaded.mime,
      ...(kind==="权益照片"?{sponsor_right_id:Number(batch.rightId)}:{})
     });
     item.speaker=saved.speakerFromFilename||"";
     item.done=true;item.status="已归档";
    }catch(e){
     item.status="失败";item.error=e.message||"上传失败";
     if(final)stop=true; // preserve original order on final-agenda retry
    }
    sync();
   }
  };
  try{
   await Promise.all(Array.from({length:final?1:Math.min(3,queue.length)},()=>worker()));
   // Refresh from saved materials, including earlier uploads to this category.
   // If listing is temporarily unavailable, preserve the batch result/error
   // and let onShow() fetch again; never mark a failed file as archived.
   await this.loadKinds(pid,{preserveError:true});
   const done=batch.files.filter(x=>x.done).length;
   const pending=batch.files.length-done;
   if(!pending){
    this._batch=null;
    this.setData({uploaded:final?"已归档"+done+"份议程，最后一份为当前终版":"已归档"+done+"份材料",batchResults:[]});
    wx.showToast({title:"归档成功",icon:"success"});
   }else{
    this.setData({error:"已完成"+done+"/"+batch.files.length+"份，剩余"+pending+"份，可点击重试未成功的文件"});
   }
  }finally{this.setData({busy:false});}
 }

});