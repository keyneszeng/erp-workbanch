import {api} from "./api.js";
import {esc,modal,toast,confirmBox} from "./ui.js";

/** 统一核销入口：不再出现任何手工录入或三级表单。 */
export async function openOcrJudge(pid,no,d,onDone){
 const s=d.verification?.steps?.find(x=>x.no===no);
 if(!s)return;
 const m=modal({
  title:"第 "+no+" 项 · OCR智能核销 · "+esc(s.name),
  width:"820px",
  body:'<div class="gate" style="margin-bottom:12px">直接扫描已上传的原件，自动提取关键信息并跨文件比对；OCR结果是辅助意见，必须由操作员人工判定。</div>'+
   '<div data-scan-result aria-live="polite"><p class="hint">正在读取文件并进行OCR扫描、关键信息抽取与一致性检查…</p></div>',
  footer:'<button class="btn btn-o" data-x="0">关闭</button>'+
   '<button class="btn btn-o" data-rescan disabled>重新扫描</button>'+
   '<button class="btn btn-o" data-reject disabled>人工判定不通过</button>'+
   '<button class="btn btn-p" data-approve disabled>人工判定通过</button>'
 });
 const area=m.querySelector("[data-scan-result]");
 const approve=m.querySelector("[data-approve]");
 const reject=m.querySelector("[data-reject]");
 const rescan=m.querySelector("[data-rescan]");
 const close=m.querySelector('[data-x="0"]');
 let report=null,busy=false,closed=false;
 close.onclick=()=>{closed=true;m.classList.remove("open");};
 // 在线原件窗口：核对 OCR 结果（尤其第5步银行账号尾号）时不必离开判定页。
 const openViewer=(key,name)=>{
  const ext=String(key.split(".").pop()||"").toLowerCase();
  const url="/api/uploads/"+encodeURIComponent(key);
  const images=["jpg","jpeg","png","webp","gif","bmp"];
  const box=document.createElement("div");
  box.className="fv";
  box.innerHTML='<div class="fv-mask" data-fv-close></div><div class="fv-box">'+
   '<div class="fv-hd"><b>'+esc(name||"原件")+'</b><span>'+
    '<a class="link" href="'+url+'" target="_blank" rel="noopener">新窗口打开</a>'+
    '<button class="btn btn-o" data-fv-close style="margin-left:10px">关闭</button></span></div>'+
   '<div class="fv-bd">'+(images.includes(ext)?'<img src="'+url+'" alt="原件">':
     ext==="pdf"?'<iframe src="'+url+'" title="原件预览"></iframe>':
     '<div class="hint" style="padding:24px">该格式不支持在线预览，请<a class="link" href="'+url+
       '" target="_blank" rel="noopener">下载后查看</a>。</div>')+
   '</div></div>';
  document.body.appendChild(box);
  box.querySelectorAll("[data-fv-close]").forEach(el=>el.onclick=()=>box.remove());
 };
 area.addEventListener("click",e=>{
  const a=e.target.closest("[data-view]");
  if(!a)return;
  e.preventDefault();
  openViewer(a.getAttribute("data-view"),a.getAttribute("data-view-name"));
 });
 const fmtStatus=x=>x==="一致"?"<span class='badge b-green'>一致</span>":
   x==="不一致"?"<span class='badge b-red'>不一致</span>":"<span class='badge b-orange'>无法自动确认</span>";
 const sourceLink=(file,r)=>{
  // files[] 里刻意不含 fileKey；evidence.sources 与项目详情各有一份，优先用前者，
  // 这样只有核销判定权、没有材料查看权的操作员也能打开原件。
  const fromReport=(r?.evidence?.sources||[])
   .find(x=>Number(x.materialId)===Number(file.materialId))?.fileKey;
  const key=fromReport||
    (d.materials||[]).find(x=>Number(x.id)===Number(file.materialId))?.file_key||
    (d.sponsorRights?.photos||[]).find(x=>Number(x.id)===Number(file.materialId))?.file_key;
  return key?'<a class="link" href="/api/uploads/'+encodeURIComponent(key)+
    '" data-view="'+esc(key)+'" data-view-name="'+esc(file.name||file.fileName||"原件")+
    '" target="_blank" rel="noopener">查看原件</a>':"";
 };
 const show=r=>{
  const n=r.summary;
  const fileRows=(r.files||[]).map(f=>
   '<div style="border-bottom:1px solid var(--line);padding:8px 0">'+
    '<b>'+esc(f.kind+" · "+f.name)+'</b>　'+sourceLink(f,r)+
    '<div class="hint">'+(f.state==="recognized"?(f.mode==="office-text"?
      (/\.xlsx$/i.test(f.fileName||f.name)?"Excel 工作表内容已提取":"Office 文档文字已提取"):
      f.mode==="native-text"?"文本内容已提取":"已识别 "+f.pages+"/"+f.totalPages+" 页"):
      f.state==="unsupported"?"格式不支持直接OCR":"识别失败或内容为空")+
      (f.truncated?" · 有未扫描页":"")+'</div>'+
    (f.preview?'<div class="hint" style="overflow-wrap:anywhere">识别摘录：'+esc(f.preview)+'</div>':"")+'</div>'
  ).join("");
  const rows=(r.checks||[]).map(x=>'<div style="border-bottom:1px solid var(--line);padding:9px 0">'+
    '<div style="display:flex;gap:8px;align-items:center;justify-content:space-between"><b>'+esc(x.name)+'</b>'+fmtStatus(x.status)+'</div>'+
    '<div class="hint" style="margin-top:4px">'+esc(x.detail)+'</div></div>').join("");
  const financialSource=no===6&&r.demandSheet?
    '<div class="panel" style="padding:12px;margin-bottom:12px"><b>会务需求表（结构化业务原件）</b><div class="hint">'+
    '归档状态：'+(r.demandSheet.confirmed?'已确认':'未确认')+
    ' · 需求预算：'+esc(String(r.demandSheet.budgetTotal))+' 元 · 会务合同：'+
    esc(String(r.demandSheet.contractTotal))+' 元</div></div>':'';
  const sponsorSources=no===7&&(r.sponsorContracts||[]).length?
    '<div class="panel" style="padding:12px;margin-bottom:12px"><b>关联的赞助合同</b>'+
    r.sponsorContracts.map(s=>'<div class="hint"><b>'+esc(s.enterprise||s.id)+'</b> · '+esc(s.status||'未确认')+
      (s.fileKey?' · <a class="link" href="/api/uploads/'+encodeURIComponent(s.fileKey)+
        '" data-view="'+esc(s.fileKey)+'" data-view-name="'+esc(s.fileName||'赞助合同原件')+
        '" target="_blank" rel="noopener">'+esc(s.fileName||'查看合同原件')+'</a>':' · 原件缺失')+
      '</div>').join('')+'</div>':'';
  // 第5步：把 OCR 识别到的劳务收款账号（仅尾号）列出来，供对照原件核对。
  const laborAccounts=no===5&&(r.laborRecordsMasked||[]).length?
    '<div class="panel" style="padding:12px;margin-bottom:12px"><b>劳务表识别的收款账号（仅显示尾号）</b>'+
    r.laborRecordsMasked.map(x=>'<div class="hint"><b>'+esc(x.name)+'</b> · ¥'+esc(String(x.amount))+
      ' · '+esc(x.maskedAccount)+'</div>').join('')+
    (r.evidence?.laborSkipped?'<div class="hint">另有 '+esc(String(r.evidence.laborSkipped))+
      ' 行信息不完整，未导入，需人工补录。</div>':'')+
    '<div class="hint">判定通过后这些账号会加密保存，付款申请时可直接选用。请先点上方「查看原件」核对尾号。</div></div>':"";
  area.innerHTML=financialSource+sponsorSources+laborAccounts+'<div class="grid g3" style="margin-bottom:12px">'+
    '<div class="kpi k2"><div class="t">OCR识别原件</div><div class="v">'+r.scanned+'/'+r.total+'</div></div>'+
    '<div class="kpi k3"><div class="t">自动比对一致</div><div class="v">'+n.match+'</div></div>'+
    '<div class="kpi k4"><div class="t">异常/待确认</div><div class="v">'+(n.mismatch+n.uncertain)+'</div></div></div>'+
    '<div class="panel" style="padding:12px;margin-bottom:12px"><b>智能比对结果</b>'+rows+'</div>'+
    '<details><summary>查看识别文件和OCR摘录（'+r.files.length+'份）</summary>'+
      '<div style="max-height:220px;overflow:auto;padding:6px">'+(fileRows||"没有可比对原件")+'</div></details>'+
    '<p class="hint" style="margin-top:12px">'+esc(r.warning)+'</p>'+
    (no===5?'<p class="hint">判定通过后，劳务表识别到的收款账号将加密保存并在付款申请中自动带出；请务必打开原件核对账号尾号。</p>':"");
 };
 const load=async()=>{
  if(busy||closed)return;
  busy=true;report=null;
  approve.disabled=true;reject.disabled=true;rescan.disabled=true;
  area.innerHTML='<p class="hint">正在扫描原件并比对，未识别或无法判断的项目会明确提示，不会自动标记通过。</p>';
  try{
   const x=await api.post("/api/projects/"+encodeURIComponent(pid)+"/verify/steps/"+no+"/scan",{});
   if(closed)return;
   report=x.report;
   show(report);
   reject.disabled=false;
   // 无可用OCR资料不能以“智能自动比对”名义直接确认通过；第三/六/七项需人工检查原件。
   // 第6步是原件关联核对（需求表预算=会务合同总额+已关联发票），本就不做OCR，
   // 不能因为 scanned=0 把「人工判定通过」永久置灰。
   approve.disabled=!report.total||(!report.scanned&&![3,6,7].includes(no));
   if(approve.disabled)area.insertAdjacentHTML("beforeend",'<p class="hint">'+
    (no===6?"尚未关联会务合同或会务发票原件，请先在材料中心上传对应原件。":
      "没有可识别的原件，无法提交核销结论；请补充 PDF/JPG/PNG 原件。")+'</p>');
  }catch(e){
   if(!closed)area.innerHTML='<div class="gate"><b>OCR扫描暂不可用</b>'+esc(e.message)+
    '。请检查服务器OCR配置或补充PDF/JPG/PNG原件。未生成比对报告，不能提交核销结论。</div>';
  }finally{busy=false;if(!closed)rescan.disabled=false;}
 };
 rescan.onclick=load;
 const judge=async(result)=>{
  if(!report||busy)return;
  if(result==="通过"&&(report.summary.mismatch||report.summary.uncertain)){
   if(!await confirmBox("智能比对存在"+report.summary.mismatch+"项不一致、"+report.summary.uncertain+
     "项无法自动确认。请先查看原件。确认已人工核对并判定通过吗？",{ok:"人工确认通过"}))return;
  }
  busy=true;approve.disabled=true;reject.disabled=true;rescan.disabled=true;
  try{
   const saved=await api.post("/api/projects/"+encodeURIComponent(pid)+"/verify/steps/"+no,{
    result,auto:true,scanToken:report.token
   });
   toast(saved.message||"已记录人工判定","ok");
   closed=true;m.classList.remove("open");
   await onDone?.();
  }catch(e){
   toast(e.message,"warn");
   if(e.code==="OCR_REPORT_STALE"||e.code==="OCR_EVIDENCE_REQUIRED"){
    area.insertAdjacentHTML("beforeend",'<div class="gate">原件已更新或识别依据不足，请重新扫描。</div>');
   }
  }finally{busy=false;if(!closed){approve.disabled=!report.total||(!report.scanned&&![3,6,7].includes(no));reject.disabled=false;rescan.disabled=false;}}
 };
 approve.onclick=()=>judge("通过");
 reject.onclick=()=>judge("不通过");
 await load();
}
