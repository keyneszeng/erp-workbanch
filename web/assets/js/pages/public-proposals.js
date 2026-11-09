import {api,state} from "../lib/api.js";
import {esc,table} from "../lib/ui.js";

/** Dedicated superadmin inbox: no approve/reject actions, no project creation. */
export async function render(root){
 if(!state.super){root.innerHTML='<div class="panel">仅总管理员可查看公众活动申请。</div>';return;}
 let page=1;
 const draw=async()=>{
  const d=await api.get("/api/admin/public-event-proposals?page="+page+"&size=30");
  root.innerHTML='<div class="ux-section-intro"><div><h2>公众活动申请收件箱</h2>'+
   '<p>独立于内部会议立项和审批中心。公众提交后直接接收归档，仅供总管理员查看与联系。</p></div></div>'+
   '<div class="panel" style="padding:20px"><div class="row" style="justify-content:space-between">'+
   '<b>已接收申请 '+Number(d.total||0)+' 份</b><span class="hint">第 '+page+' 页</span></div>'+
   (d.rows?.length?table([
      {t:"接收时间"},{t:"主题／日期／形式"},{t:"预算"},{t:"联系人"},{t:"议程及补充信息"}
    ],d.rows.map(x=>({c:[
     esc(x.received_at||""),
     '<b>'+esc(x.topic)+'</b><div class="hint">'+esc(x.event_date)+' '+esc(x.event_time)+' · '+esc(x.form)+'</div><div class="hint">'+esc(x.id)+'</div>',
     '¥'+Number(x.budget||0).toLocaleString("zh-CN",{minimumFractionDigits:2,maximumFractionDigits:2}),
     esc(x.contact_name)+'<div class="hint">'+esc(x.contact_phone)+'</div><div class="hint">'+esc(x.contact_info||"")+'</div>',
     '<div style="max-width:400px;white-space:pre-wrap;overflow-wrap:anywhere">'+esc(x.agenda)+'</div>'
    ]})),{empty:"暂无公众活动申请"}):'<div class="empty">暂无公众活动申请</div>')+
   '<div style="display:flex;gap:10px;justify-content:flex-end;margin-top:16px">'+
    '<button class="btn btn-o btn-sm" data-prev '+(page===1?'disabled':'')+'>上一页</button>'+
    '<button class="btn btn-o btn-sm" data-next '+(page*30>=Number(d.total||0)?'disabled':'')+'>下一页</button></div></div>';
  root.querySelector("[data-prev]").onclick=()=>{if(page>1){page--;draw();}};
  root.querySelector("[data-next]").onclick=()=>{if(page*30<Number(d.total||0)){page++;draw();}};
 };
 await draw();
}
