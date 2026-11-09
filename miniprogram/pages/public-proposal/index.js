const app=getApp();
Page({
 data:{topic:"",event_date:"",event_time:"",form:"线下",forms:["线下","线上","混合"],formIndex:0,
   budget:"",agenda:"",contact_name:"",contact_phone:"",contact_info:"",
   website:"",consent:false,busy:false,error:"",reference:"",submitted:false},
 input(e){this.setData({[e.currentTarget.dataset.key]:e.detail.value});},
 pickDate(e){this.setData({event_date:e.detail.value});},
 pickTime(e){this.setData({event_time:e.detail.value});},
 pickForm(e){const i=Number(e.detail.value);this.setData({formIndex:i,form:this.data.forms[i]});},
 agree(e){this.setData({consent:e.detail.value.includes("agree")});},
 async submit(){
  if(this.data.busy||this.data.submitted)return;
  const {topic,event_date,event_time,form,budget,agenda,contact_name,contact_phone,contact_info,website,consent}=this.data;
  if(!topic.trim()||!event_date||!event_time||!agenda.trim()||!contact_name.trim()||!contact_phone.trim()||!String(budget).trim()){
   this.setData({error:"请完整填写主题、时间、预算、议程及联系人信息"});return;
  }
  if(!consent){this.setData({error:"请先同意个人信息用于本次活动申请联系"});return;}
  this.setData({busy:true,error:""});
  try{
   const result=await app.api("/public/event-proposals","POST",
    {topic,event_date,event_time,form,budget:String(budget).trim(),agenda,contact_name,contact_phone,contact_info,website,consent});
   this.setData({reference:result.reference||"",submitted:true});
   wx.showToast({title:"提交成功",icon:"success"});
  }catch(e){this.setData({error:e.message||"提交失败，请稍后重试"});}
  finally{this.setData({busy:false});}
 },
 again(){this.setData({topic:"",event_date:"",event_time:"",form:"线下",formIndex:0,budget:"",agenda:"",contact_name:"",
   contact_phone:"",contact_info:"",consent:false,reference:"",submitted:false,error:""});},
 onShareAppMessage(){return {title:"社会公众活动立项申请",path:"/pages/public-proposal/index"};}
});