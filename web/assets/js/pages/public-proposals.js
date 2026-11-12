import {api,state} from "../lib/api.js";
import {esc,table,promptBox,toast,modal,closeModal} from "../lib/ui.js";

async function convertToInternalDraft(entry){
 const associations=(await api.get("/api/associations")).rows||[];
 const options=associations.map(x=>typeof x==="string"?x:x.name).filter(Boolean);
 if(!options.length){toast("请先在系统配置中建立有效协会","warn");return;}
 const box=modal({
  title:"转为内部立项 · 保存草稿",width:"620px",
  body:'<div class="hint" style="margin-bottom:12px">将公众申请中的主题、日期、开始时间、形式、预算、完整议程、联系人和联系方式关联到新会议项目。草稿负责人先设为总管理员本人，不进入审批流程。</div>'+
       '<div class="fld"><label>所属协会<span class="req">*</span></label>'+
       '<select name="assoc"><option value="">请选择所属协会</option>'+
       options.map(a=>'<option value="'+esc(a)+'">'+esc(a)+'</option>').join("")+'</select></div>'+
       '<div class="hint">公众申请编号：'+esc(entry.id)+'<br>主题：'+esc(entry.topic)+
       '<br>日期：'+esc(entry.event_date)+' '+esc(entry.event_time)+
       '<br>预算：¥'+Number(entry.budget||0).toLocaleString("zh-CN")+'</div>',
  footer:'<button class="btn btn-o" data-cancel>取消</button><button class="btn btn-p" data-convert>确认转换并保存草稿</button>'
 });
 box.querySelector("[data-cancel]").onclick=closeModal;
 const submit=box.querySelector("[data-convert]");
 submit.onclick=async()=>{
  const assoc=box.querySelector('[name="assoc"]').value;
  if(!assoc){toast("请先选择所属协会","warn");return;}
  submit.disabled=true;
  try{
   const result=await api.post("/api/admin/public-event-proposals/"+encodeURIComponent(entry.id)+"/convert",{assoc});
   closeModal();
   toast("已创建内部立项草稿 "+result.project.id,"ok");
   location.hash="#/projects/"+result.project.id;
  }catch(e){submit.disabled=false;toast(e.message||"转换失败","warn");}
 };
}

/** Dedicated superadmin inbox. Open proposals become admin workbench todos. */
export async function render(root){
 if(!state.super){root.innerHTML='<div class="panel">仅总管理员可查看公众活动申请。</div>';return;}
 let page=1;
 const draw=async()=>{
  const d=await api.get("/api/admin/public-event-proposals?page="+page+"&size=30");
  root.innerHTML='<div class="ux-section-intro"><div><h2>公众活动申请收件箱</h2>'+
   '<p>新申请自动进入总管理员「我的工作台 · 我的待办」。处理完成后归档并从待办中移除。</p></div></div>'+
   '<div class="panel" style="padding:20px"><div class="row" style="justify-content:space-between">'+
   '<b>全部申请 '+Number(d.total||0)+' 份</b><span class="hint">第 '+page+' 页</span></div>'+
   (d.rows?.length?table([
      {t:"接收时间"},{t:"主题／日期／形式"},{t:"预算"},{t:"联系人"},{t:"议程及补充信息"},{t:"状态"},{t:"操作",w:"215px"}
    ],d.rows.map(x=>({c:[
     esc(x.received_at||""),
     '<b>'+esc(x.topic)+'</b><div class="hint">'+esc(x.event_date)+' '+esc(x.event_time)+' · '+esc(x.form)+'</div><div class="hint">'+esc(x.id)+'</div>',
     '¥'+Number(x.budget||0).toLocaleString("zh-CN",{minimumFractionDigits:2,maximumFractionDigits:2}),
     esc(x.contact_name)+'<div class="hint">'+esc(x.contact_phone)+'</div><div class="hint">'+esc(x.contact_info||"")+'</div>',
     '<div style="max-width:400px;white-space:pre-wrap;overflow-wrap:anywhere">'+esc(x.agenda)+'</div>'+
      (x.handling_note?'<div class="hint">处理备注：'+esc(x.handling_note)+'</div>':''),
     x.status==="已归档"?'<span class="tag">已处理</span>':'<span class="tag tag-warn">待处理</span>',
     x.project_id?'<button class="btn btn-o btn-sm" data-go="projects/'+esc(x.project_id)+'">查看内部项目</button>':
       '<div style="display:flex;gap:6px;flex-wrap:wrap">'+
       '<button class="btn btn-p btn-sm" data-convert="'+esc(x.id)+'">转为内部立项</button>'+
       (x.status==="已归档"?'':'<button class="btn btn-o btn-sm" data-process="'+esc(x.id)+'">处理</button>')+
       '</div>'
    ]})),{empty:"暂无公众活动申请"}):'<div class="empty">暂无公众活动申请</div>')+
   '<div style="display:flex;gap:10px;justify-content:flex-end;margin-top:16px">'+
    '<button class="btn btn-o btn-sm" data-prev '+(page===1?'disabled':'')+'>上一页</button>'+
    '<button class="btn btn-o btn-sm" data-next '+(page*30>=Number(d.total||0)?'disabled':'')+'>下一页</button></div></div>';
  root.querySelector("[data-prev]").onclick=()=>{if(page>1){page--;draw();}};
  root.querySelector("[data-next]").onclick=()=>{if(page*30<Number(d.total||0)){page++;draw();}};
  root.querySelectorAll("[data-convert]").forEach(btn=>btn.onclick=async()=>{
   const item=d.rows.find(x=>x.id===btn.dataset.convert);
   if(!item)return;
   btn.disabled=true;
   try{await convertToInternalDraft(item);}
   catch(e){toast(e.message||"加载转换表单失败","warn");}
   finally{btn.disabled=false;}
  });
  root.querySelectorAll("[data-process]").forEach(btn=>btn.onclick=async()=>{
   const id=btn.dataset.process;
   const note=await promptBox({title:"处理公众活动申请",label:"处理记录／联系结果（选填）",ph:"例如：已电话联系，等待补充材料",required:false,ok:"确认处理并归档"});
   if(note===null)return;
   try{await api.post("/api/admin/public-event-proposals/"+encodeURIComponent(id)+"/process",{note});toast("申请已处理并归档");await draw();}
   catch(e){toast(e.message||"处理失败","error");}
  });
 };
 await draw();
}
