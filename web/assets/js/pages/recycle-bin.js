import {api,state} from "../lib/api.js";
import {bindPager,bindSearchRefresh,confirmBox,esc,pager,table,toast} from "../lib/ui.js";
import {fileUrl} from "../lib/upload.js";

/** 废件箱：只为总管理员提供检索与原路恢复，不支持绕开正式流程的永久销毁。 */
const SIZE=30;
let filter={page:1,q:""};
let seq=0;
export async function render(root){
  if(!state.super){
    root.innerHTML='<div class="panel" style="padding:28px">仅总管理员可以查看废件箱。</div>';
    return;
  }
  const request=++seq;
  const qs=new URLSearchParams({page:String(filter.page),size:String(SIZE)});
  if(filter.q)qs.set("q",filter.q);
  const data=await api.get("/api/recycle-bin/materials?"+qs);
  if(request!==seq||!root.isConnected)return;
  root.innerHTML=`<div class="phead">
    <div><h2>废件箱</h2>
      <p>仅总管理员可查看和恢复已删除材料。恢复后返回原会议、原类别及原始文件，不改变原上传时间。</p></div>
  </div>
  <div class="grid g4">
    <div class="kpi"><div class="t">废件箱材料</div><div class="v">${data.total}<span class="u">条</span></div></div>
    <div class="kpi k2" style="grid-column:span 3">
      <div class="t">管理说明</div>
      <p style="margin:8px 0;font-size:13px;line-height:1.7">
        原始文件和删除记录保留；已结算、已归档项目及涉及财务锁定的合同不能直接恢复。
        合同更正所保留的旧版本属于签署历史，应在「合同详情 → 版本历史」查看，不属于废件箱。
      </p>
    </div>
  </div>
  <div class="panel mt">
    <div class="panel-h"><h2>已删除材料列表</h2><span class="hint">共 ${data.total} 条 · 仅总管理员</span></div>
    <div class="filters">
      <input id="recycle-q" type="search" value="${esc(filter.q)}"
        placeholder="搜索会议、材料名称、类别、附件文件名或会议编号">
      <div class="sp"></div>
      <button class="btn btn-o btn-sm" id="recycle-refresh">刷新</button>
    </div>
    ${table([
      {t:"原会议",w:"165px"},{t:"材料类别",w:"90px"},{t:"材料名称"},
      {t:"原附件",w:"150px"},{t:"原上传",w:"125px"},
      {t:"删除时间",w:"125px"},{t:"删除人",w:"82px"},{t:"操作",w:"105px"}
    ],data.rows.map(m=>({
      attrs:` data-recycle-id="${Number(m.id)}"`,
      c:[
        `<a class="link" data-go="projects/${esc(m.pid)}">${esc(m.pname||m.pid)}</a>
        <div class="hint mono">${esc(m.pid)}</div>`,
        esc(m.kind),
        `${esc(m.name)}${m.version?`<div class="hint">版本：${esc(m.version)}</div>`:""}`,
        m.file_key
          ?`<a class="link" href="${esc(fileUrl(m.file_key))}" target="_blank" rel="noopener"
            title="仅管理员可下载原始文件">${esc(m.file_name||"查看原附件")}</a>`
          :'<span class="hint">无附件，仅登记资料</span>',
        `<span class="mono">${esc(m.created_at||"")}</span>
          <div class="hint">${esc(m.uploader||"")}</div>`,
        `<span class="mono">${esc(m.deleted_at)}</span>`,
        esc(m.deleted_by||"历史记录"),
        ["已结算","已归档"].includes(m.pstatus)
          ?'<span class="hint" title="项目财务/档案已冻结，禁止直接恢复">已冻结</span>'
          :`<button class="link" data-restore="${Number(m.id)}">原路恢复</button>`
      ]
    })),{empty:"废件箱为空，没有已删除材料"}),
    pager(data,{unit:"条"})}
  </div>`;
  bindPager(root,n=>{filter.page=n;render(root);});
  bindSearchRefresh(root,"#recycle-q",q=>{filter.q=q;filter.page=1;},()=>render(root),350);
  root.querySelector("#recycle-refresh").onclick=()=>render(root);
  root.querySelectorAll("[data-restore]").forEach(btn=>btn.onclick=async()=>{
    const item=data.rows.find(m=>Number(m.id)===Number(btn.dataset.restore));
    if(!item)return;
    const ok=await confirmBox(
      "确认将「"+item.name+"」恢复到会议「"+item.pname+"」的「"+item.kind+"」类别？"+
      "原始附件、记录和上传时间保持不变。如关联已删除的未签署合同，将恢复为草稿并须重新审批。",
      {ok:"确认原路恢复",danger:false}
    );
    if(!ok)return;
    btn.disabled=true;
    try{
      const response=await api.post("/api/recycle-bin/materials/"+item.id+"/restore",{});
      toast(response.message,"ok");
      await render(root);
    }catch(error){
      toast(error.message,"warn");
      btn.disabled=false;
    }
  });
}
