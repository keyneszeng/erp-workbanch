const app=getApp();
Page({
 data:{projects:[],index:0,pid:"",kind:"课件",name:"",error:"",busy:false,uploaded:"",
  standardKinds:["课件","串场","劳务收集表","劳务协议","议程","签到表","现场照片","权益照片"],
  activeKinds:[],custom:false,customKind:"",locked:false},
 onLoad(q){if(q.pid)this.setData({pid:q.pid});},
 onShow(){this.load();},
 async load(){
  try{
   const r=await app.api("/projects?page=1&size=100");
   const projects=r.rows||[];
   let index=projects.findIndex(x=>x.id===this.data.pid);if(index<0)index=0;
   const p=projects[index];
   this.setData({projects,index,pid:p?.id||"",locked:!p||["已结算","已归档"].includes(p.status)});
   if(p)await this.loadKinds(p.id);
  }catch(e){this.setData({error:e.message});}
 },
 async loadKinds(pid){
  try{
   const data=await app.api("/projects/"+encodeURIComponent(pid)+"/material-workbench");
   const kinds=this.data.standardKinds.filter(k=>!data.modules.some(m=>m.kind===k&&m.enabled===0));
   this.setData({activeKinds:kinds,kind:kinds.includes(this.data.kind)?this.data.kind:(kinds[0]||"会议照片"),error:""});
  }catch(e){this.setData({activeKinds:this.data.standardKinds,error:e.message});}
 },
 select(e){const index=Number(e.detail.value),p=this.data.projects[index];
  this.setData({index,pid:p.id,locked:["已结算","已归档"].includes(p.status),uploaded:""});
  this.loadKinds(p.id);
 },
 chooseKind(e){this.setData({kind:e.currentTarget.dataset.kind,custom:false});},
 chooseCustom(){this.setData({custom:true});},
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
  if(!this.data.pid||!kind||!this.data.name.trim()||kind.length>20||this.data.name.length>120){
   this.setData({error:"请选择会议并填写有效材料类别（20 字内）和名称（120 字内）"});return;
  }
  if(Number(selected.size)>20*1024*1024){this.setData({error:"单个附件不能超过 20 MB"});return;}
  this.setData({busy:true,error:"",uploaded:""});
  try{
   const buffer=await new Promise((resolve,reject)=>wx.getFileSystemManager().readFile({
    filePath:selected.tempFilePath||selected.path,success:r=>resolve(r.data),fail:reject}));
   const upload=await app.api("/uploads?pid="+encodeURIComponent(this.data.pid),"POST",buffer,
    {"Content-Type":"application/octet-stream","X-File-Name":encodeURIComponent(fileName)});
   await app.api("/projects/"+encodeURIComponent(this.data.pid)+"/materials","POST",{
    kind,name:this.data.name.trim(),file_key:upload.key,
    file_name:upload.name,file_size:upload.size,file_mime:upload.mime});
   this.setData({uploaded:"已归档："+upload.name,name:""});
   wx.showToast({title:"归档成功",icon:"success"});
  }catch(e){this.setData({error:e.message||"归档失败"});}
  finally{this.setData({busy:false});}
 }
});