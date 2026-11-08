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
 const fmtStatus=x=>x==="一致"?"<span class='badge b-green'>一致</span>":
   x==="不一致"?"<span class='badge b-red'>不一致</span>":"<span class='badge b-orange'>无法自动确认</span>";
 const sourceLink=file=>{
  const key=(d.materials||[]).find(x=>Number(x.id)===Number(file.materialId))?.file_key||
    (d.sponsorRights?.photos||[]).find(x=>Number(x.id)===Number(file.materialId))?.file_key;
  return key?'<a class="link" href="/api/uploads/'+encodeURIComponent(key)+'" target="_blank" rel="noopener">查看原件</a>':"";
 };
 const show=r=>{
  const n=r.summary;
  const fileRows=(r.files||[]).map(f=>
   '<div style="border-bottom:1px solid var(--line);padding:8px 0">'+
    '<b>'+esc(f.kind+" · "+f.name)+'</b>　'+sourceLink(f)+
    '<div class="hint">'+(f.state==="recognized"?"已识别 "+f.pages+"/"+f.totalPages+" 页":
      f.state==="unsupported"?"格式不支持直接OCR":"识别失败或内容为空")+
      (f.truncated?" · 有未扫描页":"")+'</div>'+
    (f.preview?'<div class="hint" style="overflow-wrap:anywhere">识别摘录：'+esc(f.preview)+'</div>':"")+'</div>'
  ).join("");
  const rows=(r.checks||[]).map(x=>'<div style="border-bottom:1px solid var(--line);padding:9px 0">'+
    '<div style="display:flex;gap:8px;align-items:center;justify-content:space-between"><b>'+esc(x.name)+'</b>'+fmtStatus(x.status)+'</div>'+
    '<div class="hint" style="margin-top:4px">'+esc(x.detail)+'</div></div>').join("");
  area.innerHTML='<div class="grid g3" style="margin-bottom:12px">'+
    '<div class="kpi k2"><div class="t">OCR识别原件</div><div class="v">'+r.scanned+'/'+r.total+'</div></div>'+
    '<div class="kpi k3"><div class="t">自动比对一致</div><div class="v">'+n.match+'</div></div>'+
    '<div class="kpi k4"><div class="t">异常/待确认</div><div class="v">'+(n.mismatch+n.uncertain)+'</div></div></div>'+
    '<div class="panel" style="padding:12px;margin-bottom:12px"><b>智能比对结果</b>'+rows+'</div>'+
    '<details><summary>查看识别文件和OCR摘录（'+r.files.length+'份）</summary>'+
      '<div style="max-height:220px;overflow:auto;padding:6px">'+(fileRows||"没有可比对原件")+'</div></details>'+
    '<p class="hint" style="margin-top:12px">'+esc(r.warning)+'</p>'+
    (no===5?'<p class="hint">劳务银行账户不从OCR自动导入付款系统；付款前仍须独立确认收款信息。</p>':"");
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
   // 无可用OCR资料不能以“智能自动比对”名义直接确认通过；第三/七项需人工检查原件。
   approve.disabled=!report.total||(!report.scanned&&![3,7].includes(no));
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
  }finally{busy=false;if(!closed){approve.disabled=!report.total||(!report.scanned&&![3,7].includes(no));reject.disabled=false;rescan.disabled=false;}}
 };
 approve.onclick=()=>judge("通过");
 reject.onclick=()=>judge("不通过");
 await load();
}
