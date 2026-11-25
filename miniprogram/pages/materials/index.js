const app=getApp();
const MAX_MATERIAL_FILES_PER_BATCH=10;
const MAX_FILE_BYTES=20*1024*1024;
const CONTRACT_TYPES=[{value:"会务需求",label:"会务协议"},{value:"劳务专家",label:"劳务协议"},{value:"企业赞助",label:"企业赞助合同"}];
const emptyContract=()=>({categoryIndex:0,name:"",vendor:"",amount:"",statusIndex:0,signDate:"",file:null,scanNote:""});
// 相册图片没有原始文件名（wxfile://tmp_xxx.jpg），无法按文件名关联讲者，
// 因此讲者照片额外提供「相册选图 → 逐张填姓名」的通道，姓名拼成文件名后走同一套上传。
let speakerSeq=0;
Page({
 data:{projects:[],index:0,pid:"",kind:"课件",name:"",error:"",busy:false,uploaded:"",
  // 类别由服务端统一下发；不维护独立的客户端类别清单。
  activeKinds:[],historyKinds:[],disabledKinds:[],categoryDisabled:false,materialRows:[],visibleFiles:[],filesLoading:false,
  custom:false,customKind:"",locked:false,batchResults:[],speakerFiles:[],deletingId:0,
  contractMode:false,contractsLoading:false,contractRows:[],contractError:"",canUploadContract:false,
  contractTypes:CONTRACT_TYPES,contractStatuses:["草稿","待签署"],contractDraft:emptyContract(),contractNotice:"",
  sponsorRights:[{id:"",label:"请选择赞助权益类目"}],rightIndex:0,rightId:""},
 onLoad(q){if(q.pid)this.setData({pid:q.pid});},
 onShow(){if(!this.data.busy)return this.load();},
 async load(){
  try{
   const r=await app.api("/projects?page=1&size=100");
   const projects=r.rows||[];
   // 指定项目可能不在第一页；不能悄悄把材料归档到另一场会议。
   if(this.data.pid&&!projects.some(x=>x.id===this.data.pid)){
    try{
     const one=await app.api("/projects/"+encodeURIComponent(this.data.pid));
     if(one.project)projects.unshift(one.project);
    }catch(e){this.setData({error:"指定会议不可访问："+e.message});return;}
   }
   let index=projects.findIndex(x=>x.id===this.data.pid);if(index<0)index=0;
   const p=projects[index];
   this.setData({projects,index,pid:p?.id||"",locked:!p||["已结算","已归档"].includes(p.status),
     materialRows:[],visibleFiles:[],historyKinds:[],filesLoading:!!p,contractRows:[],contractError:"",contractsLoading:false,canUploadContract:false});
   if(p){await this.loadKinds(p.id);if(this.data.contractMode)await this.loadContracts(p.id);else if(this.data.kind==="权益照片")await this.loadRights(p.id);}
  }catch(e){this.setData({error:e.message});}
 },
 // The selected category is the entry form and the persistent file list.
 syncVisibleFiles(){
  const raw=this.data.custom?String(this.data.customKind||"").trim():this.data.kind;
  const selected=raw==="劳务收集表"?"劳务表":raw;
  this.setData({categoryDisabled:this.data.disabledKinds.includes(selected),visibleFiles:this.data.materialRows.filter(row=>row.kind===selected)});
 },
 async loadKinds(pid,{preserveError=false}={}){
  if(!pid)return;
  this.setData({filesLoading:true});
  try{
   const data=await app.api("/projects/"+encodeURIComponent(pid)+"/material-workbench");
   if(this.data.pid!==pid)return; // another project was selected while loading
   // 兼容旧部署/历史档案：「劳务收集表」只作为数据别名，绝不重新进入可选类别。
   const normalizedKind=k=>k==="劳务收集表"?"劳务表":k;
   const shared=data.categoryCatalog;
   if(!shared&&!Array.isArray(data.kinds))throw new Error("服务端未返回材料类别目录");
   const catalog=shared?.active||data.kinds;
   const retired=new Set(["合同","会务协议","劳务协议","企业赞助合同","赞助合同","劳务专家合同","专家劳务协议","劳务合同","会务合同"]);
   const disabled=shared?.disabled||(data.modules||[]).filter(m=>m.enabled===0).map(m=>normalizedKind(m.kind));
   const kinds=[...new Set(catalog.map(normalizedKind))]
     .filter(k=>!retired.has(k)&&!disabled.includes(k));
   const rows=(data.materials||[]).filter(row=>row&&row.filename&&row.kind)
     .map(row=>({...row,kind:normalizedKind(row.kind)}));
   const history=[...new Set((shared?.history||rows.map(row=>row.kind)).map(normalizedKind))]
     .filter(k=>!kinds.includes(k)&&!retired.has(k)).sort();
   // 历史合同及劳务协议、会务协议仍保存在服务端，不进入材料收集的可选类别。
   const chosen=this.data.kind;
   const kind=kinds.includes(chosen)||history.includes(chosen)?chosen:(kinds[0]||"现场照片");
   this.setData({activeKinds:kinds,historyKinds:history,disabledKinds:disabled,materialRows:rows.filter(row=>!retired.has(row.kind)),kind,
     filesLoading:false,...(preserveError?{}:{error:""})});
   this.syncVisibleFiles();
  }catch(e){
   if(this.data.pid===pid){
    this.setData({filesLoading:false,...(preserveError?{}:{error:"材料文件列表读取失败："+e.message})});
   }
  }
 },
 select(e){if(this.data.busy)return;this._batch=null;const index=Number(e.detail.value),p=this.data.projects[index];
  this.setData({index,pid:p.id,locked:["已结算","已归档"].includes(p.status),uploaded:"",
   batchResults:[],speakerFiles:[],materialRows:[],visibleFiles:[],activeKinds:[],historyKinds:[],disabledKinds:[],categoryDisabled:false,contractRows:[],contractError:"",contractsLoading:false,canUploadContract:false,contractDraft:emptyContract(),contractNotice:""});
  this.loadKinds(p.id);
  if(this.data.contractMode){this.loadContracts(p.id);return;}
  if(this.data.kind==="权益照片")this.loadRights(p.id);else this.setData({sponsorRights:[{id:"",label:"请选择赞助权益类目"}],rightIndex:0,rightId:""});
 },
 chooseKind(e){
  if(this.data.busy)return;
  this._batch=null;const kind=e.currentTarget.dataset.kind;
  this.setData({kind,custom:false,customKind:"",uploaded:"",error:"",batchResults:[],speakerFiles:[],contractMode:false});
  this.syncVisibleFiles();
  if(kind==="权益照片")this.loadRights(this.data.pid);
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
  this.setData({contractsLoading:true,contractRows:[],contractError:"",canUploadContract:false});
  try{
   const data=await app.api("/projects/"+encodeURIComponent(pid));
   if(this.data.pid!==pid||this._contractSeq!==seq)return;
   if(data.sectionAccess?.contracts!==true){
    this.setData({contractsLoading:false,contractError:"当前账号无合同目录查看权限，请联系管理员授权"});return;
   }
   const labels={"会务需求":"会务协议","劳务专家":"劳务协议","企业赞助":"企业赞助合同"};
   const rows=(data.contracts||[]).filter(c=>!c.deleted_at).map(c=>({
    id:c.id,name:c.name,vendor:c.vendor||"",category:labels[c.category]||c.category||"合同",
    status:c.status,fileKey:c.file_key||"",fileName:c.file_name||""
   }));
   const status=data.project?.status||this.data.projects[this.data.index]?.status;
   const canUploadContract=(app.globalData?.perms||[]).includes("contract:write")&&!data.settlement&&!["已核销","已结算","已归档"].includes(status)&&!this.data.locked;
   this.setData({contractsLoading:false,contractRows:rows,canUploadContract});
  }catch(e){
   if(this.data.pid===pid&&this._contractSeq===seq)this.setData({contractsLoading:false,contractError:"合同目录读取失败："+e.message});
  }
 },
 // 合同只通过正式合同接口登记，服务端同步归档原件；不重复调用普通材料接口。
 contractDraftInput(e){
  if(this.data.busy)return;
  const key=e.currentTarget.dataset.key;
  if(!["name","vendor","amount"].includes(key))return;
  this.setData({contractDraft:{...this.data.contractDraft,[key]:e.detail.value}});
 },
 contractStatusChange(e){
  if(!this.data.busy)this.setData({contractDraft:{...this.data.contractDraft,statusIndex:Number(e.detail.value)}});
 },
 contractDateChange(e){
  if(!this.data.busy)this.setData({contractDraft:{...this.data.contractDraft,signDate:e.detail.value}});
 },
 contractCategoryChange(e){
  if(this.data.busy)return;
  const index=Number(e.detail.value);
  if(!CONTRACT_TYPES[index])return;
  // 更换分类后需重新核对识别结果（尤其劳务报酬与普通合同金额）。
  this.setData({contractDraft:{...this.data.contractDraft,categoryIndex:index,amount:"",vendor:"",scanNote:"分类已变更，请核对原件并手工填写，或重新选择文件识别。"}});
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
  this.setData({busy:true,contractNotice:""});
  try{
   const out=await app.api("/contracts","POST",{pid,category,name,vendor,amount,
    status:d.statusIndex===1?"待签署":"草稿",sign_date:d.signDate||"",
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
  if(this.data.busy)return;
  this._batch=null;
  this.setData({custom:true,kind:"",customKind:"",rightId:"",uploaded:"",error:"",contractMode:false,
    batchResults:[],speakerFiles:[]});
  this.syncVisibleFiles();
 },
 input(e){
  const key=e.currentTarget.dataset.key;
  this.setData({[key]:e.detail.value});
  if(key==="customKind")this.syncVisibleFiles();
 },
 async addPhoto(){
  if(this.data.busy||this.data.locked)return;
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
  if(this.data.busy||this.data.locked)return;
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
  if(this.data.busy||this.data.locked)return;
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
 async removeUploaded(e){
  if(this.data.busy||this.data.locked||!this.data.pid)return;
  const id=Number(e.currentTarget?.dataset?.id);
  const pid=this.data.pid;
  const item=this.data.materialRows.find(row=>Number(row.id)===id);
  if(!Number.isSafeInteger(id)||id<1||!item)return;
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
  if(this.data.locked||this.data.filesLoading||this.data.disabledKinds.includes(kind)){
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