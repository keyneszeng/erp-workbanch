const app=getApp();
Page({
 data:{rows:[],error:"",loading:false,page:1,total:0,tab:"all",tabs:[{key:"all",label:"我的会议"},{key:"mine",label:"我的申请"}]},
 onLoad(q){const ps=getApp().globalData.perms||[];const canApply=ps.includes("mini:apply");
  this.setData({tabs:canApply?[{key:"all",label:"我的会议"},{key:"mine",label:"我的申请"}]:[{key:"all",label:"我的会议"}],tab:q.tab==="mine"&&canApply?"mine":"all"});},
 onShow(){this.load(true);},
 changeTab(e){const tab=e.currentTarget.dataset.tab;if(tab!==this.data.tab){this.setData({tab});this.load(true);}},
 async load(reset){
  if(this.data.loading)return;
  const page=reset?1:this.data.page;
  this.setData({loading:true,error:""});
  try{
   const mine=this.data.tab==="mine";
   const r=await app.api(mine?"/mini/applications":"/projects?page="+page+"&size=30");
   const rows=mine?(r.rows||[]).map(x=>({...x,ownDraft:x.status==="草稿"})):(r.rows||[]);
   this.setData({rows:reset?rows:this.data.rows.concat(rows),total:r.total,
      page:page+1,loading:false});
  }catch(e){this.setData({error:e.message,loading:false});}
 },
 onReachBottom(){if(this.data.tab==="all"&&this.data.rows.length<this.data.total)this.load(false);},
 open(e){
  const id=encodeURIComponent(e.currentTarget.dataset.id);
  if(e.currentTarget.dataset.draft==="yes"){
   wx.navigateTo({url:"/pages/apply/index?id="+id});return;
  }
  wx.navigateTo({url:"/pages/project/index?id="+id});
 },
 apply(){wx.navigateTo({url:"/pages/apply/index"});}
});