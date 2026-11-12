const app=getApp();
const stages=["草稿","待审批","已立项","筹备中","执行中","待核销","已核销","已结算","已归档"];
Page({
 data:{id:"",p:null,error:"",canMaterials:false,canApprove:false,stagePercent:0,
    stageLabel:"",statusNote:"",isExecutor:false,canApply:false,
    canVerify:false,canFinance:false,settlementSummary:null,settlementGroups:[],verifySummary:null},
 onLoad(q){this.setData({id:q.id||""});this.load();},
 onShow(){if(this.data.id)this.load();},
 async load(){
  try{
   const r=await app.api("/projects/"+encodeURIComponent(this.data.id));
   const p=r.project,ps=app.globalData.perms||[];
   const idx=stages.indexOf(p.status);
   const canMaterials=ps.includes("material:write")&&!["已结算","已归档"].includes(p.status);
   const canApprove=["project:approve","verify:exception_approve","payment:approve","contract:approve"].some(x=>ps.includes(x));
   const statusNotes={
     "草稿":"填写会议资料与初版议程后，提交立项审批。",
     "待审批":"立项等待授权审批人员审核。",
     "已立项":"项目已获批准，等待负责人推进筹备。",
     "筹备中":"按项目确认会务需求、合同与会议材料。",
     "执行中":"执行会议并采集现场原始资料。",
     "待核销":"会后按照七项规则进行核销，第5～7项根据劳务表、实际会务需求与赞助合同按需启用。",
     "已核销":"核销通过；仍须完成付款申请、审批、付款登记与金额核对后才能结算。",
     "已结算":"结算单已生成，核销结论和相关资料已冻结。",
     "已归档":"数字卷宗已封存，可按权限查阅历史记录。"
   };
   const canVerify=r.sectionAccess?.verify===true;
   const canFinance=r.sectionAccess?.finance===true;
   const breakdown=canFinance?r.settlementBreakdown:null;
   const summary=breakdown?.summary||null;
   const settlementSummary=summary?{
     budget:Number(summary.budget||0).toFixed(2),
     availableBudget:Number(summary.available_budget||0).toFixed(2),
     paid:Number(summary.paid||0).toFixed(2),
     balance:Number(summary.balance||0).toFixed(2)
   }:null;
   const settlementGroups=(breakdown?.groups||[]).map(g=>({
      key:g.key,label:g.label,count:g.count,amount:Number(g.amount||0).toFixed(2),
      items:(g.items||[]).map(y=>({id:y.id,type:y.type,payee:y.payee,
        amount:Number(y.amount||0).toFixed(2),paidAt:y.paid_at||"—",remark:y.remark||""}))
   }));
   const verifySummary=canVerify&&r.verification?{
      passed:r.verification.passed||0,total:r.verification.total||0,
      complete:!!r.verification.complete
   }:null;
   this.setData({canVerify,canFinance,settlementSummary,settlementGroups,verifySummary,
    p,stageLabel:idx>=0?(idx+1)+"/9 · "+p.status:p.status,statusNote:statusNotes[p.status]||"",
     stagePercent:Math.round(Math.max(0,idx)/8*100),
     canMaterials,
     canApprove,
     isExecutor:canMaterials||canApprove,error:""});
  }catch(e){this.setData({error:e.message});}
 },
 materials(){wx.navigateTo({url:"/pages/materials/index?pid="+encodeURIComponent(this.data.id)});},
 verification(){if(this.data.canVerify)wx.navigateTo({url:"/pages/verification/index?pid="+encodeURIComponent(this.data.id)});},
 approvals(){wx.navigateTo({url:"/pages/approvals/index"});},
 onShareAppMessage(){
  return {title:this.data.p?.name||"协会会议详情",path:"/pages/project/index?id="+encodeURIComponent(this.data.id)};
 }
});