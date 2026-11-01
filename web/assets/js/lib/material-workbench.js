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
    </div><div class="hint" style="padding:10px">先上传终版议程原件。阿里云 ECS 可用离线中文/英文 OCR 自动提取 JPG/PNG/PDF 的文字并生成讲者课题建议；必须人工核对后才能转成课件待办，不能以 OCR 代替原件审核。</div>
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
    const modalEl=modal({title:"识别终版议程 · 讲者与课题确认",width:"680px",
      body:`<div class="hint">先上传带原件附件的“终版议程”；OCR 自动识别仅提供草稿建议，提交待办前须人工逐行审核。</div>
      <div class="fld"><label>终版议程原件</label><select name="agendaId">
      ${agendas.map(m=>`<option value="${m.id}">${esc(m.name)}（${esc(m.version||"")}）</option>`).join("")}</select></div>
      ${d.ocrAvailable?'<button class="btn btn-o btn-sm" type="button" data-ocr-run>OCR 自动识别并填入草稿</button>':'<div class="hint">当前演示环境或服务器未配置 OCR，可以手动整理后生成待办。</div>'}
      <div data-ocr-preview class="hint"></div>
      <div class="fld"><label>人工核对后的讲者与课题（每行：讲者|课题）</label>
        <textarea name="agendaRows" rows="8" placeholder="张老师|胃肠病诊疗新进展"></textarea></div>
      <label><input type="checkbox" name="confirmed"> 已对照终版议程原件确认讲者、课题和记录无误</label>`,
      footer:'<button class="btn btn-o" data-close>取消</button><button class="btn btn-p" data-save>确认并生成待办</button>'});
    modalEl.querySelector("[data-ocr-run]")?.addEventListener("click",async(e)=>{
      const btn=e.currentTarget;
      const materialId=Number(modalEl.querySelector('[name="agendaId"]').value);
      if(!materialId){toast("请先上传终版议程并选择原件","warn");return;}
      btn.disabled=true;btn.textContent="识别中，请勿重复提交…";
      try{
        const {result}=await api.post("/api/projects/"+selected+"/material-workbench/ocr",{materialId});
        if(!result)throw new Error("OCR 没有返回识别结果");
        const t=modalEl.querySelector('[name="agendaRows"]');
        t.value=result.suggestions.map(x=>x.speaker+"|"+x.topic).join("\n");
        const preview=modalEl.querySelector("[data-ocr-preview]");
        preview.innerHTML=`<p>已识别 ${result.pages}/${result.totalPages} 页 · ${esc(result.engine)} · 提取候选 ${result.suggestions.length} 条${result.truncated?"（仅处理前 3 页，请核对剩余页）":""}。</p>
          <details><summary>查看 OCR 原文（请与原件核对）</summary><pre style="white-space:pre-wrap;max-height:220px;overflow:auto">${esc(result.recognizedText)}</pre></details>`;
        if(!result.suggestions.length)toast("识别出了文字但未能可靠提取讲者/课题，请查看原文后手动整理","warn");
        else toast("已填入待确认草稿，请人工核对后生成待办","ok");
      }catch(err){toast(err.message,"warn");}
      finally{btn.disabled=false;btn.textContent="OCR 自动识别并填入草稿";}
    });
    modalEl.querySelector("[data-close]").onclick=()=>modalEl.classList.remove("open");
    modalEl.querySelector("[data-save]").onclick=async()=>{
      const materialId=Number(modalEl.querySelector('[name="agendaId"]').value);
      const entries=modalEl.querySelector('[name="agendaRows"]').value.split(/\n/).filter(Boolean).map(s=>{
        const [speaker,topic]=s.split("|");return {speaker:(speaker||"").trim(),topic:(topic||"").trim()};});
      if(!modalEl.querySelector('[name="confirmed"]').checked){toast("请先核对终版议程并勾选人工确认","warn");return;}
      try{const r=await api.post("/api/projects/"+selected+"/material-workbench/agenda",{materialId,entries});
        toast("已生成 "+r.generated+" 项结构化待办","ok");modalEl.classList.remove("open");await renderMaterialWorkbench(root,projects);}
      catch(err){toast(err.message,"warn");}
    };
  });
  root.querySelectorAll("[data-wb-compare]").forEach(btn=>btn.onclick=async()=>{
    const id=btn.dataset.wbCompare;
    const materialId=Number(root.querySelector('[data-wb-file="'+id+'"]').value);
    try{
      const material=available.find(x=>Number(x.id)===materialId);
      const ext=String(material?.file_key||"").split(".").pop();
      if(d.ocrAvailable && ["png","jpg","pdf"].includes(ext)) {
        toast("正在识别原件正文并匹配讲者和课题…","ok");
        await api.post("/api/projects/"+selected+"/material-workbench/ocr",{materialId});
      }
      const r=await api.post("/api/projects/"+selected+"/material-workbench/tasks/"+id+"/compare",{materialId});
      toast(r.status==="比对通过"?"OCR 原文包含对应讲者和课题，请再人工核验原件":
        "未匹配到讲者和课题，转人工复核",r.status==="比对通过"?"ok":"warn");
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
