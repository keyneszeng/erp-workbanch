const app=getApp();
Page({
 data:{topic:"",requested_assoc:"",event_date:"",event_end_date:"",
   event_time:"09:00",event_end_time:"18:00",form:"线下",forms:["线下","线上","混合"],formIndex:0,
   budget:"",tax_fee_rate:"0",people:"",dept:"",agenda:"",agendaFile:"",ocrBusy:false,ocrNotice:"",
   contact_name:"",contact_phone:"",contact_info:"",
   website:"",consent:false,busy:false,error:"",reference:"",submitted:false},
 input(e){this.setData({[e.currentTarget.dataset.key]:e.detail.value});},
 pickDate(e){const date=e.detail.value;this.setData({event_date:date,event_end_date:!this.data.event_end_date||this.data.event_end_date<date?date:this.data.event_end_date});},
 pickEndDate(e){this.setData({event_end_date:e.detail.value});},
 pickTime(e){this.setData({event_time:e.detail.value});},
 pickEndTime(e){this.setData({event_end_time:e.detail.value});},
 pickForm(e){const i=Number(e.detail.value);this.setData({formIndex:i,form:this.data.forms[i]});},
 agree(e){this.setData({consent:e.detail.value.includes("agree")});},
 chooseAgenda(){
  if(this.data.ocrBusy||this.data.busy)return;
  wx.chooseMessageFile({
   count:1,type:"file",extension:["pdf","png","jpg","jpeg","docx","pptx","xlsx","txt"],
   success:async ({tempFiles})=>{
    const file=tempFiles?.[0];
    if(!file?.path)return;
    if(file.size>2*1024*1024){
     this.setData({error:"议程识别文件不能超过2MB；可压缩PDF或直接填写议程"});return;
    }
    this.setData({ocrBusy:true,error:"",ocrNotice:"正在从议程文件提取文字…"});
    try{
     const encoded=await new Promise((resolve,reject)=>wx.getFileSystemManager().readFile({
      filePath:file.path,encoding:"base64",success:r=>resolve(r.data),
      fail:()=>reject(new Error("读取议程文件失败"))}));
     const result=await app.api("/public/event-proposals/agenda-ocr","POST",{
      filename:file.name,content_base64:encoded
     });
     this.setData({agenda:result.agenda,agendaFile:file.name,
      ocrNotice:(result.truncated?"仅识别了部分页，请检查后补齐；":"")+
       "识别成功，请核对议程内容后提交"});
    }catch(err){this.setData({error:err.message||"议程识别失败，请手动录入",ocrNotice:""});}
    finally{this.setData({ocrBusy:false});}
   }
  });
 },
 async submit(){
  if(this.data.busy||this.data.submitted||this.data.ocrBusy)return;
  const {topic,requested_assoc,event_date,event_end_date,event_time,event_end_time,
   form,budget,tax_fee_rate,people,dept,agenda,contact_name,contact_phone,contact_info,website,consent}=this.data;
  if(!topic.trim()||!event_date||!event_end_date||!event_time||!event_end_time||!agenda.trim()||!contact_name.trim()||!contact_phone.trim()||!String(budget).trim()){
   this.setData({error:"请完整填写会议名称、举办时间段、预算、议程及联系人信息"});return;
  }
  if(event_end_date<event_date||(event_end_date===event_date&&event_end_time<event_time)){
   this.setData({error:"举办结束时间不能早于开始时间"});return;
  }
  if(!consent){this.setData({error:"请先同意个人信息用于本次活动申请联系"});return;}
  this.setData({busy:true,error:""});
  try{
   const result=await app.api("/public/event-proposals","POST",{
    topic,requested_assoc,event_date,event_end_date,event_time,event_end_time,form,
    budget:String(budget).trim(),tax_fee_rate:String(tax_fee_rate||"0"),
    people:String(people||"0"),dept,agenda,contact_name,contact_phone,
    contact_info,website,consent
   });
   this.setData({reference:result.reference||"",submitted:true});
   wx.showToast({title:"提交成功",icon:"success"});
  }catch(e){this.setData({error:e.message||"提交失败，请稍后重试"});}
  finally{this.setData({busy:false});}
 },
 again(){this.setData({topic:"",requested_assoc:"",event_date:"",event_end_date:"",
   event_time:"09:00",event_end_time:"18:00",form:"线下",formIndex:0,budget:"",
   tax_fee_rate:"0",people:"",dept:"",agenda:"",agendaFile:"",ocrNotice:"",
   contact_name:"",contact_phone:"",contact_info:"",consent:false,reference:"",
   submitted:false,error:""});},
 onShareAppMessage(){return {title:"会规智云 · 公众立项申请",path:"/pages/public-proposal/index"};}
});