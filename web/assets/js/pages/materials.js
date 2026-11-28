import { api, can } from "../lib/api.js";
import {canDownloadArchivePdf,bindArchivePdfButtons} from "../lib/archive-pdf.js";
import { bindPager, esc, formHtml, modal, pager, panel, readForm, table, toast, validate } from "../lib/ui.js";
import { checkFile, fileUrl, formatBytes, UPLOAD_ACCEPT, UPLOAD_TIP } from "../lib/upload.js";
import { openContractMaterialReplace } from "../lib/contract-material-replace.js";

const PAGE_SIZE = 50;
const RETIRED_KINDS=new Set(["合同","会务协议","劳务协议","企业赞助合同","赞助合同","劳务专家合同","专家劳务协议","劳务合同","会务合同"]);
// 与项目详情页/小程序/后端一致：结算或归档后冻结；权限依然单独校验。
const canUploadAtStatus=status=>!["已结算","已归档"].includes(status);
let curPage = 1;
let lastProject = "";
let projectSearch = "";
let renderSeq = 0;

/** 材料中心：一级按项目名列目录，二级只展示该项目的材料与上传操作。 */
export async function render(root, params = []) {
  const pid = String(params[0] || "");
  if (pid !== lastProject) { curPage = 1; lastProject = pid; }
  const seq = ++renderSeq;
  const qs = new URLSearchParams({ page: String(curPage), size: String(pid ? PAGE_SIZE : 1) });
  if (pid) qs.set("pid", pid);
  const d = await api.get("/api/materials?" + qs);
  if (seq !== renderSeq || !root.isConnected) return;
  const project = pid ? d.projects.find(p => p.id === pid) : null;
  const canWrite = can("material:write");
  if (pid && !project) {
    root.innerHTML = '<div class="panel">该项目不存在或不在当前账号的材料查看范围内。<button type="button" class="btn btn-o" data-go="materials">返回项目目录</button></div>';
    return;
  }

  if (!pid) {
    const uploaded = d.projects.filter(p => p.uploadedCount > 0).length;
    root.innerHTML = '<div class="phead"><div><h2>材料收集</h2><p>按项目名称建立目录，点击项目查看材料详情、上传记录与附件</p></div>' +
      '</div>' +
      '<div class="grid g2">' +
        '<div class="kpi"><div class="t">项目目录</div><div class="v">' + d.projects.length + '<span class="u">个</span></div></div>' +
        '<div class="kpi k2"><div class="t">已收集材料项目</div><div class="v">' + uploaded + '<span class="u">个</span></div></div>' +
      '</div>' +
      '<div class="panel mt"><div class="panel-h"><h2>项目材料目录</h2><span class="hint" id="materialFolderCount">' + d.projects.length + ' 个项目</span></div>' +
        '<div class="filters"><input type="search" id="materialFolderSearch" aria-label="搜索项目材料目录" placeholder="搜索项目名称 / 会议编号 / 状态" value="' + esc(projectSearch) + '"></div>' +
        '<div class="material-folder-grid" id="materialFolderGrid">' +
          d.projects.map(p => '<button type="button" class="material-folder" data-material-project="' + esc(p.id) + '" aria-label="查看' + esc(p.name) + '的材料详情">' +
            '<span class="material-folder-icon" aria-hidden="true">📁</span>' +
            '<span class="material-folder-body"><strong class="material-folder-name">' + esc(p.name) + '</strong>' +
              '<span class="material-folder-id">' + esc(p.id) + '</span>' +
              '<span class="material-folder-meta">' + esc(p.status) + ' · ' + (p.count || 0) + ' 份材料 · ' + (p.have?.length || 0) + ' 类</span></span>' +
            '<span class="material-folder-open" aria-hidden="true">›</span></button>').join("") +
        '</div><p class="hint" id="materialFolderEmpty" hidden>没有符合条件的项目</p></div>';

    root.querySelectorAll("[data-material-project]").forEach(btn => {
      btn.onclick = () => {
        curPage = 1;
        location.hash = "#/materials/" + encodeURIComponent(btn.dataset.materialProject);
      };
    });
    const input = root.querySelector("#materialFolderSearch");
    const filter = () => {
      projectSearch = input.value;
      const term = projectSearch.trim().toLowerCase();
      let count = 0;
      root.querySelectorAll("[data-material-project]").forEach(btn => {
        const found = !term || btn.textContent.toLowerCase().includes(term);
        btn.style.display = found ? "" : "none";
        if (found) count++;
      });
      root.querySelector("#materialFolderCount").textContent = count + " 个项目";
      root.querySelector("#materialFolderEmpty").hidden = count !== 0;
    };
    input.addEventListener("input", filter);
    filter();
    return;
  }

  const refresh = () => render(root, [pid]);
  const writable = canWrite && canUploadAtStatus(project.status);
  const kinds=project.categoryCatalog?.all||[...new Set([...(d.kinds||[]),...(project.have||[])])]
    .filter(kind=>kind&&!RETIRED_KINDS.has(kind));
  const disabledKinds=new Set(project.categoryCatalog?.disabled||[]);
  root.innerHTML = '<div class="phead"><div><button type="button" class="btn btn-o btn-sm" data-go="materials">← 返回项目目录</button>' +
      '<h2 style="margin-top:12px">' + esc(project.name) + '</h2>' +
      '<p>材料收集 / ' + esc(project.id) + ' · ' + esc(project.status) + '</p></div>' +
      '<div class="acts">' +
        (canDownloadArchivePdf({status: project.status, assoc: project.assoc}) ? ' <button type="button" class="btn btn-o" data-archive-pdf="' + esc(pid) + '">材料下载</button>' : "") +
      '</div></div>' +
    '<div class="grid g3">' +
      '<div class="kpi"><div class="t">已登记材料</div><div class="v">' + project.count + '<span class="u">份</span></div></div>' +
      '<div class="kpi k2"><div class="t">已上传原件</div><div class="v">' + project.uploadedCount + '<span class="u">份</span></div></div>' +
      '<div class="kpi k4"><div class="t">材料类别</div><div class="v">' + (project.have?.length || 0) + '<span class="u">类</span></div></div>' +
    '</div>' +
    '<div class="panel mt"><div class="panel-h"><h2>材料收集类别</h2><span class="hint">' +
      (writable ? "点击类别可直接上传，自动归入当前项目" : "该项目仅可查看已录入材料") +
    '</span></div><div class="material-kind-panel">' +
      '<p class="hint">点击下方材料类别即可上传文件，自动归入当前会议。企业赞助合同、会务协议和劳务协议均须在合同模块统一上传；旧资料仍在下方列表中保留。</p>' +
      '<div class="material-kind-chips">' +
      kinds.map(kind =>
        '<button type="button" class="material-kind-chip" data-guide-kind="' + esc(kind) + '"' + (writable&&!disabledKinds.has(kind) ? "" : " disabled") + '>' +
          esc(kind) + (disabledKinds.has(kind)?' <span class="hint">已停用</span>':project.have?.includes(kind) ? ' <span class="hint">已收集</span>' : "") + '</button>'
      ).join("") + '</div></div></div>' +
    '<div class="panel mt"><div class="panel-h"><h2>已收集材料详情</h2><span class="hint">共 ' + d.total + ' 条 · 仅本项目</span></div>' +
      table([{t:"类别",w:"110px"},{t:"材料名称"},{t:"附件",w:"120px"},
        {t:"版本",w:"64px"},{t:"上传人",w:"85px"},{t:"上传时间",w:"138px"},{t:"操作",w:"85px"}],
        d.rows.map(m => ({c:[
          esc(m.kind === "劳务收集表" ? "劳务表" : m.kind) +
            (m.kind === "权益照片" ? '<div class="hint">' + esc(m.sponsor_enterprise || "未关联赞助合同") + ' · ' + esc(m.sponsor_right_category || "未关联权益类目") + '</div>' : ""),
          esc(m.name),
          m.file_key
            ? (m.file_mime === "application/pdf" || /\.(doc|docx|ppt|pptx|xls|xlsx|csv|txt)$/i.test(m.file_key)
                ? '<a class="link" href="' + fileUrl(m.file_key) + '" target="_blank" rel="noopener">' + esc(m.file_name || "下载附件") + '</a>'
                : '<a href="' + fileUrl(m.file_key) + '" target="_blank" rel="noopener"><img class="thumb" src="' + fileUrl(m.file_key) + '" alt="查看材料图片"></a>')
            : '<span class="hint">—</span>',
          esc(m.version || ""), esc(m.uploader || ""), '<span class="mono">' + esc(m.created_at) + '</span>',
          (can("material:file:replace") && m.file_key && !["已核销", "已结算", "已归档"].includes(project.status)
            ? '<button type="button" class="link" data-replace-material="' + Number(m.id) + '">修改</button>' : "") || "—"
        ]})), {empty:"该项目尚未收集材料"}) +
      pager(d, {unit:"份材料"}) + '</div>';

  bindPager(root, n => { curPage = n; refresh(); });
  bindArchivePdfButtons(root);
  root.querySelectorAll("[data-guide-kind]").forEach(btn => {
    btn.onclick = () => openMaterialRegistration(root, [project], d.kinds, pid, refresh, btn.dataset.guideKind);
  });
  root.querySelectorAll("[data-replace-material]").forEach(btn => {
    btn.onclick = () => {
      const item = d.rows.find(x => Number(x.id) === Number(btn.dataset.replaceMaterial));
      if (item) openContractMaterialReplace(item, refresh);
    };
  });
}

/**
 * 两处入口（会议项目→材料收集、材料目录）共享同一登记表单。
 * 材料名称严格使用用户所选择文件的原始名称；附件不做有损压缩。
 * 最多 10 份/批、并发 3 份，逐份显示结果，失败文件可单独重试。
 */
export const MAX_MATERIAL_FILES_PER_BATCH=10;

export function openMaterialRegistration(root, projects, kinds, defaultPid="", onSaved=null, defaultKind="") {
  if(defaultKind&&RETIRED_KINDS.has(defaultKind)){
    toast("企业赞助合同、会务协议和劳务协议请在合同模块录入，不能从材料收集新增","warn");return;
  }
  if(!projects.length){
    toast("当前没有可登记材料的项目（已结算、已归档项目不允许新增材料）","warn");
    return;
  }
  const allowedKinds=(kinds||[]).filter(kind=>!RETIRED_KINDS.has(kind));
  const fields=[
    {k:"pid",l:"所属项目",t:"select",req:1,v:defaultPid,
      opts:projects.map(p=>({v:p.id,l:p.id+" "+p.name}))},
    {k:"kind",l:"材料类别",t:"select",req:1,custom:1,v:defaultKind,
      ph:"如：盖章会议通知 / 招商函 / 终版议程 / 讲者照片",
      opts:[...allowedKinds,"会议通知","招商函","终版议程","课件","串场","劳务表","讲者照片","权益照片",defaultKind]
        .filter((v,i,a)=>v&&a.indexOf(v)===i),
      tip:"可任选或自定义类别。多份文件将分别登记到当前项目与材料类别。"},
    {k:"sponsor_right_id",l:"权益照片 · 二级类目（从赞助合同自动生成，可自定义）",
      t:"select",opts:[],tip:"先选择项目及赞助合同权益，再上传对应照片。"},
    {k:"file",l:"选择材料文件",t:"file",full:1,accept:UPLOAD_ACCEPT,
      tip:`一次最多选择 ${MAX_MATERIAL_FILES_PER_BATCH} 份，每份不超过 50 MB；支持并发上传。材料名称自动采用对应文件名，无需手动输入。`}
  ];
  const m=modal({
    title:"上传资料"+(defaultKind?" · "+defaultKind:""),width:"660px",
    body:formHtml(fields)+
      '<div data-material-file-list aria-live="polite" class="fld full" style="grid-column:1/-1;margin-top:10px">'+
      '<div class="hint">选择文件后，系统将在此列出每份文件的材料名称及上传状态。</div></div>'+
      '<div class="hint" data-material-batch-status role="status" aria-live="polite" style="margin:10px 0"></div>',
    footer:'<button class="btn btn-o" data-x="0">取消</button><button class="btn btn-p" data-x="1">确认上传资料</button>'
  });
  const picker=m.querySelector('input[name="file"]');
  const kindSelect=m.querySelector('[name="kind"]');
  // 类别入口已确定材料归属：弹窗可查看类别，但不能再改成另一个类别。
  // 自定义类别同样由点击入口指定；批次重试期间也不应解锁。
  kindSelect.disabled=!!defaultKind;
  if(defaultKind)kindSelect.title="已通过材料类别入口选择，请返回类别列表切换";
  const saveButton=m.querySelector('[data-x="1"]');
  const cancelButton=m.querySelector('[data-x="0"]');
  const rightSelect=m.querySelector('[name="sponsor_right_id"]');
  const rightField=rightSelect.closest(".fld");
  const pidSelect=m.querySelector('[name="pid"]');
  const fileList=m.querySelector("[data-material-file-list]");
  const batchStatus=m.querySelector("[data-material-batch-status]");
  const filenameCount=m.querySelector(".upload .fn");
  let picked=[],busy=false,availableRights=[],rightsRequestId=0;

  const drawFiles=()=>{
    if(filenameCount)filenameCount.textContent=picked.length?picked.length+" 份文件已选择":"未选择";
    if(!picked.length){
      fileList.innerHTML='<div class="hint">尚未选择文件。上传后各材料名称将与对应文件名相同。</div>';
      return;
    }
    fileList.innerHTML='<div class="hint">待登记材料名称（与文件名一致） · '+picked.length+' 份</div>'+
      '<div style="max-height:240px;overflow:auto;margin-top:6px">'+
      picked.map((item,i)=>'<div class="row" data-material-file="'+i+'" '+
        'style="justify-content:space-between;gap:12px;padding:7px 0;border-bottom:1px solid var(--line)">'+
        '<span style="overflow-wrap:anywhere;min-width:0">'+
        '<b data-material-name>'+esc(item.file.name)+'</b>'+
        '<span class="hint"> · '+formatBytes(item.file.size)+'</span>'+
        (item.speaker?'<span class="hint"> · 文件名关联讲者：'+esc(item.speaker)+'</span>':'')+'</span>'+
        '<span class="hint" data-material-status style="flex-shrink:0">'+
        esc(item.status==='done'?'已登记':item.status==='uploading'?'上传中…':
          item.status==='saving'?'归档中…':item.status==='error'?'失败，可重试':'待上传')+
        '</span></div>'+
        (item.error?'<div class="hint" style="color:var(--danger)">'+esc(item.error)+'</div>':'')).join("")+
      '</div>';
  };
  const resetFiles=()=>{
    if(busy)return;
    picked=[];
    picker.value="";
    batchStatus.textContent="";
    drawFiles();
  };
  const loadRights=async()=>{
    const requestId=++rightsRequestId;
    const pid=pidSelect.value;
    availableRights=[];
    rightSelect.innerHTML='<option value="">正在加载权益内容…</option>';
    if(!pid){rightSelect.innerHTML='<option value="">请先选择所属项目</option>';return;}
    try{
      const data=await api.get("/api/projects/"+encodeURIComponent(pid)+"/sponsor-rights");
      if(requestId!==rightsRequestId||pidSelect.value!==pid)return;
      // 与小程序一致：仅允许已签署的赞助合同关联权益照片。
      const sponsors=new Map((data.contracts||[]).filter(c=>c.status==="已签署").map(c=>[c.id,c]));
      availableRights=(data.rights||[]).filter(x=>sponsors.has(x.sponsor_id))
        .map(x=>({...x,enterprise:sponsors.get(x.sponsor_id).enterprise}));
    }catch(err){
      if(requestId!==rightsRequestId||pidSelect.value!==pid)return;
      if(kindSelect.value==="权益照片")toast("读取权益内容失败："+err.message,"warn");
    }
    const old=rightSelect.value;
    rightSelect.innerHTML='<option value="">选择赞助合同 → 权益内容</option>'+
      availableRights.map(x=>'<option value="'+x.id+'">'+esc(x.enterprise)+" · "+esc(x.category)+
        (x.confirmed?"":"（待确认）")+'</option>').join("");
    if(availableRights.some(x=>String(x.id)===old))rightSelect.value=old;
  };

  const syncKind=()=>{
    const final=kindSelect.value==="终版议程";
    const photo=kindSelect.value==="讲者照片";
    const rightsPhoto=kindSelect.value==="权益照片";
    rightField.style.display=rightsPhoto?"":"none";
    picker.multiple=true;
    picker.accept=photo||rightsPhoto?".jpg,.jpeg,.png,.webp":UPLOAD_ACCEPT;
    saveButton.textContent="确认上传资料";
    const tip=m.querySelector(".upload")?.closest(".fld")?.querySelector(".tip");
    if(tip)tip.textContent=final
      ?`终版议程一次可选择最多 ${MAX_MATERIAL_FILES_PER_BATCH} 份；按选择顺序登记，最后一份确认为当前终版，其余归为历史版。`
      :photo?`讲者照片一次可选择最多 ${MAX_MATERIAL_FILES_PER_BATCH} 张 JPG/PNG/WebP 图片，每张对应一位讲者；请在文件名中填写对应讲者姓名，便于终版议程核验。`
       :rightsPhoto?`可一次上传最多 ${MAX_MATERIAL_FILES_PER_BATCH} 张同一权益的 JPG/PNG/WebP 照片，每张独立归档。`
      :`一次最多选择 ${MAX_MATERIAL_FILES_PER_BATCH} 份、单份不超过 50 MB；并发上传并逐份归档，材料名称自动使用文件名。`;
  };
  pidSelect.addEventListener("change",()=>{resetFiles();loadRights();});
  kindSelect.addEventListener("change",()=>{resetFiles();syncKind();});
  syncKind();loadRights();drawFiles();

  picker.onchange=()=>{
    if(busy)return;
    const files=Array.from(picker.files||[]);
    const fail=msg=>{toast(msg,"warn");resetFiles();};
    if(files.length>MAX_MATERIAL_FILES_PER_BATCH)return fail(`单次最多选择 ${MAX_MATERIAL_FILES_PER_BATCH} 份材料附件`);
    if(!files.length){resetFiles();return;}
    const error=files.map(checkFile).find(Boolean);
    if(error)return fail(error);
    if(files.some(f=>!f.name.trim()||f.name.length>120))
      return fail("材料文件名必须有效且不能超过 120 字符");
    if(kindSelect.value==="讲者照片"&&files.some(f=>!/\.(jpe?g|png|webp)$/i.test(f.name||"")))
      return fail("讲者照片仅支持 JPG/PNG/WebP 图片，文件名应包含对应讲者姓名");
    if(kindSelect.value==="权益照片"&&files.some(f=>!/\.(jpe?g|png|webp)$/i.test(f.name||"")))
      return fail("权益照片仅支持 JPG/PNG/WebP 图片");
    picked=files.map(file=>({file,status:"pending",error:"",upload:null}));
    batchStatus.textContent=files.length+" 份文件已选择；"+(kindSelect.value==="终版议程"?"最后一份将确认为当前终版。":"保存时将使用各自文件名作为材料名称。");
    drawFiles();
  };

  cancelButton.onclick=()=>{if(!busy)m.classList.remove("open");};
  saveButton.onclick=async()=>{
    if(busy)return;
    if(!validate(m,fields))return;
    if(RETIRED_KINDS.has(kindSelect.value)){toast("企业赞助合同、会务协议和劳务协议请到合同模块管理","warn");return;}
    if(!picked.length){toast("请先选择至少一份材料文件","warn");return;}
    if(picked.length>MAX_MATERIAL_FILES_PER_BATCH){toast(`单次最多登记 ${MAX_MATERIAL_FILES_PER_BATCH} 份材料附件`,"warn");return;}
    const final=kindSelect.value==="终版议程";
    if(kindSelect.value==="权益照片"&&!availableRights.some(x=>String(x.id)===rightSelect.value)){
      toast("请先选择与当前赞助合同对应的权益内容","warn");return;
    }
    const data=readForm(m);
    if(RETIRED_KINDS.has(String(data.kind||"").trim())){
      toast("企业赞助合同、会务协议和劳务协议属于合同模块，请选择其他材料类别","warn");return;
    }
    delete data.name;delete data.version;
    data.version=final?"终版":"v1";
    if(kindSelect.value==="权益照片")data.sponsor_right_id=Number(rightSelect.value);
    else delete data.sponsor_right_id;

    const queue=picked.filter(x=>x.status!=="done");
    if(!queue.length)return;
    busy=true;saveButton.disabled=true;cancelButton.disabled=true;
    picker.disabled=true;pidSelect.disabled=true;kindSelect.disabled=true;
    const custom=m.querySelector('[name="kind__custom"]');
    if(custom)custom.disabled=true;
    rightSelect.disabled=true;
    let cursor=0;
    const worker=async()=>{
      while(cursor<queue.length){
        const item=queue[cursor++];
        item.status="uploading";item.error="";drawFiles();
        try{
          // The uploaded bytes retain the original filename, extension and MIME:
          // archived evidence must not silently turn a PNG into a JPEG.
          const up=item.upload||await api.upload(item.file,{pid:data.pid});
          item.upload=up;
          item.status="saving";drawFiles();
          const saved=await api.post("/api/projects/"+encodeURIComponent(data.pid)+"/materials",{
            ...data,name:item.file.name,
            file_key:up.key,file_name:up.name,file_size:up.size,file_mime:up.mime
          });
          item.speaker=saved.speakerFromFilename||"";
          item.status="done";item.error="";
        }catch(e){
          item.status="error";item.error=e.message||"上传或登记失败";
          if(final)cursor=queue.length; // retry this and later pending agendas in selection order
        }
        const done=picked.filter(x=>x.status==="done").length;
        batchStatus.textContent="已登记 "+done+"/"+picked.length+" 份材料"+
          (picked.some(x=>x.status==="error")?"，失败项可单独重试":"");
        drawFiles();
      }
    };
    // Serial registration is required for agenda versions: the LAST selected
    // agenda must remain current even after a failed file is retried.
    await Promise.all(Array.from({length:final?1:Math.min(3,queue.length)},()=>worker()));
    busy=false;saveButton.disabled=false;cancelButton.disabled=false;
    picker.disabled=false;pidSelect.disabled=false;kindSelect.disabled=!!defaultKind;
    if(custom)custom.disabled=false;
    rightSelect.disabled=false;
    const done=picked.filter(x=>x.status==="done").length;
    const failed=picked.length-done;
    if(done){
      try{if(onSaved)await onSaved();else await render(root);}
      catch(e){toast("材料已登记，但刷新列表失败："+e.message,"warn");}
    }
    if(failed){
      saveButton.textContent="重试失败的 "+failed+" 份";
      batchStatus.textContent="成功登记 "+done+" 份，失败 "+failed+" 份。请查看每个文件的状态后重试。";
      toast("已登记 "+done+" 份；另有 "+failed+" 份失败，可重试","warn");
    }else{
      toast(final?`已登记 ${done} 份议程，最后一份确认为当前终版`:"已登记 "+done+" 份材料，名称与原文件名一致","ok");
      m.classList.remove("open");
    }
  };
}
