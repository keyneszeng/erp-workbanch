import { api, can } from "../lib/api.js";
import {canDownloadArchivePdf,bindArchivePdfButtons} from "../lib/archive-pdf.js";
import { bindPager, esc, formHtml, modal, pager, panel, readForm, table, toast, validate } from "../lib/ui.js";
import { checkFile, fileUrl, formatBytes, UPLOAD_ACCEPT, UPLOAD_TIP } from "../lib/upload.js";
import { openContractMaterialReplace } from "../lib/contract-material-replace.js";

const PAGE_SIZE = 50;
let curPage = 1;

export async function render(root) {
  const d = await api.get(`/api/materials?page=${curPage}&size=${PAGE_SIZE}`);
  const complete = d.projects.filter((p) => p.uploadedCount > 0).length;

  root.innerHTML = `<div class="phead">
      <div><h2>材料中心</h2><p>材料类别自由选择 · 上传后按会议归档，不再要求固定类别</p></div>
      <div class="acts">${can("material:write") ? '<button class="btn btn-p" id="add">+ 登记材料</button>' : ""}</div>
    </div>
    <div class="grid g4">
      <div class="kpi"><div class="t">材料条目</div><div class="v">${d.total}<span class="u">条</span></div></div>
      <div class="kpi k2"><div class="t">在管项目</div><div class="v">${d.projects.length}<span class="u">个</span></div></div>
      <div class="kpi k4"><div class="t">已有附件项目</div><div class="v">${complete}<span class="u">个</span></div></div>
      <div class="kpi k3"><div class="t">尚未上传附件</div><div class="v">${d.projects.length - complete}<span class="u">个</span></div></div>
    </div>

    <div class="panel mt">
      <div class="panel-h"><h2>项目材料上传情况</h2><span class="hint">任意类别上传至少一份附件即可进入后续流程</span></div>
      ${table([{ t: "项目" }, { t: "状态", w: "84px" }, { t: "上传原件", w: "110px" }, { t: "类别数" }, { t: "操作", w: "90px" }],
        d.projects.map((p) => ({
          c: [`<a class="link" data-go="projects/${p.id}">${esc(p.name)}</a>`,
            esc(p.status), `<b class="${p.uploadedCount ? "pos" : "neg"}">${p.uploadedCount || 0} 份</b>`,
            esc(String(p.have?.length || 0))+" 类 · "+(p.uploadedCount ? "已满足材料条件" : "待上传附件"),
            `<button class="link" data-go="projects/${p.id}">查看</button>`]
        })), { empty: "暂无项目" })}
    </div>

    <div class="panel">
      <div class="panel-h"><h2>材料清单</h2><span class="hint">共 ${d.total} 条</span></div>
      ${table([{ t: "项目", w: "170px" }, { t: "类别", w: "92px" }, { t: "名称" }, { t: "附件", w: "86px" },
        { t: "版本", w: "56px" }, { t: "上传人", w: "76px" }, { t: "时间", w: "130px" }, { t:"操作",w:"78px" }],
        d.rows.map((m) => ({
          c: [`<a class="link" data-go="projects/${m.pid}">${esc(m.pname)}</a>`, esc(m.kind)+(m.kind==="权益照片"?`<div class="hint">${esc(m.sponsor_enterprise||"未关联赞助合同")} · ${esc(m.sponsor_right_category||"未关联权益类目")}</div>`:""),
            esc(m.name),
            m.file_key
              ? (m.file_mime === "application/pdf" || /\.(doc|docx|ppt|pptx|xls|xlsx|csv|txt)$/i.test(m.file_key)
                  ? `<a class="link" href="${fileUrl(m.file_key)}" target="_blank" rel="noopener">${esc(m.file_name || "下载附件")}</a>`
                  : `<a href="${fileUrl(m.file_key)}" target="_blank" rel="noopener"><img class="thumb" src="${fileUrl(m.file_key)}" alt=""></a>`)
              : '<span style="color:var(--mute)">—</span>',
            esc(m.version || ""), esc(m.uploader || ""), `<span class="mono">${esc(m.created_at)}</span>`,
            (can("material:file:replace") && m.file_key && !["已核销","已结算","已归档"].includes(m.pstatus)
              ? `<button class="link" data-replace-material="${Number(m.id)}">修改</button>` : "") +
            (canDownloadArchivePdf({status:m.pstatus,assoc:m.passoc})
              ? ` <button class="link" data-archive-pdf="${esc(m.pid)}">材料下载</button>` : "") || "—"]
        })),
        { empty: "暂无材料" })}
      ${pager(d, { unit: "条" })}
    </div>
`;

  bindPager(root, (n) => { curPage = n; render(root); });
  bindArchivePdfButtons(root);

  const add = root.querySelector("#add");
  if (add) add.onclick = () => openMaterialRegistration(root, d.projects.filter(p=>!["已结算","已归档"].includes(p.status)), d.kinds);
  root.querySelectorAll("[data-replace-material]").forEach(btn=>{
    btn.onclick=()=>{
      const item=d.rows.find(x=>Number(x.id)===Number(btn.dataset.replaceMaterial));
      if(item)openContractMaterialReplace(item,()=>render(root));
    };
  });
}

/**
 * 两处入口（会议项目→归档材料、材料中心）共享同一登记表单。
 * 材料名称严格使用用户所选择文件的原始名称；附件不做有损压缩。
 * 最多 20 份/批、并发 3 份，逐份显示结果，失败文件可单独重试。
 */
export function openMaterialRegistration(root, projects, kinds, defaultPid="", onSaved=null) {
  if(!projects.length){
    toast("当前没有可登记材料的项目（已结算、已归档项目不允许新增材料）","warn");
    return;
  }
  const fields=[
    {k:"pid",l:"所属项目",t:"select",req:1,v:defaultPid,
      opts:projects.map(p=>({v:p.id,l:p.id+" "+p.name}))},
    {k:"kind",l:"材料类别",t:"select",req:1,custom:1,
      ph:"如：盖章会议通知 / 招商函 / 终版议程 / 讲者照片",
      opts:[...kinds,"会议通知","招商函","终版议程","课件","串场","劳务表","劳务收集表","讲者照片","权益照片"]
        .filter((v,i,a)=>a.indexOf(v)===i),
      tip:"可任选或自定义类别。多份文件将分别登记到当前项目与材料类别。"},
    {k:"sponsor_right_id",l:"权益照片 · 二级类目（从赞助合同自动生成，可自定义）",
      t:"select",opts:[],tip:"先选择项目及赞助合同权益，再上传对应照片。"},
    {k:"file",l:"选择材料文件",t:"file",full:1,accept:UPLOAD_ACCEPT,
      tip:"一次最多选择 20 份，每份不超过 50 MB；支持并发上传。材料名称自动采用对应文件名，无需手动输入。"}
  ];
  const m=modal({
    title:"登记材料",width:"660px",
    body:formHtml(fields)+
      '<div data-material-file-list aria-live="polite" class="fld full" style="grid-column:1/-1;margin-top:10px">'+
      '<div class="hint">选择文件后，系统将在此列出每份文件的材料名称及上传状态。</div></div>'+
      '<div class="hint" data-material-batch-status role="status" aria-live="polite" style="margin:10px 0"></div>',
    footer:'<button class="btn btn-o" data-x="0">取消</button><button class="btn btn-p" data-x="1">上传并登记</button>'
  });
  const picker=m.querySelector('input[name="file"]');
  const kindSelect=m.querySelector('[name="kind"]');
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
        '<span class="hint"> · '+formatBytes(item.file.size)+'</span></span>'+
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
      const sponsors=new Map((data.contracts||[]).filter(c=>c.status!=="已驳回").map(c=>[c.id,c]));
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
    picker.multiple=!final&&!photo;
    picker.accept=photo||rightsPhoto?".jpg,.jpeg,.png,.webp":UPLOAD_ACCEPT;
    saveButton.textContent=final?"确定终版议程":"上传并登记";
    const tip=m.querySelector(".upload")?.closest(".fld")?.querySelector(".tip");
    if(tip)tip.textContent=final
      ?"终版议程只允许上传一份文件，材料名称与文件名相同，保存即自动确认为终版。"
      :photo?"讲者照片每次上传一位讲者的一张 JPG/PNG/WebP 图片；文件名应包含讲者姓名。"
      :rightsPhoto?"可同时上传同一权益的多张 JPG/PNG/WebP 照片，每张独立归档。"
      :"一次最多选择 20 份、单份不超过 50 MB；并发上传并逐份归档，材料名称自动使用文件名。";
  };
  pidSelect.addEventListener("change",()=>{resetFiles();loadRights();});
  kindSelect.addEventListener("change",()=>{resetFiles();syncKind();});
  syncKind();loadRights();drawFiles();

  picker.onchange=()=>{
    if(busy)return;
    const files=Array.from(picker.files||[]);
    const fail=msg=>{toast(msg,"warn");resetFiles();};
    if(files.length>20)return fail("单次最多选择 20 份材料附件");
    if(!files.length){resetFiles();return;}
    const error=files.map(checkFile).find(Boolean);
    if(error)return fail(error);
    if(files.some(f=>!f.name.trim()||f.name.length>120))
      return fail("材料文件名必须有效且不能超过 120 字符");
    if(kindSelect.value==="终版议程"&&files.length!==1)
      return fail("终版议程只能上传一份文件");
    if(kindSelect.value==="讲者照片"&&(files.length!==1||
      !/\.(jpe?g|png|webp)$/i.test(files[0].name||"")))
      return fail("讲者照片请一次选择一位讲者的一张 JPG/PNG/WebP 图片");
    if(kindSelect.value==="权益照片"&&files.some(f=>!/\.(jpe?g|png|webp)$/i.test(f.name||"")))
      return fail("权益照片仅支持 JPG/PNG/WebP 图片");
    picked=files.map(file=>({file,status:"pending",error:"",upload:null}));
    batchStatus.textContent=files.length+" 份文件已选择；保存时将使用各自文件名作为材料名称。";
    drawFiles();
  };

  cancelButton.onclick=()=>{if(!busy)m.classList.remove("open");};
  saveButton.onclick=async()=>{
    if(busy)return;
    if(!validate(m,fields))return;
    if(!picked.length){toast("请先选择至少一份材料文件","warn");return;}
    const final=kindSelect.value==="终版议程";
    if(final&&picked.length!==1){toast("终版议程只能上传一份文件","warn");return;}
    if(kindSelect.value==="讲者照片"&&picked.length!==1){
      toast("讲者照片每次只能上传一位讲者的一张图片","warn");return;
    }
    if(kindSelect.value==="权益照片"&&!availableRights.some(x=>String(x.id)===rightSelect.value)){
      toast("请先选择与当前赞助合同对应的权益内容","warn");return;
    }
    const data=readForm(m);
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
          await api.post("/api/projects/"+encodeURIComponent(data.pid)+"/materials",{
            ...data,name:item.file.name,
            file_key:up.key,file_name:up.name,file_size:up.size,file_mime:up.mime
          });
          item.status="done";item.error="";
        }catch(e){
          item.status="error";item.error=e.message||"上传或登记失败";
        }
        const done=picked.filter(x=>x.status==="done").length;
        batchStatus.textContent="已登记 "+done+"/"+picked.length+" 份材料"+
          (picked.some(x=>x.status==="error")?"，失败项可单独重试":"");
        drawFiles();
      }
    };
    await Promise.all(Array.from({length:Math.min(3,queue.length)},()=>worker()));
    busy=false;saveButton.disabled=false;cancelButton.disabled=false;
    picker.disabled=false;pidSelect.disabled=false;kindSelect.disabled=false;
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
      toast(final?"终版议程已上传并确认":"已登记 "+done+" 份材料，名称与原文件名一致","ok");
      m.classList.remove("open");
    }
  };
}
