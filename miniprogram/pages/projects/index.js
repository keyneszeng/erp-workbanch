const app=getApp();
Page({
 data:{rows:[],error:"",loading:false,page:1,total:0},
 onShow(){this.load(true);},
 async load(reset){
  if(this.data.loading)return;
  const page=reset?1:this.data.page;
  this.setData({loading:true,error:""});
  try{
   const r=await app.api("/projects?page="+page+"&size=30");
   this.setData({rows:reset?r.rows:this.data.rows.concat(r.rows),total:r.total,
     page:page+1,loading:false});
  }catch(e){this.setData({error:e.message,loading:false});}
 },
 onReachBottom(){if(this.data.rows.length<this.data.total)this.load(false);},
 open(e){wx.navigateTo({url:"/pages/project/index?id="+encodeURIComponent(e.currentTarget.dataset.id)});}
});