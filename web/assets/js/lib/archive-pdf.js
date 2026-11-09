import {api,state,can} from "./api.js";
import {esc,modal,toast} from "./ui.js";

/** 原归档权限保持不变；导出内容从固定卷宗改为材料类目自由勾选。 */
export function canDownloadArchivePdf(project){
 const me=state.user;
 return !!(project&&project.status==="已归档"&&me&&can("archive:download"));
}
export async function downloadArchivePdf(pid,button){
 if(!pid||(button&&button.disabled))return;
 const original=button?.textContent||"材料下载";
 if(button){button.disabled=true;button.textContent="读取材料类目…";}
 try{
  const data=await api.get("/api/projects/"+encodeURIComponent(pid)+"/archive-pdf/options");
  const categories=data.categories||[];
  const originals=data.materials||[];
  const available=categories.filter(c=>c.files>0);
  if(!available.length){toast("此会议材料库没有可导出的已上传附件","warn");return;}
  const superAdmin=data.can_customize_watermark===true;
  const rows=categories.map(item=>
    '<label class="material-export-choice">'+
      '<input type="checkbox" name="material_category" value="'+esc(item.kind)+'"'+
      (item.files?' checked':' disabled')+'>'+
      '<span><b>'+esc(item.kind)+'</b>'+
      '<small>'+item.files+' 份原件 · '+item.entries+' 条登记'+
      (item.files?'':'（无附件）')+'</small></span></label>'
  ).join("");
  const watermarkOptions=superAdmin?
   '<div class="fld"><label>每页文字水印</label>'+
    '<select name="watermark_mode"><option value="default">操作员姓名＋生成时间（默认）</option>'+
      '<option value="none">不加水印</option><option value="custom">自定义文字水印</option></select></div>'+
    '<div class="fld" data-custom-watermark hidden><label>自定义文字（1～80字）</label>'+
      '<input name="watermark_text" maxlength="80" placeholder="输入要显示在每页的水印文字"></div>'
  :'<div class="hint">PDF 每页默认标注当前操作员姓名与生成时间。</div>';
  const m=modal({
   title:"材料下载 · 自选类目生成 PDF",width:"680px",
   body:'<div class="hint" style="margin-bottom:12px"><b>'+esc(data.project.name)+'</b> · '+
      esc(data.project.assoc)+'</div>'+
      '<div class="material-export-tools"><b>选择材料库类目</b>'+
       '<button class="link" type="button" data-select-all>全选</button>'+
       '<button class="link" type="button" data-clear-all>清空</button></div>'+
      '<div class="material-export-options">'+rows+'</div>'+
      '<div class="material-export-tools" style="margin-top:14px"><b>自选原件及排序</b><span class="hint">勾选文件，点击上移/下移调整 PDF 先后顺序</span></div>'+
      '<div data-material-file-list class="material-export-options"></div>'+
      '<div class="hint" style="margin:12px 0">PDF 首页面仅含活动标题和所属协会；原件按上方自定义顺序合并。PDF、JPG、PNG直接合并成可见页面，'+
      '其他格式将保留原始附件并在 PDF 中注明，缺失原件会阻止导出。</div>'+
      watermarkOptions,
   footer:'<button class="btn btn-o" data-cancel>取消</button>'+
      '<button class="btn btn-p" data-export>生成并下载 PDF</button>'
  });
  const checkboxes=[...m.querySelectorAll('input[name="material_category"]')];
  m.querySelector("[data-select-all]").onclick=()=>checkboxes.forEach(x=>{if(!x.disabled)x.checked=true;});
  m.querySelector("[data-clear-all]").onclick=()=>checkboxes.forEach(x=>x.checked=false);
  const list=m.querySelector("[data-material-file-list]");
  // Row order is the requested PDF order. The server rechecks each ID and category.
  const ordered=originals.filter(x=>Number.isSafeInteger(x.id)&&x.id>0);
  const checkedIds=new Set(ordered.map(x=>x.id));
  const renderFiles=()=>{
   const allowed=new Set(checkboxes.filter(x=>x.checked).map(x=>x.value));
   const visible=ordered.filter(x=>allowed.has(x.kind));
   list.innerHTML=visible.length?visible.map((x,i)=>
      '<div class="material-export-choice" data-file-id="'+x.id+'" style="display:flex;align-items:center;gap:8px">'+
      '<input type="checkbox" data-file-select="'+x.id+'" '+(checkedIds.has(x.id)?'checked':'')+'>'+
      '<span style="flex:1;min-width:0"><b>'+esc(x.name||x.file_name||"未命名")+'</b>'+
      '<small>'+esc(x.kind)+' · '+esc(x.file_name||"原件")+'</small></span>'+
      '<button type="button" class="link" data-move-up="'+x.id+'" '+(i===0?'disabled':'')+'>上移</button>'+
      '<button type="button" class="link" data-move-down="'+x.id+'" '+(i===visible.length-1?'disabled':'')+'>下移</button></div>'
     ).join(""):'<div class="hint">当前类目无可选原件</div>';
   list.querySelectorAll("[data-file-select]").forEach(el=>{
    el.onchange=()=>{const id=Number(el.dataset.fileSelect);if(el.checked)checkedIds.add(id);else checkedIds.delete(id);};
   });
   const move=(id,delta)=>{
    const index=ordered.findIndex(x=>x.id===id);
    const next=visible[visible.findIndex(x=>x.id===id)+delta];
    const target=next?ordered.findIndex(x=>x.id===next.id):-1;
    if(index<0||target<0)return;
    [ordered[index],ordered[target]]=[ordered[target],ordered[index]];
    renderFiles();
   };
   list.querySelectorAll("[data-move-up]").forEach(el=>el.onclick=()=>move(Number(el.dataset.moveUp),-1));
   list.querySelectorAll("[data-move-down]").forEach(el=>el.onclick=()=>move(Number(el.dataset.moveDown),1));
  };
  checkboxes.forEach(el=>el.addEventListener("change",renderFiles));
  const selectAll=m.querySelector("[data-select-all]");
  const clearAll=m.querySelector("[data-clear-all]");
  selectAll.addEventListener("click",renderFiles);
  clearAll.addEventListener("click",renderFiles);
  renderFiles();
  m.querySelector("[data-cancel]").onclick=()=>m.classList.remove("open");
  const mode=m.querySelector('[name="watermark_mode"]');
  const custom=m.querySelector("[data-custom-watermark]");
  if(mode&&custom){
   const sync=()=>custom.hidden=mode.value!=="custom";
   mode.onchange=sync;sync();
  }
  const submit=m.querySelector("[data-export]");
  submit.onclick=async()=>{
   if(submit.disabled)return;
   const selected=checkboxes.filter(x=>x.checked).map(x=>x.value);
   if(!selected.length){toast("请至少勾选一个已上传附件的材料类别","warn");return;}
   const activeKinds=new Set(selected);
   const materialIds=ordered.filter(x=>activeKinds.has(x.kind)&&checkedIds.has(x.id)).map(x=>x.id);
   if(!materialIds.length){toast("请至少选择一份材料原件","warn");return;}
   const wmMode=mode?.value||"default";
   const customText=m.querySelector('[name="watermark_text"]')?.value.trim()||"";
   if(wmMode==="custom"&&(!customText||customText.length>80)){
    toast("请输入1～80字的自定义文字水印","warn");return;
   }
   submit.disabled=true;submit.textContent="正在生成 PDF…";
   try{
    const result=await api.download(
      "/api/projects/"+encodeURIComponent(pid)+"/archive-pdf",{
       method:"POST",body:{categories:selected,material_ids:materialIds,watermark_mode:wmMode,watermark_text:customText}
      });
    m.classList.remove("open");
    toast("材料 PDF 已生成："+result.name,"ok");
   }catch(err){toast("生成材料PDF失败："+(err.message||"请重试"),"warn");}
   finally{submit.disabled=false;submit.textContent="生成并下载 PDF";}
  };
 }catch(err){toast("读取材料类别失败："+(err.message||"请重试"),"warn");}
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
