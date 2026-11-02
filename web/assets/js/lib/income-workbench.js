import {api,can} from "./api.js";
import {esc,formHtml,readForm,validate,modal,toast,confirmBox,promptBox,money} from "./ui.js";
import {bindFilePicker} from "./upload.js";
import {fileLink} from "./file-preview.js";
let chosen="";
const yuan=n=>"¥"+money(n||0);
const link=k=>fileLink(k,"","在线查看原件");
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
   <div class="tw"><table><thead><tr><th>企业 / 合同号</th><th>合同金额</th><th>状态</th><th>合同原件</th><th>审批／后续</th></tr></thead>
   <tbody>${d.contracts.length?d.contracts.map(x=>`<tr><td>${esc(x.enterprise)}<div class="hint">${esc(x.contract_no)}</div></td>
     <td>${yuan(x.amount)}</td><td>${esc(x.status)}</td><td>${link(x.file_key)}</td>
     <td>${x.status==="待确认"&&approve?`<button class="link" data-sponsor-approve="${esc(x.id)}">确认合同</button>
        <button class="link danger" data-sponsor-reject="${esc(x.id)}">驳回</button>`:""}
       ${x.status==="已签署"&&finance?`<button class="link" data-sponsor-receipt="${esc(x.id)}"
          data-contract-no="${esc(x.contract_no)}" data-enterprise="${esc(x.enterprise)}">登记回款</button>
        <button class="link" data-sponsor-invoice="${esc(x.id)}"
          data-contract-no="${esc(x.contract_no)}" data-enterprise="${esc(x.enterprise)}">登记开票</button>`:""}</td></tr>`).join(""):'<tr><td colspan="5">暂无企业赞助合同</td></tr>'}</tbody></table></div>
   <div class="panel-h"><h3>到账凭证</h3></div>
   <div class="tw"><table><thead><tr><th>到账日期</th><th>关联合同</th><th>流水编号</th><th>到账金额</th><th>银行凭证</th></tr></thead><tbody>
   ${d.receipts.length?d.receipts.map(x=>`<tr><td>${esc(x.received_date)}</td><td>${esc(x.contract_no||x.sponsor_id)}<div class="hint">${esc(x.enterprise||"")}</div></td><td>${esc(x.payment_ref)}</td>
     <td>${yuan(x.amount)}</td><td>${link(x.file_key)}</td></tr>`).join(""):'<tr><td colspan="5">暂无到账记录</td></tr>'}</tbody></table></div>
   <div class="panel-h"><h3>已开具发票</h3></div>
   <div class="tw"><table><thead><tr><th>开票日期</th><th>关联合同</th><th>发票号码</th><th>开票金额</th><th>发票原件</th></tr></thead><tbody>
   ${d.invoices.length?d.invoices.map(x=>`<tr><td>${esc(x.issued_date)}</td><td>${esc(x.contract_no||x.sponsor_id)}<div class="hint">${esc(x.enterprise||"")}</div></td><td>${esc(x.invoice_no)}</td>
     <td>${yuan(x.amount)}</td><td>${link(x.file_key)}</td></tr>`).join(""):'<tr><td colspan="5">暂无开票记录</td></tr>'}</tbody></table></div>
 </section>`;
 root.querySelector("#income-project").onchange=e=>{chosen=e.target.value;renderIncomeWorkbench(root,projects).catch(err=>toast(err.message,"warn"));};
 root.querySelector("#income-add-contract")?.addEventListener("click",()=>formIncome(root,projects,"contract"));
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
 root.querySelectorAll("[data-sponsor-receipt]").forEach(b=>b.onclick=()=>formIncome(root,projects,"receipt",
   b.dataset.sponsorReceipt,b.dataset.contractNo,b.dataset.enterprise));
 root.querySelectorAll("[data-sponsor-invoice]").forEach(b=>b.onclick=()=>formIncome(root,projects,"invoice",
   b.dataset.sponsorInvoice,b.dataset.contractNo,b.dataset.enterprise));
}
function formIncome(root,projects,type,sponsorId="",contractNo="",enterprise=""){
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
 const cfg=defs[type];
 const fields=[...cfg.fields,{k:"file",l:"佐证原件（必需）",t:"file",full:1,
   accept:".jpg,.png,.pdf,.ppt,.pptx,.xlsx,.docx",tip:"必须上传合同原件、银行回款凭证或开票原件（单份≤50MB）"}];
 // 合同号由系统编排；回款/开票要明确显示关联的是哪份合同，避免录错
 const hint=type==="contract"
   ? `<div class="hint" style="margin-bottom:10px">合同编号由系统自动编排（SC-年份-序号），提交后生成；回款与发票都会自动带上同一个编号。</div>`
   : `<div class="hint" style="margin-bottom:10px">关联合同：<b>${esc(contractNo||sponsorId)}</b>${enterprise?` · ${esc(enterprise)}`:""}</div>`;
 const modalEl=modal({title:cfg.title,width:"640px",body:hint+formHtml(fields),
    footer:'<button class="btn btn-o" data-cancel>取消</button><button class="btn btn-p" data-save>提交</button>'});
 let picked=null;
 bindFilePicker(modalEl,"file",(f,err)=>{picked=err?null:f;if(err)toast(err,"warn");});
 modalEl.querySelector("[data-cancel]").onclick=()=>modalEl.classList.remove("open");
 modalEl.querySelector("[data-save]").onclick=async()=>{
   if(!validate(modalEl,fields))return;
   if(!picked){toast("必须上传可核对的真实原件","warn");return;}
   const btn=modalEl.querySelector("[data-save]");btn.disabled=true;
   try{
     const values=readForm(modalEl);
     const saved=await api.upload(picked,{pid:chosen});
     const body={...values,file_key:saved.key,file_name:saved.name,...(sponsorId?{sponsorId}:{})};
     const r=await api.post("/api/projects/"+chosen+"/income/"+cfg.url,body);
     toast(type==="contract"?`赞助合同已登记，合同编号 ${r.contractNo}`:"收入资料已登记","ok");
     modalEl.classList.remove("open");
     await renderIncomeWorkbench(root,projects);
   }catch(e){toast(e.message,"warn");btn.disabled=false;}
 };
}
