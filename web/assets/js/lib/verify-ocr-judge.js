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
   '<button class="btn btn-o" data-manual-mode>人工核验</button>'+
   '<button class="btn btn-o" data-reject disabled>人工判定不通过</button>'+
   '<button class="btn btn-p" data-approve disabled>人工判定通过</button>'
 });
 const area=m.querySelector("[data-scan-result]");
 const approve=m.querySelector("[data-approve]");
 const reject=m.querySelector("[data-reject]");
 const rescan=m.querySelector("[data-rescan]");
 const close=m.querySelector('[data-x="0"]');
 let report=null,busy=false,closed=false,manualMode=false,scanError="";
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

 const manualModeBtn=m.querySelector("[data-manual-mode]");
 const setManualMode=value=>{
  manualMode=value;
  approve.hidden=value;
  reject.hidden=value;
  manualModeBtn.textContent=value?"返回OCR结果":"人工核验";
  manualModeBtn.disabled=value&&!report;
 };
 const manualKinds={
  1:["会议通知","招商函","串场","终版议程"],
  2:["终版议程","讲者照片"],
  3:["签到表"],
  4:["终版议程","课件","串场课件","串场"],
  5:["劳务表","劳务登记表","劳务收集表","劳务专家合同","专家劳务合同","劳务合同","专家合同","合同"],
  6:["合同","会务协议","会务发票","发票"],
  7:["权益照片"]
 };
 const manualSources=()=>{
  const kinds=new Set(manualKinds[no]||[]);
  const rows=(d.materials||[]).filter(x=>kinds.has(x.kind)&&x.file_key);
  if(no===5||no===6){
   for(const c of d.contracts||[]){
    if(!c.file_key)continue;
    if(no===5&&c.category!=="劳务专家")continue;
    if(no===6&&c.category!=="会务需求")continue;
    rows.push({kind:c.category||"合同",name:c.name||c.vendor,file_key:c.file_key,file_name:c.file_name||c.name});
   }
  }
  if(no===7)for(const c of d.sponsorRights?.contracts||[]){
   if(c.file_key)rows.push({kind:"赞助合同",name:c.enterprise||c.id,file_key:c.file_key,file_name:c.file_name});
  }
  const seen=new Set();
  return rows.filter(x=>{const k=String(x.file_key||"");if(!k||seen.has(k))return false;seen.add(k);return true;});
 };
 const manualCheck=(key,label)=>'<label style="display:flex;gap:8px;align-items:flex-start;margin:9px 0"><input type="checkbox" data-manual-check="'+key+'" style="margin-top:3px"> <span>'+esc(label)+'</span></label>';
 const renderManualPanel=reason=>{
  const docs=manualSources();
  const sourceHtml=docs.length?'<div class="panel" style="padding:12px;margin:10px 0"><b>请逐一打开并核对原件</b>'+
   docs.map(x=>'<div class="hint" style="padding:5px 0">'+esc((x.kind||"材料")+" · "+(x.name||x.file_name||"原件"))+
    '　<a class="link" href="/api/uploads/'+encodeURIComponent(x.file_key)+'" data-view="'+esc(x.file_key)+
    '" data-view-name="'+esc(x.file_name||x.name||"原件")+'">查看原件</a></div>').join("")+
   '</div>':'<div class="gate">当前没有找到本步骤对应的已上传原件，请先补齐原件后再人工核验。</div>';
  let checks="";
  let extra="";
  if(no===1){
   const kinds=[...new Set((d.materials||[]).filter(x=>["会议通知","招商函"].includes(x.kind)&&x.file_key).map(x=>x.kind))];
   const options=(kinds.length?kinds:["会议通知","招商函"]).map(k=>'<option value="'+esc(k)+'">'+esc(k)+'</option>').join("");
   extra='<div class="fld"><label>本次核对的盖章函件</label><select data-manual-document>'+options+'</select></div>'+
    manualCheck("stampedFinal","确认会议通知/招商函已盖章，且为终版")+
    manualCheck("letterMatchesHost","确认函件与串场中的会议名称、日期、主办方一致")+
    manualCheck("agendaMatches","确认函件、串场与当前终版议程内容一致");
  }else if(no===2){
   checks=manualCheck("photosMatchAgenda","确认每张讲者照片文件名对应的姓名，均能在当前终版议程中找到");
  }else if(no===3){
   const form=String(d.project?.form||"");
   if(["线上","混合"].includes(form))extra='<div class="fld"><label>讲者有效在线时长（分钟，必须大于30）</label><input type="number" min="31" step="1" data-manual-online-minutes placeholder="填写核对后的分钟数"></div>';
   if(["线下","混合"].includes(form))checks=manualCheck("signedAttendance","确认已查看签到表原件，签到记录符合要求");
  }else if(no===4){
   checks=manualCheck("courseTopicsMatch","确认已逐项核对课件主题，所有课件主题均包含在当前终版议程中");
  }else if(no===5){
   checks=manualCheck("laborFieldsMatch","确认已逐人核对劳务表与劳务专家合同的姓名、时间、角色、金额及银行账号");
   extra+='<p class="hint">人工核验通过不会自动提取或保存银行账号；后续付款仍按财务付款流程核对收款信息。</p>';
  }else if(no===6){
   checks=manualCheck("demandReviewed","确认已查看并核对会务需求表")+
    manualCheck("meetingContractReviewed","确认已查看已签署会务合同/会务协议原件")+
    manualCheck("meetingInvoiceReviewed","确认已查看会务发票原件");
  }else if(no===7){
   const rights=d.sponsorRights?.requiredRights||[];
   checks=rights.map(x=>'<label style="display:flex;gap:8px;align-items:flex-start;margin:9px 0"><input type="checkbox" data-manual-right="'+Number(x.id)+'" style="margin-top:3px"> <span>已核对权益：'+esc(x.category||"未命名权益")+'</span></label>').join("");
   if(!rights.length)checks='<p class="hint">未找到可人工确认的已签赞助合同权益项目。</p>';
  }
  area.innerHTML=(reason?'<div class="gate" style="margin-bottom:12px"><b>OCR扫描未完成</b>'+esc(reason)+
   '。现在可直接人工核验，无需等待OCR恢复；人工通过不会伪造OCR报告。</div>':
   '<div class="gate" style="margin-bottom:12px"><b>人工核验模式</b>请打开本步骤相关原件，按核对要点逐项检查。人工结论会明确记录为“未使用OCR”。</div>')+
   sourceHtml+'<div class="panel" style="padding:12px"><b>人工核对清单</b>'+extra+checks+
   manualCheck("manualConfirmed","我已逐一查看本步骤相关原件，并确认以上核对项真实、完整")+
   '<div class="fld" style="margin-top:12px"><label>人工核验说明（至少10个字）</label>'+
   '<textarea rows="3" data-manual-note placeholder="说明核对了哪些原件、关键内容是否一致，以及需要说明的差异处理情况"></textarea></div>'+
   '<div class="acts" style="justify-content:flex-end;margin-top:12px">'+
   '<button class="btn btn-o" data-manual-reject>人工判定不通过</button>'+
   '<button class="btn btn-p" data-manual-pass>人工判定通过</button></div></div>';
  setManualMode(true);
  area.querySelector("[data-manual-pass]").onclick=()=>manualJudge("通过");
  area.querySelector("[data-manual-reject]").onclick=()=>manualJudge("不通过");
 };
 const manualJudge=async result=>{
  if(busy||closed)return;
  const note=String(area.querySelector("[data-manual-note]")?.value||"").trim();
  if(note.length<10){toast("人工核验说明至少填写10个字","warn");return;}
  const checked=key=>area.querySelector('[data-manual-check="'+key+'"]')?.checked===true;
  const evidence={manualConfirmed:checked("manualConfirmed"),manualNote:note};
  if(no===1){
   evidence.documentKind=area.querySelector("[data-manual-document]")?.value||"";
   evidence.stampedFinal=checked("stampedFinal");
   evidence.letterMatchesHost=checked("letterMatchesHost");
   evidence.agendaMatches=checked("agendaMatches");
  }else if(no===2)evidence.photosMatchAgenda=checked("photosMatchAgenda");
  else if(no===3){
   evidence.onlineMinutes=Number(area.querySelector("[data-manual-online-minutes]")?.value||0);
   evidence.signedAttendance=checked("signedAttendance");
  }else if(no===4)evidence.courseTopicsMatch=checked("courseTopicsMatch");
  else if(no===5)evidence.laborFieldsMatch=checked("laborFieldsMatch");
  else if(no===6){
   evidence.demandReviewed=checked("demandReviewed");
   evidence.meetingContractReviewed=checked("meetingContractReviewed");
   evidence.meetingInvoiceReviewed=checked("meetingInvoiceReviewed");
  }else if(no===7){
   evidence.verifiedRights=[...area.querySelectorAll("[data-manual-right]:checked")].map(x=>Number(x.getAttribute("data-manual-right")));
  }
  if(result==="通过"&&!evidence.manualConfirmed){toast("请先勾选人工核验确认项","warn");return;}
  busy=true;rescan.disabled=true;manualModeBtn.disabled=true;
  area.querySelectorAll("[data-manual-pass],[data-manual-reject]").forEach(x=>x.disabled=true);
  try{
   const saved=await api.post("/api/projects/"+encodeURIComponent(pid)+"/verify/steps/"+no,{
    result,manual:true,evidence,remark:note
   });
   toast(saved.message||"已记录人工核验结论","ok");
   closed=true;m.classList.remove("open");
   await onDone?.();
  }catch(e){
   toast(e.message,"warn");
   area.insertAdjacentHTML("beforeend",'<div class="gate">'+esc(e.message)+'</div>');
  }finally{
   busy=false;
   if(!closed){rescan.disabled=false;manualModeBtn.disabled=!report;}
  }
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
  busy=true;report=null;scanError="";setManualMode(false);
  approve.disabled=true;reject.disabled=true;rescan.disabled=true;manualModeBtn.disabled=true;
  area.innerHTML='<p class="hint">正在扫描原件并比对，未识别或无法判断的项目会明确提示，不会自动标记通过。</p>';
  try{
   const x=await api.post("/api/projects/"+encodeURIComponent(pid)+"/verify/steps/"+no+"/scan",{});
   if(closed)return;
   report=x.report;
   show(report);
   setManualMode(false);
   reject.disabled=false;
   // 无可用OCR资料不能以“智能自动比对”名义直接确认通过；第三/六/七项需人工检查原件。
   // 第6步是原件关联核对（需求表预算=会务合同总额+已关联发票），本就不做OCR，
   // 不能因为 scanned=0 把「人工判定通过」永久置灰。
   approve.disabled=!report.total||(!report.scanned&&![3,6,7].includes(no));
   if(approve.disabled)area.insertAdjacentHTML("beforeend",'<p class="hint">自动识别未取得足够依据。可点击“人工核验”，打开原件后逐项核对并提交人工结论。</p>');
  }catch(e){
   scanError=e.message||"扫描请求失败";
   if(!closed)renderManualPanel(scanError);
  }finally{busy=false;if(!closed){rescan.disabled=false;manualModeBtn.disabled=!report;}}
 };
 rescan.onclick=load;
 manualModeBtn.onclick=()=>{
  if(busy||closed)return;
  if(manualMode&&report){show(report);setManualMode(false);return;}
  renderManualPanel(scanError);
 };
 const judge=async(result)=>{
  if(!report||busy||manualMode)return;
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
  }finally{busy=false;if(!closed){approve.disabled=!report.total||(!report.scanned&&![3,6,7].includes(no));reject.disabled=false;rescan.disabled=false;manualModeBtn.disabled=false;}}
 };
 approve.onclick=()=>judge("通过");
 reject.onclick=()=>judge("不通过");
 await load();
}
