const app=getApp();
Page({
 data:{user:null,userInitial:"会",role:"",loading:true,error:"",canApprove:false,canMaterials:false,
   canApply:false,canMeetings:false,isExecutor:false,dashboard:null,stats:[],budgetTodos:[],readingBudgetPid:""},
 async onShow(){
  this.setData({loading:true,error:"",budgetTodos:[]});
  try{
   const state=await app.resume();if(!state)return;
   if(state.user?.mustChangePassword){wx.navigateTo({url:"/pages/account/index"});return;}
   const ps=app.globalData.perms||[],user=app.globalData.user;
   const canApprove=ps.some(p=>["project:approve","verify:exception_approve","payment:approve","contract:approve"].includes(p));
   const canMaterials=!!state.role?.modules?.some(x=>["materials","verify","prep","finance"].includes(x))||ps.some(x=>["material:write","material:file:replace","contract:write","contract:approve","verify:check","verify:conclude","archive:write","archive:download"].includes(x))||user?.role==="admin";
   const canApply=ps.includes("mini:apply");
   const canMeetings=!!state.role?.modules?.some(x=>["projects","prep","demand","exec","materials","verify","finance","archive"].includes(x)) ||
     canMaterials || ps.some(x=>["mini:apply","material:write","payment:create","verify:check","project:create","project:transition","archive:download"].includes(x)) || user?.role==="admin";
   let dashboard={counts:{}};
   if(state.role?.modules?.includes("dashboard") || user?.role==="admin") {
     try { dashboard=await app.api("/dashboard"); }
     catch(e){if(e.status!==403)throw e;}
   }
   // 与 Web 工作台同源；没有工作台模块的项目业务账号只读本人的专项待办。
   let budgetTodos=Array.isArray(dashboard.todos)?dashboard.todos.filter(t=>t.kind==="超预算"):[];
   if(!Array.isArray(dashboard.todos)&&canMeetings){
    try{budgetTodos=(await app.api("/my-budget-todos")).rows||[];}
    catch(e){if(e.status!==403)throw e;}
   }
   budgetTodos=budgetTodos.filter(t=>t.kind==="超预算"&&Number(t.balance)<0).map(t=>({...t,overrunText:Number(t.overrun).toFixed(2)}));
   const counts=dashboard.counts||{};
   const stats=state.role?.modules?.includes("dashboard") || user?.role==="admin" ? [
    {label:"待审批",value:counts["待审批"]||0},
    {label:"执行中",value:counts["执行中"]||0},
    {label:"待核销",value:counts["待核销"]||0}
   ] : [];
   this.setData({user,userInitial:String(user?.name||"会").slice(0,1),role:state.role?.name||"",dashboard,stats,budgetTodos,canApprove,canMaterials,
     canApply,canMeetings,isExecutor:canMaterials||canApprove,loading:false});
  }catch(e){this.setData({error:e.message,loading:false});}
 },
 go(e){
  const page=e.currentTarget.dataset.page;
  if(page)wx.navigateTo({url:"/pages/"+page+"/index"});
 },
 async openBudgetTodo(e){
  const pid=String(e.currentTarget.dataset.pid||"");
  const item=this.data.budgetTodos.find(t=>t.pid===pid);
  if(!item||this.data.readingBudgetPid)return;
  this.setData({readingBudgetPid:pid});
  try{
   await app.api("/my-budget-todos/"+encodeURIComponent(pid)+"/read","POST",{overrun:item.overrun});
   this.setData({budgetTodos:this.data.budgetTodos.filter(t=>t.pid!==pid)});
   if(this.data.canMeetings)wx.navigateTo({url:"/pages/project/index?id="+encodeURIComponent(pid)});
  }catch(e){
   wx.showToast({title:e.message||"确认已读失败，请重试",icon:"none"});
   if(e.code==="BUDGET_TODO_CHANGED")await this.onShow();
  }finally{this.setData({readingBudgetPid:""});}
 },
 myApplications(){wx.navigateTo({url:"/pages/projects/index?tab=mine"});},
 meetingList(){wx.navigateTo({url:"/pages/projects/index?tab=all"});}
});
