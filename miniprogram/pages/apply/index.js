const app=getApp();
Page({
 data:{id:"",status:"草稿",name:"",assoc:"",assocs:[],assocIndex:0,
  form:"线下",formIndex:0,forms:["线下","线上","混合"],date:"",event_end_date:"",event_start_time:"09:00",event_end_time:"18:00",days:"1",budget:"",tax_fee_rate:"",people:"",phone:"",dept:"",depts:[],deptIndex:0,deptLegacy:false,agenda:"",ocrBusy:false,ocrNotice:"",agendaFile:"",
  busy:false,error:"",isAdmin:false},
 async onLoad(q){
  const id=q.id||"";
  this.setData({id});
  try{
   const s=await app.resume();if(!s)return;
   const isAdmin=s.user?.role==="admin",assoc=s.user?.assoc||"";
   const meta=await app.api("/meta");
   const assocs=(meta.assocs||[]).filter(Boolean);
   const depts=(meta.depts||[]).filter(Boolean);
   this.setData({isAdmin,assocs,assoc:isAdmin?(assocs[0]||""):assoc,depts});
   if(id){
    const r=await app.api("/mini/applications/"+encodeURIComponent(id));
    const p=r.project;
    this.setData({name:p.name,assoc:p.assoc,assocIndex:Math.max(0,assocs.indexOf(p.assoc)),
      form:p.form,formIndex:Math.max(0,this.data.forms.indexOf(p.form)),date:p.date,
      event_end_date:p.event_end_date||this.dateAfter(p.date,Number(p.days||1)-1),
      event_start_time:p.event_start_time||"09:00",event_end_time:p.event_end_time||"18:00",days:String(p.days),
      budget:String(p.budget),tax_fee_rate:String(p.tax_fee_rate??""),people:String(p.people),phone:p.phone||"",
      dept:depts.includes(p.dept)?p.dept:"",
      deptIndex:Math.max(0,depts.indexOf(p.dept)),deptLegacy:!!p.dept&&!depts.includes(p.dept),
      agenda:p.agenda||"",status:p.status});
   }
  }catch(e){this.setData({error:e.message});}
 },
 dateAfter(value,offset){
  if(!value)return "";
  const t=new Date(value+"T00:00:00Z");
  t.setUTCDate(t.getUTCDate()+offset);
  return t.toISOString().slice(0,10);
 },
 updatePeriod(date,end){
  const start=String(date||""),finish=String(end||"");
  if(!start||!finish)return;
  const diff=(Date.parse(finish+"T00:00:00Z")-Date.parse(start+"T00:00:00Z"))/86400000;
  if(diff>=0&&diff<60)this.setData({days:String(1+diff),error:""});
  else this.setData({days:"",error:"请选择有效举办时间段，最长60天"});
 },
 input(e){this.setData({[e.currentTarget.dataset.key]:e.detail.value});},
 pickDate(e){
  const date=e.detail.value,end=this.data.event_end_date||date;
  const validEnd=end<date?date:end;
  this.setData({date,event_end_date:validEnd});
  this.updatePeriod(date,validEnd);
 },
 pickEndDate(e){
  const end=e.detail.value;
  this.setData({event_end_date:end});
  this.updatePeriod(this.data.date,end);
 },
 pickStartTime(e){this.setData({event_start_time:e.detail.value});},
 pickEndTime(e){this.setData({event_end_time:e.detail.value});},
 chooseAgenda(){
  if(this.data.ocrBusy||this.data.busy||this.data.status!=="草稿")return;
  wx.chooseMessageFile({count:1,type:"file",
   extension:["pdf","png","jpg","jpeg","docx","pptx","xlsx","txt"],
   success:async ({tempFiles})=>{
    const file=tempFiles?.[0];
    if(!file?.path)return;
    if(file.size>2*1024*1024){
      this.setData({error:"议程识别文件不超过2MB；请压缩后重试"});return;
    }
    this.setData({ocrBusy:true,ocrNotice:"正在识别议程文件…",error:""});
    try{
      const encoded=await new Promise((resolve,reject)=>wx.getFileSystemManager().readFile({
        filePath:file.path,encoding:"base64",success:r=>resolve(r.data),
        fail:()=>reject(new Error("读取议程文件失败"))
      }));
      const result=await app.api("/projects/agenda-ocr","POST",{
        filename:file.name,content_base64:encoded
      });
      this.setData({agenda:result.agenda,agendaFile:file.name,
        ocrNotice:(result.truncated?"仅识别部分页，请检查补全。":"")+"已回填初版议程，可修改后提交"});
    }catch(e){this.setData({error:e.message||"议程OCR识别失败",ocrNotice:""});}
    finally{this.setData({ocrBusy:false});}
   }
  });
 },
 pickForm(e){const i=Number(e.detail.value);this.setData({formIndex:i,form:this.data.forms[i]});},
 pickAssoc(e){const i=Number(e.detail.value);this.setData({assocIndex:i,assoc:this.data.assocs[i]});},
 pickDept(e){const i=Number(e.detail.value);this.setData({deptIndex:i,dept:this.data.depts[i],deptLegacy:false});},
 async save(e){
  if(this.data.busy || this.data.ocrBusy || this.data.status!=="草稿")return;
  const submit=e.currentTarget.dataset.submit==="yes";
  const {name,assoc,form,date,event_end_date,event_start_time,event_end_time,days,budget,tax_fee_rate,people,phone,dept,agenda}=this.data;
  if(!name.trim()||!date||!event_end_date||!days||!String(budget).trim()||!String(tax_fee_rate).trim()||!dept||!agenda.trim()){
   this.setData({error:"请填写会议名称、日期、预算、税费管理费率、承办部门及议程要点"});return;
  }
  const rate=Number(tax_fee_rate);
  if(!Number.isFinite(rate)||rate<0||rate>100||Math.abs(rate*100-Math.round(rate*100))>1e-7){
   this.setData({error:"税费管理费率须为0～100%，最多保留两位小数"});return;
  }
  if(date===event_end_date&&event_end_time&&event_start_time&&event_end_time<event_start_time){
    this.setData({error:"结束时间不能早于开始时间"});return;
  }
  this.setData({busy:true,error:""});
  try{
   const body={name,assoc,form,date,event_end_date,event_start_time,event_end_time,
     days:Number(days),budget:Number(budget),tax_fee_rate:rate,people:Number(people||0),phone,dept,agenda};
   const p=this.data.id
    ? (await app.api("/mini/applications/"+encodeURIComponent(this.data.id),"PATCH",body)).project
    : (await app.api("/mini/applications","POST",body)).project;
   this.setData({id:p.id});
   if(submit){
    const result=await app.api("/mini/applications/"+encodeURIComponent(p.id)+"/submit","POST",{});
    this.setData({status:result.project.status});
   }
   wx.showToast({title:submit?"已提交审批":"草稿已保存",icon:"success"});
   wx.redirectTo({url:"/pages/projects/index?tab=mine"});
  }catch(err){this.setData({error:err.message||"保存失败"});}
  finally{this.setData({busy:false});}
 }
});