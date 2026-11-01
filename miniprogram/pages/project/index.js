const app=getApp();
const stages=["草稿","待审批","已立项","筹备中","执行中","待核销","已核销","已结算","已归档"];
Page({
 data:{id:"",p:null,error:"",canMaterials:false,canApprove:false,stagePercent:0,
    stageLabel:"",isExecutor:false,canApply:false},
 onLoad(q){this.setData({id:q.id||""});this.load();},
 onShow(){if(this.data.id)this.load();},
 async load(){
  try{
   const r=await app.api("/projects/"+encodeURIComponent(this.data.id));
   const p=r.project,ps=app.globalData.perms||[];
   const idx=stages.indexOf(p.status);
   this.setData({p,stageLabel:idx>=0?(idx+1)+"/9 · "+p.status:p.status,
     stagePercent:Math.round(Math.max(0,idx)/8*100),
     canMaterials:ps.includes("material:write"),
     canApprove:ps.includes("project:approve"),
     isExecutor:ps.includes("material:write")||ps.includes("project:transition"),error:""});
  }catch(e){this.setData({error:e.message});}
 },
 materials(){wx.navigateTo({url:"/pages/materials/index?pid="+encodeURIComponent(this.data.id)});},
 approvals(){wx.navigateTo({url:"/pages/approvals/index"});},
 onShareAppMessage(){
  return {title:this.data.p?.name||"协会会议详情",path:"/pages/project/index?id="+encodeURIComponent(this.data.id)};
 }
});