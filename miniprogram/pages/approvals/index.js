const app=getApp();
Page({
 data:{rows:[],error:"",busy:false},
 onShow(){this.load();},
 async load(){try{const r=await app.api("/approvals?status="+encodeURIComponent("待审批"));
 this.setData({rows:r.rows||[],error:""});}catch(e){this.setData({error:e.message});}},
 decide(e){
  if(this.data.busy)return;
  const id=e.currentTarget.dataset.id,approve=e.currentTarget.dataset.approve==="yes";
  wx.showModal({title:approve?"确认审批通过？":"确认驳回？",
   content:"审批操作会记录操作人，提交后不可撤销。",
   success:async r=>{if(!r.confirm)return;
     this.setData({busy:true});
     try{await app.api("/approvals/"+encodeURIComponent(id)+"/decide","POST",{approve,comment:"小程序审批"});
       wx.showToast({title:"已提交",icon:"success"});await this.load();
     }catch(err){this.setData({error:err.message});}
     finally{this.setData({busy:false});}
   }});
 }
});