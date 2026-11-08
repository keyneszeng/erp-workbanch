const app=getApp();
Page({
 data:{projects:[],index:0,pid:"",kind:"课件",name:"",error:"",busy:false,uploaded:"",
  standardKinds:["课件","串场","劳务收集表","劳务协议","议程","终版议程","签到表","讲者照片","现场照片","权益照片"],
  activeKinds:[],custom:false,customKind:"",locked:false,
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
 select(e){const index=Number(e.detail.value),p=this.data.projects[index];
  this.setData({index,pid:p.id,locked:["已结算","已归档"].includes(p.status),uploaded:""});
  this.loadKinds(p.id);
  if(this.data.kind==="权益照片")this.loadRights(p.id);else this.setData({sponsorRights:[{id:"",label:"请选择赞助权益类目"}],rightIndex:0,rightId:""});
 },
 chooseKind(e){
  const kind=e.currentTarget.dataset.kind;
  this.setData({kind,custom:false});
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
  const i=Number(e.detail.value),row=this.data.sponsorRights[i];
  this.setData({rightIndex:i,rightId:row?.id||""});
 },
 chooseCustom(){this.setData({custom:true,rightId:""});},
 input(e){this.setData({[e.currentTarget.dataset.key]:e.detail.value});},
 async addPhoto(){
  if(this.data.busy||this.data.locked)return;
  try{
   const media=await new Promise((resolve,reject)=>wx.chooseMedia({
    count:1,mediaType:["image"],sourceType:["album","camera"],success:resolve,fail:reject}));
   const selected=media.tempFiles?.[0];
   if(!selected)throw new Error("没有选中照片");
   const ext=/\.png$/i.test(selected.tempFilePath)?"png":/\.webp$/i.test(selected.tempFilePath)?"webp":"jpg";
   await this.uploadPicked(selected,"会议照片."+ext);
  }catch(e){this.setData({error:e.message||"图片选择失败"});}
 },
 async addFile(){
  if(this.data.busy||this.data.locked)return;
  try{
   const result=await new Promise((resolve,reject)=>wx.chooseMessageFile({
    count:1,type:"file",extension:["ppt","pptx","xls","xlsx","doc","docx","pdf","csv","txt","jpg","jpeg","png","webp","gif"],
    success:resolve,fail:reject
   }));
   const selected=result.tempFiles?.[0];
   if(!selected)throw new Error("未选择文件");
   const name=String(selected.name||"");
   if(!/\.(ppt|pptx|xls|xlsx|doc|docx|pdf|csv|txt|jpg|jpeg|png|webp|gif)$/i.test(name))throw new Error("仅支持图片、PDF、PPT/PPTX、DOC/DOCX、XLS/XLSX、CSV/TXT 文件");
   await this.uploadPicked(selected,name);
  }catch(e){this.setData({error:e.message||"文件选择失败"});}
 },
 async uploadPicked(selected,fileName){
  const kind=this.data.custom?this.data.customKind.trim():this.data.kind.trim();
  const final=kind==="终版议程";
  if(!this.data.pid||!kind||(!final&&!this.data.name.trim())||kind.length>20||this.data.name.length>120){
   this.setData({error:final?"请先选择所属会议和终版议程类别":"请选择会议并填写有效材料类别（20 字内）和名称（120 字内）"});return;
  }
  if(kind==="权益照片" && (!this.data.rightId ||
    !this.data.sponsorRights.some(x=>x.id===this.data.rightId))){
   this.setData({error:"请先选择当前赞助合同对应的权益二级类目"});return;
  }
  if(["权益照片","讲者照片"].includes(kind) && !/\.(jpg|jpeg|png|webp)$/i.test(fileName)){
   this.setData({error:kind+"仅支持 JPG/PNG/WebP 图片"});return;
  }
  if(Number(selected.size)>20*1024*1024){this.setData({error:"单个附件不能超过 20 MB"});return;}
  this.setData({busy:true,error:"",uploaded:""});
  try{
   const buffer=await new Promise((resolve,reject)=>wx.getFileSystemManager().readFile({
    filePath:selected.tempFilePath||selected.path,success:r=>resolve(r.data),fail:reject}));
   const upload=await app.api("/uploads?pid="+encodeURIComponent(this.data.pid),"POST",buffer,
    {"Content-Type":"application/octet-stream","X-File-Name":encodeURIComponent(fileName)});
   await app.api("/projects/"+encodeURIComponent(this.data.pid)+"/materials","POST",{
    kind,name:final?fileName:this.data.name.trim(),version:final?"终版":"v1",file_key:upload.key,
    file_name:upload.name,file_size:upload.size,file_mime:upload.mime,
    ...(kind==="权益照片"?{sponsor_right_id:Number(this.data.rightId)}:{})});
   this.setData({uploaded:final?"终版议程已上传并确认："+upload.name:"已归档："+upload.name,name:""});
   wx.showToast({title:final?"终版已确认":"归档成功",icon:"success"});
  }catch(e){this.setData({error:e.message||"归档失败"});}
  finally{this.setData({busy:false});}
 }
});