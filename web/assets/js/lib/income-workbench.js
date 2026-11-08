import {api,can} from "./api.js";
import {esc,formHtml,readForm,validate,modal,toast,confirmBox,promptBox,money} from "./ui.js";
import {bindFilePicker,UPLOAD_ACCEPT,UPLOAD_TIP} from "./upload.js";
import {openSponsorRightsEditor} from "./sponsor-rights-editor.js";
let chosen="";
const yuan=n=>"¥"+money(n||0);
const link=k=>k?`<a class="link" href="/api/uploads/${encodeURIComponent(k)}" target="_blank" rel="noopener">点击原件查看</a>`:"未上传";
export async function renderIncomeWorkbench(root,projects,requested=""){
 if(!root)return;
 if(!projects.length){root.innerHTML='<div class="panel mt">暂无可管理会议收入的项目</div>';return;}
 if(requested&&projects.some(p=>p.id===requested))chosen=requested;
 if(!projects.some(p=>p.id===chosen))chosen=projects[0].id;
 const d=await api.get("/api/projects/"+encodeURIComponent(chosen)+"/income"),s=d.summary;
 const contractEdit=can("contract:write"),approve=can("contract:approve"),finance=can("payment:pay");
 root.innerHTML=`<section class="panel mt" aria-label="会议收入">
   <div class="panel-h"><h2>会议收入 · 企业赞助</h2><select id="income-project">
     ${projects.map(p=>`<option value="${esc(p.id)}" ${p.id===chosen?"selected":""}>${esc(p.name)}</option>`).join("")}
   </select></div>
   <div class="grid g4" style="padding:12px">
     <div class="kpi"><div class="t">会议预算／收入目标</div><div class="v">${yuan(s.budget)}</div></div>
     <div class="kpi k2"><div class="t">已确认赞助合同</div><div class="v">${yuan(s.contracted)}</div></div>
     <div class="kpi k3"><div class="t">实际到账</div><div class="v">${yuan(s.received)}</div></div>
     <div class="kpi k4"><div class="t">已开票</div><div class="v">${yuan(s.invoiced)}</div></div>
   </div>
   <div class="hint" style="padding:10px 16px">
     赞助合同距会议预算 ${yuan(s.contractGap)}；实际回款距预算 ${yuan(s.receiptGap)}。
     ${s.contractedMatchesBudget&&s.receiptsMatchBudget?"赞助合同与到账金额均已覆盖会议预算。":"未完全匹配会议预算，需继续补齐或走预算调整审批。"}
     企业赞助收入不计入会务支出合同总额。
   </div>
   <div class="panel-h"><h3>赞助合同</h3>${contractEdit?'<button id="income-add-contract" class="btn btn-p btn-sm">+ 登记企业赞助合同</button>':""}</div>
   <div class="tw"><table><thead><tr><th>企业 / 合同号</th><th>合同金额</th><th>状态</th><th>权益内容</th><th>合同原件</th><th>审批／后续</th></tr></thead>
   <tbody>${d.contracts.length?d.contracts.map(x=>`<tr><td>${esc(x.enterprise)}<div class="hint">${esc(x.contract_no)}</div></td>
     <td>${yuan(x.amount)}</td><td>${esc(x.status)}</td>
     <td><b>${d.rights.filter(r=>r.sponsor_id===x.id).length} 项</b> · ${esc(x.rights_scan_status||"未识别")}
       <div class="hint">${esc(x.rights_scan_note||"")}</div>
       ${d.rights.filter(r=>r.sponsor_id===x.id).map(r=>`<div class="hint">${esc(r.category)} · ${r.confirmed?"已确认":"待校正"}</div>`).join("")}
       ${contractEdit&&x.status!=="已驳回"?`<button class="link" data-rights-edit="${esc(x.id)}">校对 / 自定义权益</button>`:""}</td><td>${link(x.file_key)}</td>
     <td>${x.status==="待确认"&&approve?`<button class="link" data-sponsor-approve="${esc(x.id)}">确认合同</button>
        <button class="link danger" data-sponsor-reject="${esc(x.id)}">驳回</button>`:""}
       ${x.status==="已签署"&&finance?`<button class="link" data-sponsor-receipt="${esc(x.id)}">登记回款</button>
        <button class="link" data-sponsor-invoice="${esc(x.id)}">登记开票</button>`:""}</td></tr>`).join(""):'<tr><td colspan="6">暂无企业赞助合同</td></tr>'}</tbody></table></div>
   <div class="panel-h"><h3>到账凭证</h3></div>
   <div class="tw"><table><thead><tr><th>到账日期</th><th>关联合同</th><th>流水编号</th><th>到账金额</th><th>银行凭证</th></tr></thead><tbody>
   ${d.receipts.length?d.receipts.map(x=>`<tr><td>${esc(x.received_date)}</td><td>${esc(x.sponsor_id)}</td><td>${esc(x.payment_ref)}</td>
     <td>${yuan(x.amount)}</td><td>${link(x.file_key)}</td></tr>`).join(""):'<tr><td colspan="5">暂无到账记录</td></tr>'}</tbody></table></div>
   <div class="panel-h"><h3>已开具发票</h3></div>
   <div class="tw"><table><thead><tr><th>开票日期</th><th>关联合同</th><th>发票号码</th><th>开票金额</th><th>发票原件</th></tr></thead><tbody>
   ${d.invoices.length?d.invoices.map(x=>`<tr><td>${esc(x.issued_date)}</td><td>${esc(x.sponsor_id)}</td><td>${esc(x.invoice_no)}</td>
     <td>${yuan(x.amount)}</td><td>${link(x.file_key)}</td></tr>`).join(""):'<tr><td colspan="5">暂无开票记录</td></tr>'}</tbody></table></div>
 </section>`;
 root.querySelector("#income-project").onchange=e=>{chosen=e.target.value;renderIncomeWorkbench(root,projects).catch(err=>toast(err.message,"warn"));};
 root.querySelector("#income-add-contract")?.addEventListener("click",()=>formIncome(root,projects,"contract"));
 root.querySelectorAll("[data-rights-edit]").forEach(b=>b.onclick=()=>openSponsorRightsEditor(root,projects,chosen,d,b.dataset.rightsEdit,renderIncomeWorkbench));
 root.querySelectorAll("[data-sponsor-approve]").forEach(b=>b.onclick=async()=>{
   try{const id=b.dataset.sponsorApprove;const ok=await confirmBox("确认该赞助合同已完成签署且金额与会议预算计划一致？",{ok:"确认签署"});
     if(!ok)return;await api.post("/api/projects/"+chosen+"/income/contracts/"+id+"/decide",{approve:true});
     toast("赞助合同已确认","ok");await renderIncomeWorkbench(root,projects);}catch(e){toast(e.message,"warn");}
 });
 root.querySelectorAll("[data-sponsor-reject]").forEach(b=>b.onclick=async()=>{
   const id=b.dataset.sponsorReject;
   const reason=await promptBox({title:"驳回赞助合同",label:"驳回理由",ok:"确认驳回"});
   if(!reason)return;
   try{await api.post("/api/projects/"+chosen+"/income/contracts/"+id+"/decide",{approve:false,reason});
     toast("合同已驳回","ok");await renderIncomeWorkbench(root,projects);}catch(e){toast(e.message,"warn");}
 });
 root.querySelectorAll("[data-sponsor-receipt]").forEach(b=>b.onclick=()=>formIncome(root,projects,"receipt",b.dataset.sponsorReceipt));
 root.querySelectorAll("[data-sponsor-invoice]").forEach(b=>b.onclick=()=>formIncome(root,projects,"invoice",b.dataset.sponsorInvoice));
}
function formIncome(root,projects,type,sponsorId=""){
 const pid=chosen;
 const defs={
  contract:{title:"企业赞助合同录入",url:"contracts",fields:[
    {k:"enterprise",l:"赞助企业名称",req:1},
    {k:"amount",l:"赞助合同金额（元）",t:"number",req:1}]},
  receipt:{title:"登记到账凭证",url:"receipts",fields:[
    {k:"amount",l:"实际到账金额（元）",t:"number",req:1},{k:"paymentRef",l:"银行回款流水号",req:1},
    {k:"receivedDate",l:"到账日期",t:"date",req:1}]},
  invoice:{title:"登记开具发票",url:"invoices",fields:[
    {k:"amount",l:"开票金额（元）",t:"number",req:1},{k:"invoiceNo",l:"发票号码",req:1},
    {k:"issuedDate",l:"开票日期",t:"date",req:1}]}
 };
 const cfg=defs[type],isContract=type==="contract";
 const fields=[
   ...cfg.fields,
   ...(isContract?[{k:"rightsCategories",l:"权益内容（每行一项，识别后可修改）",t:"textarea",rows:4,
     ph:"主会场背景板 LOGO 露出\n企业展位展示",full:1}]:[]),
   {k:"file",l:isContract?"上传赞助合同文件（必需）":"佐证原件（必需）",t:"file",full:1,
     accept:UPLOAD_ACCEPT,tip:UPLOAD_TIP+(isContract?" PDF / JPG / PNG 可通过 OCR 识别；DOCX 支持原生文本提取。":" 必须上传可核对的回款或开票原件。")}
 ];
 const extra=isContract?
   '<div class="hint" style="margin-bottom:12px">请先上传合同，系统将尝试识别赞助企业名称、合同金额与权益内容，并自动填入供您核对。金额与权益以合同原件为准。</div>'+
   '<div class="fld" style="margin-bottom:10px"><label>合同编号（系统自动生成）</label><input value="提交后自动生成 SC-年份-流水号" readonly disabled></div>':"";
 const scanHint=isContract?'<div class="hint" data-sponsor-scan aria-live="polite" style="padding:10px 0">等待上传合同文件后开始识别。</div>':"";
 const modalEl=modal({title:cfg.title,width:"640px",body:extra+formHtml(fields)+scanHint,
   footer:'<button class="btn btn-o" data-cancel>取消</button><button class="btn btn-p" data-save>提交</button>'});
 let picked=null,uploaded=null,sequence=0,scanning=false;
 const saveBtn=modalEl.querySelector("[data-save]");
 const scanStatus=modalEl.querySelector("[data-sponsor-scan]");
 const showStatus=text=>{if(scanStatus)scanStatus.textContent=text;};
 bindFilePicker(modalEl,"file",(file,err)=>{
   const token=++sequence;
   picked=err?null:file;uploaded=null;
   if(err){toast(err,"warn");showStatus(err);return;}
   if(!isContract||!picked)return;
   scanning=true;saveBtn.disabled=true;
   showStatus("正在上传合同文件并进行 OCR / 文本识别…");
   (async()=>{
     const saved=await api.upload(picked,{pid});
     if(token!==sequence)return;
     uploaded=saved;
     const result=await api.post("/api/projects/"+encodeURIComponent(pid)+"/income/contracts/scan",{file_key:saved.key});
     if(token!==sequence)return;
     const data=result.fields||{};
     const enterprise=modalEl.querySelector('[name="enterprise"]');
     const amount=modalEl.querySelector('[name="amount"]');
     const rights=modalEl.querySelector('[name="rightsCategories"]');
     if(data.enterprise&&enterprise)enterprise.value=data.enterprise;
     if(data.amount!==null&&data.amount!==undefined&&amount)amount.value=String(data.amount);
     if(Array.isArray(data.rightsContent)&&data.rightsContent.length&&rights)
       rights.value=data.rightsContent.join("\n");
     showStatus(result.note||"识别完成，请核对合同原件。");
   })().catch(e=>{
     if(token===sequence)showStatus("自动识别失败："+e.message+"。可按合同原件人工填写后提交。");
   }).finally(()=>{
     if(token===sequence){scanning=false;saveBtn.disabled=false;}
   });
 });
 modalEl.querySelector("[data-cancel]").onclick=()=>{sequence++;modalEl.classList.remove("open");};
 saveBtn.onclick=async()=>{
   if(scanning){toast("合同仍在扫描中，请核对识别结果后提交","warn");return;}
   if(!validate(modalEl,fields))return;
   if(!picked){toast("必须上传可核对的真实原件","warn");return;}
   saveBtn.disabled=true;
   try{
     const values=readForm(modalEl);
     const saved=uploaded||await api.upload(picked,{pid});
     const body={...values,file_key:saved.key,file_name:saved.name,...(sponsorId?{sponsorId}:{})};
     if(isContract){
       // 自动提取内容只是草稿，必须经后续“确认权益内容”操作才算已核实。
       const draft=String(body.rightsCategories||"").split(/[\n；;]+/).map(x=>x.trim()).filter(Boolean);
       if(draft.length)body.rightsCategories=draft;
       else delete body.rightsCategories;
     }
     const result=await api.post("/api/projects/"+encodeURIComponent(pid)+"/income/"+cfg.url,body);
     toast(isContract?"合同 "+result.contractNo+" 已登记，请确认权益内容":"收入资料已登记","ok");
     modalEl.classList.remove("open");
     await renderIncomeWorkbench(root,projects,pid);
     if(isContract){
       const data=await api.get("/api/projects/"+encodeURIComponent(pid)+"/income");
       openSponsorRightsEditor(root,projects,pid,data,result.id,renderIncomeWorkbench);
     }
   }catch(e){toast(e.message,"warn");saveBtn.disabled=false;}
 };
}
