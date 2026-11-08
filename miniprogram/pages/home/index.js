const app=getApp();
Page({
 data:{user:null,role:"",loading:true,error:"",canApprove:false,canMaterials:false,
   canApply:false,canMeetings:false,isExecutor:false,dashboard:null,stats:[]},
 async onShow(){
  this.setData({loading:true,error:""});
  try{
   const state=await app.resume();if(!state)return;
   if(state.user?.mustChangePassword){wx.navigateTo({url:"/pages/account/index"});return;}
   const ps=app.globalData.perms||[],user=app.globalData.user;
   const canApprove=ps.some(p=>["project:approve","verify:exception_approve","payment:approve","contract:approve"].includes(p));
   const canMaterials=ps.includes("material:write");
   const canApply=ps.includes("mini:apply");
   const canMeetings=!!state.role?.modules?.some(x=>["projects","prep","demand","exec","materials","verify","finance","archive"].includes(x)) ||
     ps.some(x=>["mini:apply","material:write","payment:create","verify:check","project:create","project:transition","archive:download"].includes(x)) || user?.role==="admin";
   let dashboard={counts:{}};
   if(state.role?.modules?.includes("dashboard") || user?.role==="admin") {
     try { dashboard=await app.api("/dashboard"); }
     catch(e){if(e.status!==403)throw e;}
   }
   const counts=dashboard.counts||{};
   const stats=state.role?.modules?.includes("dashboard") || user?.role==="admin" ? [
    {label:"待审批",value:counts["待审批"]||0},
    {label:"执行中",value:counts["执行中"]||0},
    {label:"待核销",value:counts["待核销"]||0}
   ] : [];
   this.setData({user,role:state.role?.name||"",dashboard,stats,canApprove,canMaterials,
     canApply,canMeetings,isExecutor:canMaterials||canApprove,loading:false});
  }catch(e){this.setData({error:e.message,loading:false});}
 },
 go(e){
  const page=e.currentTarget.dataset.page;
  if(page)wx.navigateTo({url:"/pages/"+page+"/index"});
 },
 myApplications(){wx.navigateTo({url:"/pages/projects/index?tab=mine"});},
 meetingList(){wx.navigateTo({url:"/pages/projects/index?tab=all"});}
});