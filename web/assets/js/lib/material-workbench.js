import {api,can} from "./api.js";
import {esc,modal,toast} from "./ui.js";

let selected="";
/** 议程待办：上传原件后人工输入讲者|课题；系统自动拆分待办并进行文件名字符串比对。 */
export async function renderMaterialWorkbench(root,projects) {
  if(!projects.length){root.innerHTML='<div class="hint">暂无可管理的会议项目</div>';return;}
  if(!projects.some(p=>p.id===selected))selected=projects[0].id;
  const [d,all]=await Promise.all([
    api.get("/api/projects/"+encodeURIComponent(selected)+"/material-workbench"),
    api.get("/api/materials")
  ]);
  const available=(all.rows||[]).filter(m=>m.pid===selected);
  const canEdit=can("material:write");
  root.innerHTML=`<div class="panel mt"><div class="panel-h"><h2>终版议程 · 材料模块与待办</h2>
    <select id="wbProject">${projects.map(p=>`<option value="${esc(p.id)}" ${p.id===selected?"selected":""}>${esc(p.name)}</option>`).join("")}</select>
    </div><div class="hint" style="padding:10px">材料上传后，请从终版议程中人工整理讲者和课题；系统按每位讲者自动生成课件/串场待办。文件名比对不等于 OCR 或正文核验。</div>
    <div style="padding:8px 12px"><b>固定材料模块</b><div class="tacts">${d.modules.map(m=>
      `<button class="btn btn-o btn-sm" data-wb-toggle="${esc(m.kind)}" data-enabled="${m.enabled?1:0}" ${canEdit?"":"disabled"}>
      ${esc(m.kind)}：${m.enabled?"已启用":"已停用"}</button>`).join("")}</div>
    ${canEdit?'<button class="btn btn-p btn-sm" id="wbAgenda">+ 从终版议程生成待办</button>':""}</div>
    <div class="tw"><table><thead><tr><th>材料</th><th>讲者</th><th>课题</th><th>比对状态</th><th>原件/处理</th></tr></thead><tbody>
    ${d.tasks.length?d.tasks.map(t=>`<tr><td>${esc(t.kind)}</td><td>${esc(t.speaker)}</td><td>${esc(t.topic)}</td>
      <td>${esc(t.status)}</td><td>${t.material_name?esc(t.material_name):"—"}
        ${canEdit?`<div><select data-wb-file="${t.id}"><option value="">选择已上传材料</option>
          ${available.filter(m=>m.kind===t.kind&&m.file_key).map(m=>`<option value="${m.id}">${esc(m.name)}</option>`).join("")}
         </select><button class="link" data-wb-compare="${t.id}">比对</button>
         ${["不一致","待补件"].includes(t.status)?`<button class="link" data-wb-review="${t.id}">人工复核</button>`:""}</div>`:""}
      </td></tr>`).join(""):'<tr><td colspan="5">尚无待办：请先登记并上传“终版议程”</td></tr>'}</tbody></table></div>
    <div class="hint" style="padding:8px">待办状态：未提交 → 已提交 → 比对通过 / 不一致 → 待补件 → 复核通过；停用模块不删除历史记录。</div></div>`;
  root.querySelector("#wbProject").onchange=e=>{selected=e.target.value;renderMaterialWorkbench(root,projects).catch(err=>toast(err.message,"warn"));};
  root.querySelectorAll("[data-wb-toggle]").forEach(btn=>btn.onclick=async()=>{
    try{await api.post("/api/projects/"+selected+"/material-workbench/modules",{kind:btn.dataset.wbToggle,enabled:btn.dataset.enabled!=="1"});
      await renderMaterialWorkbench(root,projects);}catch(err){toast(err.message,"warn");}
  });
  root.querySelector("#wbAgenda")?.addEventListener("click",()=>{
    const agendas=available.filter(m=>["议程","终版议程"].includes(m.kind)&&m.file_key);
    const modalEl=modal({title:"录入终版议程讲者与课题",width:"620px",
      body:`<div class="hint">必须先上传终版议程原件（版本写“终版”）；目前需要人工从议程提取讲者和课题，不提供 OCR。</div>
      <div class="fld"><label>已上传终版议程</label><select name="agendaId">
      ${agendas.map(m=>`<option value="${m.id}">${esc(m.name)}（${esc(m.version||"")})</option>`).join("")}</select></div>
      <div class="fld"><label>每行一条：讲者|课题</label><textarea name="agendaRows" rows="8" placeholder="张老师|胃肠病诊疗新进展"></textarea></div>`,
      footer:'<button class="btn btn-o" data-close>取消</button><button class="btn btn-p" data-save>生成待办</button>'});
    modalEl.querySelector("[data-close]").onclick=()=>modalEl.classList.remove("open");
    modalEl.querySelector("[data-save]").onclick=async()=>{
      const materialId=Number(modalEl.querySelector('[name="agendaId"]').value);
      const entries=modalEl.querySelector('[name="agendaRows"]').value.split(/\n/).filter(Boolean).map(s=>{
        const [speaker,topic]=s.split("|");return {speaker:(speaker||"").trim(),topic:(topic||"").trim()};});
      try{const r=await api.post("/api/projects/"+selected+"/material-workbench/agenda",{materialId,entries});
        toast("已生成 "+r.generated+" 项结构化待办","ok");modalEl.classList.remove("open");await renderMaterialWorkbench(root,projects);}
      catch(err){toast(err.message,"warn");}
    };
  });
  root.querySelectorAll("[data-wb-compare]").forEach(btn=>btn.onclick=async()=>{
    const id=btn.dataset.wbCompare;
    const materialId=Number(root.querySelector('[data-wb-file="'+id+'"]').value);
    try{const r=await api.post("/api/projects/"+selected+"/material-workbench/tasks/"+id+"/compare",{materialId});
      toast(r.status==="比对通过"?"题目/讲者字符串比对通过":"不一致，转人工复核",r.status==="比对通过"?"ok":"warn");
      await renderMaterialWorkbench(root,projects);}catch(err){toast(err.message,"warn");}
  });
  root.querySelectorAll("[data-wb-review]").forEach(btn=>btn.onclick=()=>{
    const id=btn.dataset.wbReview;
    const m=modal({title:"材料人工复核",body:'<div class="fld"><label>复核说明</label><textarea name="reason" rows="4" placeholder="写明不一致原因及证据"></textarea></div>',
      footer:'<button class="btn btn-o" data-no>要求补件</button><button class="btn btn-p" data-yes>复核通过</button>'});
    for(const [selector,approved] of [["[data-no]",false],["[data-yes]",true]])m.querySelector(selector).onclick=async()=>{
      try{await api.post("/api/projects/"+selected+"/material-workbench/tasks/"+id+"/review",{approved,reason:m.querySelector('[name="reason"]').value});
        m.classList.remove("open");await renderMaterialWorkbench(root,projects);}catch(e){toast(e.message,"warn");}
    };
  });
}
