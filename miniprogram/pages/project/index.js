const app=getApp();
Page({
 data:{id:"",p:null,error:"",canMaterials:false},
 onLoad(q){this.setData({id:q.id||""});this.load();},
 async load(){try{
  const r=await app.api("/projects/"+encodeURIComponent(this.data.id));
  this.setData({p:r.project,canMaterials:(app.globalData.perms||[]).includes("material:write")});
 }catch(e){this.setData({error:e.message});}},
 materials(){wx.navigateTo({url:"/pages/materials/index?pid="+encodeURIComponent(this.data.id)});}
});