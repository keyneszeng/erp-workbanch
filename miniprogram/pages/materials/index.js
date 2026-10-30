const app=getApp();
Page({
 data:{projects:[],index:0,pid:"",kind:"会议照片",name:"",error:"",busy:false,uploaded:""},
 onLoad(q){if(q.pid)this.setData({pid:q.pid});},
 onShow(){this.load();},
 async load(){
  try{
   const r=await app.api("/projects?page=1&size=100");
   const projects=r.rows||[];
   let index=projects.findIndex(x=>x.id===this.data.pid);if(index<0)index=0;
   this.setData({projects,index,pid:projects[index]?.id||""});
  }catch(e){this.setData({error:e.message});}
 },
 select(e){const index=Number(e.detail.value);
  this.setData({index,pid:this.data.projects[index].id});},
 input(e){this.setData({[e.currentTarget.dataset.key]:e.detail.value});},
 async addPhoto(){
  if(this.data.busy)return;
  if(!this.data.pid||!this.data.kind.trim()||!this.data.name.trim()) {
    this.setData({error:"请先选择项目并填写材料类别与名称"});return;
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
     kind:this.data.kind.trim(),name:this.data.name.trim(),file_key:upload.key,
     file_name:upload.name,file_size:upload.size,file_mime:upload.mime});
   this.setData({uploaded:"已归档："+upload.name,name:""});
   wx.showToast({title:"归档成功",icon:"success"});
  }catch(e){this.setData({error:e.message||"上传失败"});}
  finally{this.setData({busy:false});}
 }
});