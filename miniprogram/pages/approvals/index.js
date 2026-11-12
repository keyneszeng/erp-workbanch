const app=getApp();
Page({
 data:{rows:[],error:"",busy:false,loading:true},
 canDecide(type){
  const ps=app.globalData.perms||[];
  const perm={"立项审批":"project:approve","变更审批":"project:approve","例外单审批":"verify:exception_approve",
    "合同审批":"contract:approve","付款审批":"payment:approve"}[type];
  return !!perm&&ps.includes(perm);
 },
 onShow(){this.load();},
 async load(){this.setData({loading:true});try{const r=await app.api("/approvals?status="+encodeURIComponent("待审批"));
 this.setData({rows:(r.rows||[]).filter(x=>this.canDecide(x.type)),error:""});}catch(e){this.setData({error:e.message});}
 finally{this.setData({loading:false});}},
 decide(e){
  if(this.data.busy)return;
  const id=e.currentTarget.dataset.id,approve=e.currentTarget.dataset.approve==="yes";
  const item=this.data.rows.find(x=>String(x.id)===String(id));
  if(!item||!this.canDecide(item.type))return this.setData({error:"当前账号没有该类型审批权限"});
  wx.showModal({title:approve?"确认审批通过？":"请填写驳回原因",
   content:approve?"审批会记录操作者，提交后不可撤销。":"请输入具体驳回理由，便于申请人整改。",
   editable:!approve,placeholderText:approve?"":"请说明不通过的原因",
   success:async r=>{if(!r.confirm)return;
     const comment=approve?"小程序审批通过":String(r.content||"").trim();
     if(!approve&&!comment){this.setData({error:"驳回时必须填写理由"});return;}
     this.setData({busy:true});
     try{await app.api("/approvals/"+encodeURIComponent(id)+"/decide","POST",{approve,comment});
       wx.showToast({title:"已提交",icon:"success"});await this.load();
     }catch(err){this.setData({error:err.message});}
     finally{this.setData({busy:false});}
   }});
 }
});
