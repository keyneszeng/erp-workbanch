import {api,state,can} from "./api.js";
import {esc,modal,toast} from "./ui.js";

/** 会议卷宗按 15 类系统目录自动汇集全部有权限的源文件，不只查询材料上传表。 */
export function canDownloadArchivePdf(project){
 const me=state.user;
 return !!(project&&project.status==="已归档"&&me&&can("archive:download"));
}
export async function downloadArchivePdf(pid,button){
 if(!pid||(button&&button.disabled))return;
 const original=button?.textContent||"材料下载";
 if(button){button.disabled=true;button.textContent="正在汇集项目资料…";}
 try{
  const data=await api.get("/api/projects/"+encodeURIComponent(pid)+"/archive-pdf/options");
  const groups=data.groups||[],sources=data.sources||[];
  const groupRows=groups.map(g=>
   '<label class="material-export-choice">'+
   '<input type="checkbox" name="material_category" value="'+esc(g.kind)+'"'+
     (g.count?' checked':' disabled')+'>'+
   '<span><b>'+esc(g.kind)+'</b><small>已关联 '+g.count+' 项'+
     (g.generated?' · 系统生成 '+g.generated+' 项':'')+
     (g.count?'':'（暂无资料）')+'</small></span></label>'
  ).join("");
  const superAdmin=data.can_customize_watermark===true;
  const wmHtml=superAdmin?
   '<div class="fld"><label>PDF 每页水印</label>'+
     '<select name="watermark_mode"><option value="default">操作员＋生成时间（默认）</option>'+
     '<option value="none">无水印（总管理员）</option>'+
     '<option value="custom">自定义水印</option></select></div>'+
   '<div class="fld" data-custom-watermark hidden><label>自定义文字（1～80字）</label>'+
    '<input name="watermark_text" maxlength="80" placeholder="输入水印文字"></div>'
   :'<p class="hint">PDF 每页标注操作员及生成时间；仅总管理员可修改水印。</p>';
  const m=modal({
   title:"数字卷宗 · 自动材料归集与付款PPT",width:"850px",
   body:'<p class="hint" style="margin-bottom:14px"><b>'+esc(data.project.name)+'</b> · '+
      esc(data.project.assoc)+' · '+esc(data.project.id)+'</p>'+
    '<div class="gate ok" style="margin-bottom:14px"><b>已按预设15类自动排序并关联合同、赞助、回单、发票、邀请函、会议材料与需求单。</b>'+
      ' 原始文件按归属会议编号自动识别，重复原件按文件内容去重，只保留第一次出现的版本。没有已签原件的系统生成摘要会明确标注，绝不充当签章原件。</div>'+
    '<div class="material-export-tools"><b>资料目录（15类固定顺序，不可跨类调整）</b>'+
      '<button type="button" class="link" data-select-all>全选</button>'+
      '<button type="button" class="link" data-clear-all>清空</button></div>'+
    '<div class="material-export-options" data-archive-groups>'+groupRows+'</div>'+
    '<div class="material-export-tools" style="margin-top:14px"><b>自动关联的文件与系统摘要</b>'+
      '<span class="hint">已关联 '+sources.length+' 项；仅支持同一类别内调整顺序，合并时自动去重</span></div>'+
    '<div data-material-file-list class="material-export-options" style="max-height:340px;overflow:auto"></div>'+
    '<p class="hint" style="margin:12px 0">PDF 第1页为会议封面，第2页为项目台账结算单＋分类付款对照；随后严格按预设15类优先级合并原件，类别内部沿用当前顺序，相同原件只合并一次。下载 PPT 独立生成，'+
       '第一页为会议信息、第二页为唯一的付款明细对照表；从第三页起，按当前勾选和排序逐项展示原件内容。无法渲染的文件将标注原因并保留原件。</p>'+
    wmHtml,
   footer:'<button class="btn btn-o" data-cancel>取消</button>'+
    '<button class="btn btn-o" data-export-pptx>生成并下载 PPT</button>'+
    '<button class="btn btn-p" data-export>生成并下载 PDF</button>'
  });
  const controls=[...m.querySelectorAll('input[name="material_category"]')];
  const all=m.querySelector("[data-select-all]"),clear=m.querySelector("[data-clear-all]");
  const list=m.querySelector("[data-material-file-list]");
  const ordered=sources.slice(); // only same-category reorder is allowed; the API enforces category precedence
  const checkedIds=new Set(ordered.map(x=>x.source_id));
  const shortSize=s=>{
   const bytes=Number(s.file_size||0);
   return bytes>0?' · '+(bytes/1048576).toFixed(1)+'MB'+(bytes>20*1048576?' · 将尝试压缩':''):'';
  };
  const renderFiles=()=>{
   const enabled=new Set(controls.filter(x=>x.checked).map(x=>x.value));
   const visible=ordered.filter(s=>enabled.has(s.kind));
   list.innerHTML=visible.length?visible.map((s,i)=>
     '<div class="material-export-choice" data-source-id="'+esc(s.source_id)+'" style="display:flex;align-items:center;gap:9px">'+
     '<input type="checkbox" data-file-select="'+esc(s.source_id)+'"'+(checkedIds.has(s.source_id)?' checked':'')+'>'+
     '<span style="flex:1;min-width:0"><b>'+esc(s.name)+'</b>'+
      '<small>'+esc(s.kind)+' · '+esc(s.source_type||"材料库")+
        (s.generated?' · 系统生成摘要/记录':' · '+esc(s.file_name||"原件"))+
        shortSize(s)+'</small></span>'+
     '<button type="button" class="link" data-move-up="'+esc(s.source_id)+'"'+(i===0||visible[i-1].kind!==s.kind?' disabled':'')+'>上移</button>'+
     '<button type="button" class="link" data-move-down="'+esc(s.source_id)+'"'+(i===visible.length-1||visible[i+1].kind!==s.kind?' disabled':'')+'>下移</button></div>'
   ).join(""):'<div class="hint">当前选中目录没有资料</div>';
   list.querySelectorAll("[data-file-select]").forEach(el=>el.onchange=()=>{
    if(el.checked)checkedIds.add(el.dataset.fileSelect);
    else checkedIds.delete(el.dataset.fileSelect);
   });
   const move=(id,delta)=>{
    const from=ordered.findIndex(s=>s.source_id===id);
    const ix=visible.findIndex(s=>s.source_id===id);
    const target=visible[ix+delta];
    if(from<0||!target||ordered[from].kind!==target.kind)return;
    const to=ordered.findIndex(s=>s.source_id===target.source_id);
    [ordered[from],ordered[to]]=[ordered[to],ordered[from]];
    renderFiles();
   };
   list.querySelectorAll("[data-move-up]").forEach(el=>el.onclick=()=>move(el.dataset.moveUp,-1));
   list.querySelectorAll("[data-move-down]").forEach(el=>el.onclick=()=>move(el.dataset.moveDown,1));
  };
  all.onclick=()=>{controls.forEach(x=>{if(!x.disabled)x.checked=true});renderFiles();};
  clear.onclick=()=>{controls.forEach(x=>x.checked=false);renderFiles();};
  controls.forEach(x=>x.addEventListener("change",renderFiles));
  renderFiles();
  m.querySelector("[data-cancel]").onclick=()=>m.classList.remove("open");
  const mode=m.querySelector('[name="watermark_mode"]'),custom=m.querySelector("[data-custom-watermark]");
  if(mode&&custom){
   const sync=()=>custom.hidden=mode.value!=="custom";
   mode.onchange=sync;sync();
  }
  const pdf=m.querySelector("[data-export]");
  pdf.onclick=async()=>{
   if(pdf.disabled)return;
   const active=new Set(controls.filter(x=>x.checked).map(x=>x.value));
   const ids=ordered.filter(s=>active.has(s.kind)&&checkedIds.has(s.source_id)).map(s=>s.source_id);
   if(!ids.length){toast("请至少选择一项与本会议关联的文件","warn");return;}
   if(ids.length>120){toast("单次 PDF 最多归集120份文件，请按类目分批下载","warn");return;}
   const watermarkMode=mode?.value||"default";
   const watermarkText=m.querySelector('[name="watermark_text"]')?.value.trim()||"";
   if(watermarkMode==="custom"&&(!watermarkText||watermarkText.length>80)){
    toast("自定义水印须填写1～80字","warn");return;
   }
   pdf.disabled=true;pdf.textContent="正在合并资料…";
   try{
    const out=await api.download("/api/projects/"+encodeURIComponent(pid)+"/archive-pdf",{
     method:"POST",body:{source_ids:ids,watermark_mode:watermarkMode,watermark_text:watermarkText}
    });
    m.classList.remove("open");toast("已下载会议资料PDF："+out.name,"ok");
   }catch(e){toast("PDF生成失败："+e.message,"warn");}
   finally{pdf.disabled=false;pdf.textContent="生成并下载 PDF";}
  };
  const ppt=m.querySelector("[data-export-pptx]");
  ppt.onclick=async()=>{
   if(ppt.disabled)return;
   ppt.disabled=true;ppt.textContent="正在生成付款对照 PPT…";
   try{
    // Reuse exactly the same per-file selection and manual ordering as PDF.
    const enabled=new Set(controls.filter(x=>x.checked).map(x=>x.value));
    const sourceIds=ordered.filter(s=>enabled.has(s.kind)&&checkedIds.has(s.source_id))
      .map(s=>s.source_id);
    if(!sourceIds.length){toast("请至少勾选一项会议资料","warn");return;}
    const result=await api.download("/api/projects/"+encodeURIComponent(pid)+"/archive-pptx",{
      method:"POST",body:{source_ids:sourceIds}
    });
    m.classList.remove("open");toast("已下载付款明细PPT："+result.name,"ok");
   }catch(e){toast("生成PPT失败："+e.message,"warn");}
   finally{ppt.disabled=false;ppt.textContent="生成并下载 PPT";}
  };
 }catch(e){toast("读取数字卷宗资料失败："+(e.message||"请稍后重试"),"warn");}
 finally{if(button){button.disabled=false;button.textContent=original;}}
}
export function bindArchivePdfButtons(root){
 root.querySelectorAll("[data-archive-pdf]").forEach(button=>{
  button.addEventListener("click",event=>{
   event.preventDefault();event.stopPropagation();
   downloadArchivePdf(button.dataset.archivePdf,button);
  });
 });
}
