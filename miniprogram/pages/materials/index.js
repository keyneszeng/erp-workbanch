const app=getApp();
Page({
 data:{projects:[],index:0,pid:"",kind:"课件",name:"",error:"",busy:false,uploaded:"",
  standardKinds:["课件","串场","劳务收集表","劳务协议","议程","签到表","现场照片"],
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
  const kind=this.data.custom?this.data.customKind.trim():this.data.kind.trim();
  if(!this.data.pid||!kind||!this.data.name.trim()||kind.length>20||this.data.name.length>120){
   this.setData({error:"请选项目并填写有效的材料类别（≤20字）与名称（≤120字）"});return;
  }
  this.setData({busy:true,error:"",uploaded:""});
  try{
   const media=await new Promise((resolve,reject)=>wx.chooseMedia({
    count:1,mediaType:["image"],sourceType:["album","camera"],
    success:resolve,fail:reject}));
   const selected=media.tempFiles[0];
   if(selected.size>8*1024*1024)throw new Error("图片不得超过 8 MB");
   const buffer=await new Promise((resolve,reject)=>wx.getFileSystemManager().readFile({
    filePath:selected.tempFilePath,success:r=>resolve(r.data),fail:reject}));
   const ext=/\.png$/i.test(selected.tempFilePath)?"png":/\.webp$/i.test(selected.tempFilePath)?"webp":"jpg";
   const upload=await app.api("/uploads?pid="+encodeURIComponent(this.data.pid),"POST",buffer,
    {"Content-Type":"application/octet-stream","X-File-Name":encodeURIComponent("photo."+ext)});
   await app.api("/projects/"+encodeURIComponent(this.data.pid)+"/materials","POST",{
     kind,name:this.data.name.trim(),file_key:upload.key,file_name:upload.name,file_size:upload.size,file_mime:upload.mime});
   this.setData({uploaded:"已归档："+upload.name,name:""});
   wx.showToast({title:"归档成功",icon:"success"});
  }catch(e){this.setData({error:e.message||"上传失败"});}
  finally{this.setData({busy:false});}
 }
});