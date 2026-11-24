import {api,state} from "../lib/api.js";
import {esc,modal,toast,confirmBox,table,pager,bindPager} from "../lib/ui.js";

// Only the superadmin may view or edit this workspace; backend enforces it independently.
let selectedType="project",search="",pageNo=1,seq=0;
const sensitive=/bank|account|phone|contact|email|token/i;
const brief=v=>String(v??"—").slice(0,100);
const urlPart=v=>encodeURIComponent(String(v));
const label=(f,value)=>{
 if(f.t==="bool")return Number(value)===1?"是":"否";
 return value==null?"（空）":String(value);
};
export async function render(root,params=[]){
 if(!state.super){
  root.innerHTML='<div class="panel">内容修订仅总管理员可以使用。</div>';return;
 }
 const pid=params[0]||"";
 const request=++seq;
 if(!pid){
  const data=await api.get("/api/admin/content/projects?q="+encodeURIComponent(search));
  if(request!==seq||!root.isConnected)return;
  root.innerHTML='<div class="phead"><div><h2>总管理员 · 内容修订</h2><p>查找项目并更正任意阶段的业务内容，包括已签署、已核销、已结算和已归档记录。</p></div></div>'+
    '<div class="panel"><div class="panel-h"><h2>按会议名称 / 编号检索</h2><span class="hint">仅总管理员</span></div>'+
    '<div class="filters"><input type="search" id="admin-content-search" placeholder="输入项目名称、编号或协会" value="'+esc(search)+'">'+
    '<button type="button" class="btn btn-p" id="admin-content-search-btn">搜索</button></div>'+
    table([{t:"会议编号",w:"155px"},{t:"项目名称"},{t:"协会"},{t:"项目状态",w:"100px"},{t:"操作",w:"110px"}],
      data.rows.map(p=>({c:[esc(p.id),esc(p.name),esc(p.assoc),esc(p.status),
       '<button class="link" type="button" data-go="admin-content/'+esc(p.id)+'">打开内容修订</button>']})),
      {empty:"没有符合条件的会议"})+
    '<p class="hint" style="margin-top:10px">每次显示最多 100 个结果；可按名称或编号缩小搜索范围。修改记录需填写原因，历史版本永久留痕。</p></div>';
  const input=root.querySelector("#admin-content-search");
  root.querySelector("#admin-content-search-btn").onclick=()=>{search=input.value.trim();render(root,[]);};
  input.onkeydown=e=>{if(e.key==="Enter"){search=input.value.trim();render(root,[]);}};
  return;
 }
 const [meta,data]=await Promise.all([
  api.get("/api/admin/content/types"),
  api.get("/api/admin/content/"+urlPart(pid)+"/"+urlPart(selectedType)+"?page="+pageNo+"&size=30")
 ]);
 if(request!==seq||!root.isConnected)return;
 const type=meta.types.find(t=>t.key===selectedType)||meta.types[0];
 const prefix="/api/admin/content/"+urlPart(pid)+"/"+urlPart(selectedType);
 root.innerHTML='<div class="phead"><div><button class="btn btn-o btn-sm" type="button" data-go="admin-content">← 选择其他项目</button>'+
  '<h2 style="margin-top:12px">'+esc(data.project.name)+'</h2><p>总管理员内容修订 · '+esc(data.project.id)+' · '+esc(data.project.status)+'</p></div>'+
  '<div class="acts"><button class="btn btn-o" type="button" data-go="projects/'+esc(pid)+'">查看项目原页面</button></div></div>'+
  '<div class="panel mt"><div class="panel-h"><h2>选择需要更正的内容</h2><span class="hint">所有修改均记录操作人、时间、原因、旧值和新值</span></div>'+
  '<div class="filters"><select id="admin-content-type" aria-label="选择内容类别">'+
   meta.types.map(t=>'<option value="'+esc(t.key)+'"'+(t.key===selectedType?" selected":"")+'>'+esc(t.label)+'</option>').join("")+
  '</select></div><p class="hint">修订数据会立即影响业务展示；已签署合同、付款与结算的实际凭证不自动更改。必须复核关联记录，原始文件、历史签章快照和审计记录不允许在此覆盖。</p></div>'+
  '<div class="panel mt"><div class="panel-h"><h2>'+esc(type.label)+'</h2><span class="hint">'+data.total+' 条记录</span></div>'+
  table([{t:"记录编号",w:"125px"},{t:"内容概要"},{t:"业务状态",w:"110px"},{t:"操作",w:"150px"}],
  data.rows.map(item=>{
   const id=item[type.key==="project"?"id":type.key==="demand_sheets"||type.key==="initiation_letters"?"pid":
      type.key==="verify_steps"?"step_no":"id"];
   const summary=type.fields.filter(f=>!sensitive.test(f.k)&&!["status","result"].includes(f.k)).slice(0,3)
    .map(f=>esc(f.l)+": "+esc(brief(label(f,item[f.k])))).join(" · ");
   return {c:[esc(id),summary||"—",esc(item.status||item.result||"—"),
    '<button class="link" type="button" data-admin-edit="'+esc(id)+'">修改内容</button> '+
    '<button class="link" type="button" data-admin-history="'+esc(id)+'">修订历史</button>']};
  }),{empty:"该项目没有此类记录"})+pager(data,{unit:"条记录"})+'</div>';
 root.querySelector("#admin-content-type").onchange=e=>{selectedType=e.target.value;pageNo=1;render(root,[pid]);};
 bindPager(root,n=>{pageNo=n;render(root,[pid]);});
 root.querySelectorAll("[data-admin-edit]").forEach(btn=>btn.onclick=()=>{
  const id=String(btn.dataset.adminEdit);
  const row=data.rows.find(r=>String(r[type.key==="project"?"id":
   (type.key==="demand_sheets"||type.key==="initiation_letters"?"pid":
    type.key==="verify_steps"?"step_no":"id")])===id);
  if(row)openEditor(root,pid,prefix,type,row,id);
 });
 root.querySelectorAll("[data-admin-history]").forEach(btn=>btn.onclick=showHistory(prefix,btn.dataset.adminHistory));
}
function editHtml(f,v){
 const name=esc(f.k),value=String(v??"");
 let control;
 if(f.t==="long")control='<textarea name="'+name+'" rows="5" maxlength="12000">'+esc(value)+'</textarea>';
 else if(f.t==="enum"||f.t==="bool"){
  const options=f.t==="bool"?[["0","否"],["1","是"]]:f.opts.map(x=>[x,x]);
  control='<select name="'+name+'">'+(f.required?"":'<option value="">（空）</option>')+
   options.map(([k,l])=>'<option value="'+esc(k)+'"'+(String(value)===String(k)?" selected":"")+'>'+esc(l)+'</option>').join("")+'</select>';
 }else{
  const type=f.t==="date"?"date":["int","money","rate"].includes(f.t)?"number":"text";
  const step=f.t==="int"?"1":f.t==="money"||f.t==="rate"?"0.01":null;
  control='<input name="'+name+'" type="'+type+'" value="'+esc(value)+'"'+
   (step?' step="'+step+'" min="0"':'')+' maxlength="'+(f.t==="text"?800:12000)+'">';
 }
 return '<div class="fld"><label>'+esc(f.l)+(f.required?'<span class="req">*</span>':'')+'</label>'+control+'</div>';
}
function openEditor(root,pid,prefix,type,row,id){
 const fields=type.fields;
 const m=modal({title:"总管理员修订 · "+type.label,width:"820px",
  body:'<div class="gate" style="margin-bottom:12px"><b>重要 · 管理员强制更正</b>可修改已归档或财务锁定记录，但不会修改原始合同扫描件、银行实际支付记录或历史签章文件。涉及金额、审批、核销状态的更正需人工核对关联业务。</div>'+
   '<div class="formgrid">'+fields.map(f=>editHtml(f,row[f.k])).join("")+'</div>'+
   '<div class="fld full" style="margin-top:16px"><label>修改原因 <span class="req">*</span></label>'+
   '<textarea name="admin_reason" rows="3" maxlength="500" placeholder="请填写详细更正原因（至少8字），供审计和历史恢复使用"></textarea></div>',
  footer:'<button class="btn btn-o" data-x="0">取消</button><button class="btn btn-p" data-x="1">确认更正并记录历史</button>'
 });
 m.querySelector('[data-x="0"]').onclick=()=>m.classList.remove("open");
 const save=m.querySelector('[data-x="1"]');
 save.onclick=async()=>{
  const changes={},expected={};
  for(const f of fields){
   const el=m.querySelector('[name="'+f.k+'"]');
   if(!el)continue;
   const raw=el.value.trim();
   let v=["money","rate","int","bool"].includes(f.t) ? (raw===""?null:Number(raw)) : (raw===""?null:raw);
   if(f.required && (v===null || (typeof v==="number"&&!Number.isFinite(v)))){
    toast("请填写必填字段："+f.l,"warn");return;
   }
   if(JSON.stringify(v)!==JSON.stringify(row[f.k])){
    changes[f.k]=v;expected[f.k]=row[f.k];
   }
  }
  if(!Object.keys(changes).length){toast("未修改任何字段","warn");return;}
  const reason=m.querySelector('[name="admin_reason"]').value.trim();
  if(reason.length<8||reason.length>500){toast("请填写8～500字的修订原因","warn");return;}
  if(!await confirmBox("确定修改「"+type.label+"」记录 "+id+"？此次修改立即生效，并永久记录操作人、旧值、新值和修订原因。",{ok:"确认修订",danger:true}))return;
  save.disabled=true;
  try{
   const done=await api.patch(prefix+"/"+urlPart(id),{changes,expected,reason});
   toast(done.message||"修订成功","ok");m.classList.remove("open");await render(root,[pid]);
  }catch(e){toast(e.message||"修订失败","warn");}
  finally{save.disabled=false;}
 };
}
function showHistory(prefix,id){
 return async()=>{
  try{
   const data=await api.get(prefix+"/"+urlPart(id)+"/history");
   const items=data.rows||[];
   const m=modal({title:"内容修订历史 · "+id,width:"800px",
    body:items.length?items.map(item=>
      '<div class="panel" style="margin:10px 0"><div class="panel-h"><b>'+
      esc(item.changed_by)+'</b><span class="hint">'+esc(item.changed_at)+'</span></div>'+
      '<p><b>原因：</b>'+esc(item.reason)+'</p>'+
      '<p><b>原值：</b><span style="white-space:pre-wrap;overflow-wrap:anywhere">'+esc(item.before_json)+'</span></p>'+
      '<p><b>新值：</b><span style="white-space:pre-wrap;overflow-wrap:anywhere">'+esc(item.after_json)+'</span></p></div>'
    ).join(""):'<p class="hint">该记录暂无总管理员内容修订历史。</p>',
    footer:'<button class="btn btn-o" data-x="0">关闭</button>'
   });
   m.querySelector('[data-x="0"]').onclick=()=>m.classList.remove("open");
  }catch(e){toast(e.message||"读取修订历史失败","warn");}
 };
}
