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
      <div class="fld"><label>识别结果（可直接修改；空白格请对照原件补全）</label>
        <div class="tw" style="max-height:300px;overflow:auto">
          <table><thead><tr>
            <th style="width:104px">时间</th><th>课题</th><th style="width:92px">讲者</th><th style="width:150px">单位</th><th style="width:34px"></th>
          </tr></thead><tbody data-agenda-rows></tbody></table>
        </div>
        <div style="margin-top:8px">
          <button class="btn btn-o btn-sm" type="button" data-add-row>＋ 添加一行</button>
          <span class="hint" data-row-stat style="margin-left:8px"></span>
        </div>
      </div>
      <label><input type="checkbox" name="confirmed"> 已对照终版议程原件确认讲者、课题和记录无误</label>`,
      footer:'<button class="btn btn-o" data-close>取消</button><button class="btn btn-p" data-save>确认并生成待办</button>'});
    const tbody=modalEl.querySelector("[data-agenda-rows]");
    const stat=modalEl.querySelector("[data-row-stat]");
    const rowHtml=(r={})=>`<tr>
      <td><input name="time" value="${esc(r.time||"")}" placeholder="19:00-19:30" style="width:100%"></td>
      <td><input name="topic" value="${esc(r.topic||"")}" placeholder="课题" style="width:100%"></td>
      <td><input name="speaker" value="${esc(r.speaker||"")}" placeholder="讲者" style="width:100%"></td>
      <td><input name="org" value="${esc(r.org||"")}" placeholder="单位" style="width:100%"></td>
      <td><button type="button" class="link" data-del-row title="删除此行">×</button></td></tr>`;
    const refreshStat=()=>{
      const rows=[...tbody.querySelectorAll("tr")].map(tr=>({
        speaker:tr.querySelector('[name="speaker"]').value.trim(),
        topic:tr.querySelector('[name="topic"]').value.trim()
      }));
      const ready=rows.filter(r=>r.speaker&&r.topic).length;
      if(stat)stat.textContent=rows.length?`共 ${rows.length} 行，其中 ${ready} 行讲者与课题都已填，可生成待办`:"";
    };
    const fillRows=(list)=>{
      tbody.innerHTML=list.map(rowHtml).join("");
      refreshStat();
    };
    tbody.addEventListener("input",refreshStat);
    tbody.addEventListener("click",(e)=>{
      if(!e.target.closest("[data-del-row]"))return;
      e.target.closest("tr").remove();
      refreshStat();
    });
    modalEl.querySelector("[data-add-row]").onclick=()=>{
      tbody.insertAdjacentHTML("beforeend",rowHtml());
      refreshStat();
    };
    if(agendas.length)fillRows([{}]);

    modalEl.querySelector("[data-ocr-run]")?.addEventListener("click",async(e)=>{
      const btn=e.currentTarget;
      const materialId=Number(modalEl.querySelector('[name="agendaId"]').value);
      if(!materialId){toast("请先上传终版议程并选择原件","warn");return;}
      btn.disabled=true;btn.textContent="识别中，请勿重复提交…";
      try{
        const {result}=await api.post("/api/projects/"+selected+"/material-workbench/ocr",{materialId});
        if(!result)throw new Error("OCR 没有返回识别结果");
        // 优先用「按时间行还原」的结构化结果；没有就退回逐行候选
        const rows=(result.rows&&result.rows.length?result.rows:result.suggestions)||[];
        fillRows(rows.length?rows:[{}]);
        const ready=rows.filter(r=>r.speaker&&r.topic).length;
        const preview=modalEl.querySelector("[data-ocr-preview]");
        preview.innerHTML=`<p>已识别 ${result.pages}/${result.totalPages} 页 · ${esc(result.engine)} · 还原 ${rows.length} 个场次，其中 ${ready} 行讲者与课题都齐全${result.truncated?"（仅处理前 3 页，请核对剩余页）":""}。</p>
          <details><summary>查看 OCR 原文（请与原件核对）</summary><pre style="white-space:pre-wrap;max-height:220px;overflow:auto">${esc(result.recognizedText)}</pre></details>`;
        if(!rows.length)toast("识别出了文字但没有可还原的场次，请查看原文后手动添加","warn");
        else if(!ready)toast("已按时间行排出场次，但讲者/课题多为空白，请对照原件补全","warn");
        else toast("已填入草稿表格，请逐行核对后生成待办","ok");
      }catch(err){toast(err.message,"warn");}
      finally{btn.disabled=false;btn.textContent="OCR 自动识别并填入草稿";}
    });
    modalEl.querySelector("[data-close]").onclick=()=>modalEl.classList.remove("open");
    modalEl.querySelector("[data-save]").onclick=async()=>{
      const materialId=Number(modalEl.querySelector('[name="agendaId"]').value);
      const entries=[...tbody.querySelectorAll("tr")].map(tr=>({
        speaker:tr.querySelector('[name="speaker"]').value.trim(),
        topic:tr.querySelector('[name="topic"]').value.trim()
      })).filter(x=>x.speaker&&x.topic);
      if(!entries.length){toast("至少需要一行同时填好讲者与课题","warn");return;}
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
