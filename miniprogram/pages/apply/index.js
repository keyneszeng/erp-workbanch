const app=getApp();
Page({
 data:{id:"",status:"草稿",name:"",assoc:"",assocs:[],assocIndex:0,
  form:"线下",formIndex:0,forms:["线下","线上","混合"],date:"",days:"1",budget:"",people:"",phone:"",dept:"",depts:[],deptIndex:0,deptLegacy:false,agenda:"",
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
      form:p.form,formIndex:Math.max(0,this.data.forms.indexOf(p.form)),date:p.date,days:String(p.days),
      budget:String(p.budget),people:String(p.people),phone:p.phone||"",
      dept:depts.includes(p.dept)?p.dept:"",
      deptIndex:Math.max(0,depts.indexOf(p.dept)),deptLegacy:!!p.dept&&!depts.includes(p.dept),
      agenda:p.agenda||"",status:p.status});
   }
  }catch(e){this.setData({error:e.message});}
 },
 input(e){this.setData({[e.currentTarget.dataset.key]:e.detail.value});},
 pickDate(e){this.setData({date:e.detail.value});},
 pickForm(e){const i=Number(e.detail.value);this.setData({formIndex:i,form:this.data.forms[i]});},
 pickAssoc(e){const i=Number(e.detail.value);this.setData({assocIndex:i,assoc:this.data.assocs[i]});},
 pickDept(e){const i=Number(e.detail.value);this.setData({deptIndex:i,dept:this.data.depts[i],deptLegacy:false});},
 async save(e){
  if(this.data.busy || this.data.status!=="草稿")return;
  const submit=e.currentTarget.dataset.submit==="yes";
  const {name,assoc,form,date,days,budget,people,phone,dept,agenda}=this.data;
  if(!name.trim()||!date||!String(budget).trim()||!dept||!agenda.trim()){
   this.setData({error:"请填写会议名称、日期、预算、承办部门及议程要点"});return;
  }
  this.setData({busy:true,error:""});
  try{
   const body={name,assoc,form,date,days:Number(days),budget:Number(budget),people:Number(people||0),phone,dept,agenda};
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