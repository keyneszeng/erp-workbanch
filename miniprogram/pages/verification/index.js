const app=getApp();
// Same material categories as web verification; every item is scoped by the project API.
const KIND_BY_STEP={
  1:["会议通知","招商函","终版议程","串场"],
  2:["终版议程","讲者照片"],
  3:["签到表","在线记录","直播数据","在线时长","会议截图"],
  4:["终版议程","课件"],
  5:["劳务表","劳务登记表","劳务收集表"],
  6:["会务协议","会务发票","发票"],
  7:["权益照片","赞助合同"]
};
const stepMaterials=(no,materials,contracts,sponsorRights)=>{
  const kinds=KIND_BY_STEP[no]||[];
  const laborKeys=new Set((contracts||[]).filter(c=>c.category==="劳务专家").map(c=>c.file_key).filter(Boolean));
  const meetingKeys=new Set((contracts||[]).filter(c=>c.category==="会务需求").map(c=>c.file_key).filter(Boolean));
  const sponsorKeys=new Set((sponsorRights?.contracts||[]).map(c=>c.file_key).filter(Boolean));
  return (materials||[]).filter(m=>{
    if(!m.file_key||m.deleted_at)return false;
    if(m.kind==="终版议程"&&m.version!=="终版")return false;
    if(no===5&&laborKeys.has(m.file_key))return true;
    if(no===6&&meetingKeys.has(m.file_key))return true;
    if(no===7&&sponsorKeys.has(m.file_key))return true;
    if(!kinds.includes(m.kind))return false;
    if(no===6&&m.kind==="发票"&&!/会务|会议服务|会议执行/.test((m.name||"")+" "+(m.file_name||"")))return false;
    return true;
  }).map(m=>({id:m.id,kind:m.kind,name:m.name||m.file_name||"未命名原件",fileName:m.file_name||"",key:m.file_key,
    version:m.version||""}));
};
Page({
 data:{pid:"",title:"",loading:false,error:"",steps:[],passed:0,total:0,openExceptions:0,complete:false,selectedNo:1,selected:null,files:[],canReview:false},
 onLoad(q){this.setData({pid:q.pid||""});},
 onShow(){if(this.data.pid)this.load();},
 async load(){
  if(this.data.loading)return;
  const pid=this.data.pid;
  this.setData({loading:true,error:""});
  try{
   const r=await app.api("/projects/"+encodeURIComponent(pid));
   if(this.data.pid!==pid)return;
   if(!r.sectionAccess?.verify)throw new Error("当前账号无核销详情查看权限");
   const v=r.verification||{};
   const steps=(v.steps||[]).map(s=>({no:s.no,name:s.name,result:s.result||"待判定",
      required:s.required!==false,displayResult:s.required===false?"不适用":(s.result||"待判定")}));
   this._source={materials:r.materials||[],contracts:r.contracts||[],sponsorRights:r.sponsorRights||{}};
   this.setData({title:r.project?.name||pid,steps,passed:v.passed||0,total:v.total||0,
    openExceptions:v.openExceptions||0,complete:!!v.complete,loading:false});
   this.selectStep({currentTarget:{dataset:{no:this.data.selectedNo}}});
  }catch(e){this.setData({loading:false,error:e.message||"核销信息读取失败",steps:[],selected:null,files:[]});}
 },
 selectStep(e){
  const no=Number(e.currentTarget.dataset.no);
  const selected=this.data.steps.find(s=>Number(s.no)===no);
  if(!selected)return;
  const source=this._source||{};
  const files=stepMaterials(no,source.materials,source.contracts,source.sponsorRights);
  this.setData({selectedNo:no,selected,files});
 },
 async viewOriginal(e){
  const id=Number(e.currentTarget.dataset.id);
  const f=this.data.files.find(x=>Number(x.id)===id);
  if(!f)return;
  try{await app.openOriginal(f.key);}
  catch(err){this.setData({error:err.message||"原件查看失败"});}
 },
 onPullDownRefresh(){this.load().finally(()=>wx.stopPullDownRefresh());}
});