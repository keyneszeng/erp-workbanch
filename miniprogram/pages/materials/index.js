const app=getApp();
const MAX_MATERIAL_FILES_PER_BATCH=10;
const MAX_FILE_BYTES=20*1024*1024;
// 相册图片没有原始文件名（wxfile://tmp_xxx.jpg），无法按文件名关联讲者，
// 因此讲者照片额外提供「相册选图 → 逐张填姓名」的通道，姓名拼成文件名后走同一套上传。
let speakerSeq=0;
Page({
 data:{projects:[],index:0,pid:"",kind:"课件",name:"",error:"",busy:false,uploaded:"",
  standardKinds:["课件","串场","劳务收集表","劳务协议","议程","终版议程","签到表","讲者照片","现场照片","权益照片"],
  activeKinds:[],custom:false,customKind:"",locked:false,batchResults:[],speakerFiles:[],
  sponsorRights:[{id:"",label:"请选择赞助权益类目"}],rightIndex:0,rightId:""},
 onLoad(q){if(q.pid)this.setData({pid:q.pid});},
 onShow(){this.load();},
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
   this.setData({projects,index,pid:p?.id||"",locked:!p||["已结算","已归档"].includes(p.status)});
   if(p){await this.loadKinds(p.id);if(this.data.kind==="权益照片")await this.loadRights(p.id);}
  }catch(e){this.setData({error:e.message});}
 },
 async loadKinds(pid){
  try{
   const data=await app.api("/projects/"+encodeURIComponent(pid)+"/material-workbench");
   const kinds=this.data.standardKinds.filter(k=>!data.modules?.some(m=>m.kind===k&&m.enabled===0));
   this.setData({activeKinds:kinds,kind:kinds.includes(this.data.kind)?this.data.kind:(kinds[0]||"会议照片"),error:""});
  }catch(e){this.setData({activeKinds:this.data.standardKinds,error:e.message});}
 },
 select(e){if(this.data.busy)return;this._batch=null;const index=Number(e.detail.value),p=this.data.projects[index];
  this.setData({index,pid:p.id,locked:["已结算","已归档"].includes(p.status),uploaded:"",batchResults:[],speakerFiles:[]});
  this.loadKinds(p.id);
  if(this.data.kind==="权益照片")this.loadRights(p.id);else this.setData({sponsorRights:[{id:"",label:"请选择赞助权益类目"}],rightIndex:0,rightId:""});
 },
 chooseKind(e){
  if(this.data.busy)return;
  this._batch=null;const kind=e.currentTarget.dataset.kind;
  this.setData({kind,custom:false,batchResults:[],speakerFiles:[]});
  if(kind==="权益照片")this.loadRights(this.data.pid);
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
 chooseCustom(){if(this.data.busy)return;this._batch=null;this.setData({custom:true,rightId:"",batchResults:[],speakerFiles:[]});},
 input(e){this.setData({[e.currentTarget.dataset.key]:e.detail.value});},
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
    return {...file,path,ext,name:"现场照片-"+stamp+"-"+(i+1)+"."+ext};
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
 async retryFailed(){if(this._batch&&!this.data.busy)await this.uploadBatch(null);},
 async uploadBatch(files){
  if(this.data.busy)return;
  const kind=this.data.custom?this.data.customKind.trim():this.data.kind.trim();
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