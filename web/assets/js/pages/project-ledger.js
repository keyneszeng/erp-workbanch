import {api,can} from "../lib/api.js";
import {esc,money,table,pager,bindPager,toast,badge} from "../lib/ui.js";

/**
 * 仅总管理员：依会议编号聚合原始合同、付款、发票资料、结算记录。
 * 不向其他角色发送/缓存财务汇总；服务端额外做 ledger:read 鉴权。
 */
const PAGE_SIZE=30;
let search="",page=1,selected="";
const selections=new WeakMap();
const num=v=>"¥"+money(v==null?0:v);
const balance=v=>Number(v)<0?'<span style="color:var(--red);font-weight:600">-¥'+money(Math.abs(Number(v)))+'</span>':num(v);
const td=s=>esc(s==null?"—":s);
const anchor=(pid)=>'<button class="link" data-open-ledger="'+esc(pid)+'">'+esc(pid)+'</button>';
const file=(row)=>row.file_key ?
  '<a class="link" href="/api/uploads/'+encodeURIComponent(row.file_key)+'" target="_blank" rel="noopener noreferrer">'+esc(row.file_name||"查看原件")+'</a>':"未关联文件";

export async function render(root,params=[]){
  if(!can("ledger:read")){
    root.innerHTML='<div class="panel">项目台账仅总管理员可以查看。</div>';return;
  }
  selected=params[0]||selected;
  const view={owners:new Set(),contacts:new Set(),revision:0,loadSeq:0,busy:false};
  selections.set(root,view);
  root.innerHTML='<div class="phead"><div><h2>项目台账</h2><p>唯一会议编号关联全流程财务资料 · 仅总管理员 · 只读对账</p></div></div>'+
    '<div class="panel"><div class="panel-h"><h2>按会议编号对照</h2></div>'+
    '<div class="filters"><input id="ledgerSearch" type="search" placeholder="会议编号 / 会议名称 / 协会 / 负责人" value="'+esc(search)+'">'+
    '<button class="btn btn-o" id="ledgerSearchBtn">搜索</button> <button class="btn btn-p" id="ledgerSum" disabled>汇总</button> <button class="btn btn-o" id="ledgerClearOwners" disabled>清除负责人勾选</button> <span class="hint" id="ledgerSelectedOwners" aria-live="polite">已选 0 位负责人</span></div>'+
    '<div class="filters" style="margin-top:6px"><button class="btn btn-p" id="ledgerContactSum" disabled>汇总外部联系人</button> <button class="btn btn-o" id="ledgerClearContacts" disabled>清除外部联系人勾选</button> <span class="hint" id="ledgerSelectedContacts" aria-live="polite">已选 0 位外部联系人</span></div>'+
    '<div id="ledgerOwnerSummary" aria-live="polite"></div><div id="ledgerContactSummary" aria-live="polite"></div><div id="ledgerList"></div></div>'+
    '<div id="ledgerDetail"></div>'+
    '<p class="foot-note">重要：项目台账直接读取原始业务表，不另外建账、不修改财务状态。发票号≠发票原件，现有厂家款类型≠真实厂家到账凭证；可用预算扣除税费管理费，结余按实际已付款实时计算，负数表示超预算。历史结算差异仍需人工复核。</p>';
  root.querySelector("#ledgerSearchBtn").onclick=()=>{search=root.querySelector("#ledgerSearch").value.trim();page=1;load(root)};
  root.querySelector("#ledgerSearch").onkeydown=e=>{if(e.key==="Enter"){search=e.target.value.trim();page=1;load(root)}};
  root.querySelector("#ledgerSum").onclick=()=>summarizeSelected(root);
  root.querySelector("#ledgerClearOwners").onclick=()=>{view.owners.clear();refreshSelection(root,true);};
  root.querySelector("#ledgerContactSum").onclick=()=>summarizeContacts(root);
  root.querySelector("#ledgerClearContacts").onclick=()=>{view.contacts.clear();refreshSelection(root,true);};
  await load(root);
}
function refreshSelection(root,changed=false){
  const view=selections.get(root);
  if(changed){view.revision++;root.querySelector("#ledgerOwnerSummary").innerHTML="";root.querySelector("#ledgerContactSummary").innerHTML="";}
  root.querySelectorAll("[data-ledger-owner]").forEach(el=>{el.checked=view.owners.has(Number(el.dataset.ledgerOwner));});
  root.querySelectorAll("[data-ledger-contact]").forEach(el=>{el.checked=view.contacts.has(el.dataset.ledgerContact);});
  root.querySelector("#ledgerSelectedOwners").textContent="已选 "+view.owners.size+" 位负责人";
  root.querySelector("#ledgerSelectedContacts").textContent="已选 "+view.contacts.size+" 位外部联系人";
  root.querySelector("#ledgerSum").disabled=view.busy||!view.owners.size;
  root.querySelector("#ledgerClearOwners").disabled=!view.owners.size;
  root.querySelector("#ledgerContactSum").disabled=view.busy||!view.contacts.size;
  root.querySelector("#ledgerClearContacts").disabled=!view.contacts.size;
}
async function summarizeSelected(root){
  const view=selections.get(root);
  if(!view.owners.size||view.busy)return;
  const rev=view.revision,ids=[...view.owners];
  view.busy=true;refreshSelection(root);
  const box=root.querySelector("#ledgerOwnerSummary");
  box.innerHTML='<p class="hint" style="padding:0 16px">正在汇总所选负责人全部项目…</p>';
  try{
    const d=await api.post("/api/project-ledger/owner-summary",{owner_ids:ids});
    if(selections.get(root)!==view||view.revision!==rev)return;
    const t=d.total;
    box.innerHTML='<div style="padding:12px 16px"><p><strong>最终结余：'+balance(t.balance)+'</strong>　共 '+t.project_count+' 个项目 · '+d.owners.length+' 位负责人</p>'+
      '<p class="hint">汇总可用预算 '+num(t.available_budget)+' − 已付款 '+num(t.payment_paid)+'；包含所选负责人全部可见项目，不受搜索及分页限制。</p>'+
      table([{t:"负责人"},{t:"项目数",w:"90px"},{t:"可用预算"},{t:"已付款"},{t:"结余"}],d.owners.map(o=>({c:[td(o.owner),String(o.project_count),num(o.available_budget),num(o.payment_paid),balance(o.balance)]})),{empty:"所选负责人当前没有可汇总项目"})+'</div>';
  }catch(e){if(selections.get(root)===view&&view.revision===rev){box.innerHTML="";toast(e.message||"汇总失败","warn");}}
  finally{view.busy=false;if(selections.get(root)===view)refreshSelection(root);}
}
async function summarizeContacts(root){
  const view=selections.get(root);
  if(!view.contacts.size||view.busy)return;
  const rev=view.revision,names=[...view.contacts];
  view.busy=true;refreshSelection(root);
  const box=root.querySelector("#ledgerContactSummary");
  box.innerHTML='<p class="hint" style="padding:0 16px">正在汇总所选外部联系人全部项目…</p>';
  try{
    const d=await api.post("/api/project-ledger/external-contact-summary",{external_contacts:names});
    if(selections.get(root)!==view||view.revision!==rev)return;
    const t=d.total;
    box.innerHTML='<div style="padding:12px 16px"><p><strong>最终结余：'+balance(t.balance)+'</strong>　共 '+t.project_count+' 个项目 · '+d.contacts.length+' 位外部联系人</p>'+
      '<p class="hint">汇总可用预算 '+num(t.available_budget)+' − 已付款 '+num(t.payment_paid)+'；包含所选外部联系人全部可见项目，不受搜索及分页限制。</p>'+
      table([{t:"外部联系人"},{t:"项目数",w:"90px"},{t:"可用预算"},{t:"已付款"},{t:"结余"}],d.contacts.map(o=>({c:[td(o.external_contact),String(o.project_count),num(o.available_budget),num(o.payment_paid),balance(o.balance)]})),{empty:"所选外部联系人当前没有可汇总项目"})+'</div>';
  }catch(e){if(selections.get(root)===view&&view.revision===rev){box.innerHTML="";toast(e.message||"汇总失败","warn");}}
  finally{view.busy=false;if(selections.get(root)===view)refreshSelection(root);}
}
async function load(root){
  const view=selections.get(root),seq=++view.loadSeq;
  const qs=new URLSearchParams({q:search,page:String(page),size:String(PAGE_SIZE)});
  const data=await api.get("/api/project-ledger?"+qs);
  if(selections.get(root)!==view||seq!==view.loadSeq)return;
  const box=root.querySelector("#ledgerList");
  box.innerHTML=table(
    [{t:"会议编号",w:"150px"},{t:"会议名称"},{t:"协会"},{t:"会议预算",w:"115px"},{t:"可用预算",w:"115px"},{t:"合同总额",w:"110px"},
      {t:"已付款",w:"110px"},{t:"结余",w:"110px"},{t:"负责人",w:"100px"},{t:"外部联系人",w:"110px"}],
    data.rows.map(x=>({c:[
      anchor(x.meeting_no),td(x.project_name),td(x.association),
      num(x.financial_summary.budget),num(x.financial_summary.available_budget),num(x.financial_summary.contract_total),
      num(x.financial_summary.payment_paid),
      balance(x.financial_summary.balance),
      td(x.owner||"—")+(Number.isSafeInteger(Number(x.owner_id))&&Number(x.owner_id)>0?' <input type="checkbox" style="vertical-align:middle" data-ledger-owner="'+Number(x.owner_id)+'" aria-label="汇总负责人 '+esc(x.owner||"")+' 的全部项目"'+(view.owners.has(Number(x.owner_id))?" checked":"")+'>':' <input type="checkbox" disabled title="未关联负责人账号，无法汇总" aria-label="未关联负责人账号">'),
      td(x.external_contact||"—")+(String(x.external_contact||"").trim()?' <input type="checkbox" style="vertical-align:middle" data-ledger-contact="'+esc(x.external_contact)+'" aria-label="汇总外部联系人 '+esc(x.external_contact)+' 的全部项目"'+(view.contacts.has(x.external_contact)?" checked":"")+'>':' <input type="checkbox" disabled title="未登记外部联系人，无法汇总" aria-label="未登记外部联系人">')
    ]})),{empty:"当前没有会议项目"}
  )+pager(data,{unit:"个项目"});
  box.querySelectorAll("[data-open-ledger]").forEach(el=>el.onclick=()=>open(root,el.dataset.openLedger));
  box.querySelectorAll("[data-ledger-owner]").forEach(el=>el.onchange=()=>{
    const id=Number(el.dataset.ledgerOwner);
    if(el.checked)view.owners.add(id);else view.owners.delete(id);
    refreshSelection(root,true);
  });
  box.querySelectorAll("[data-ledger-contact]").forEach(el=>el.onchange=()=>{
    const name=el.dataset.ledgerContact;
    if(el.checked)view.contacts.add(name);else view.contacts.delete(name);
    refreshSelection(root,true);
  });
  refreshSelection(root);
  bindPager(box,n=>{page=n;load(root)});
  if(selected)await open(root,selected);
}
async function open(root,pid){
  selected=pid;
  const d=await api.get("/api/project-ledger/"+encodeURIComponent(pid));
  const s=d.financial_summary;
  const payments=d.payments.map(x=>({c:[
    td(x.id),td(x.type),td(x.payee),num(x.amount),td(x.invoice_no),badge(x.status),
    td(x.paid_at||"未完成")
  ]}));
  const contracts=d.contracts.map(x=>({c:[
    td(x.id),td(x.name),td(x.vendor),num(x.amount),badge(x.status),file(x)
  ]}));
  const docs=d.financial_materials.map(x=>({c:[
    td(x.id),td(x.kind),td(x.name),td(x.version),file(x)
  ]}));
  const kpis=[
    ["会议预算",s.budget],["可用预算",s.available_budget],["合同总额",s.contract_total],["已签署合同",s.signed_contracts],
    ["已付款",s.payment_paid],["待审批/待付款",s.payment_pending],
    ["结算支出",s.settlement_expense],["结余",s.balance]
  ];
  const box=root.querySelector("#ledgerDetail");
  box.innerHTML='<div class="panel mt">'+
    '<div class="panel-h"><div><h2>项目对照 · '+esc(d.meeting_no)+'</h2><p class="hint">'+esc(d.project_name)+' · '+esc(d.association)+' · '+esc(d.project_status)+' · 负责人：'+td(d.owner||"—")+'</p></div>'+
    '<div class="acts"><button class="btn btn-o" id="ledgerGoProject">会议项目</button> <button class="btn btn-p" id="ledgerCsv">导出项目台账 CSV</button></div></div>'+
    '<div class="grid g4">'+kpis.map(x=>'<div class="kpi"><div class="t">'+esc(x[0])+'</div><div class="v">'+(x[0]==="结余"?balance(x[1]):x[1]===null?"—":num(x[1]))+'</div></div>').join("")+'</div><p class="hint" style="margin-top:10px">可用预算 = 会议预算 ×（1 − 税费管理费率）；结余 = 可用预算 − 已付款。负数表示超预算。</p>'+
    '<h3 style="margin:22px 0 10px">分类付款对照</h3>'+
    '<p class="hint">专家劳务费对应原付款单类型「专家费」；按实际付款单汇总，不把合同报酬或待审批款视为已付款。</p>'+
    table([{t:"付款类型"},{t:"单据数"},{t:"有效申请金额"},{t:"已付款金额"}],
      d.payment_types.map(x=>({c:[td(x.type),String(x.count),num(x.applied),num(x.paid)]})),{empty:"无付款"})+
    '<h3 style="margin:22px 0 10px">合同原始记录</h3>'+
    table([{t:"合同编号"},{t:"合同名称"},{t:"签约方"},{t:"合同金额"},{t:"状态"},{t:"合同原件"}],contracts,{empty:"暂无合同"})+
    '<h3 style="margin:22px 0 10px">付款及发票号码记录</h3>'+
    table([{t:"付款单号"},{t:"类型"},{t:"收款方"},{t:"金额"},{t:"发票号（非原件）"},{t:"状态"},{t:"付款时间"}],payments,{empty:"暂无付款"})+
    '<h3 style="margin:22px 0 10px">财务资料附件与归档对照</h3>'+
    '<p class="hint">合同原件 '+d.document_coverage.contract_original_files+'/'+d.document_coverage.contracts+
    ' · 发票号 '+d.document_coverage.invoice_numbers+' · 已关联发票原件 '+d.document_coverage.invoice_original_files+
    ' · 厂家/付款凭证文件 '+d.document_coverage.payment_voucher_files+'</p>'+
    table([{t:"材料ID"},{t:"材料类别"},{t:"资料名称"},{t:"版本"},{t:"原件"}],docs,{empty:"暂无已关联的财务资料"})+
    '<h3 style="margin:22px 0 10px">结算单</h3>'+
    (d.settlement?'<p>结算编号 <strong>'+td(d.settlement.id)+'</strong>　项目预算 '+num(d.settlement.income)+
      '　可用预算 '+num(d.settlement.available_budget)+'　支出 '+num(d.settlement.expense)+'　结算结余 '+balance(d.settlement.profit)+'</p>':'<p class="hint">本项目尚未生成结算单。</p>')+
    '<h3 style="margin:22px 0 10px">核对提醒</h3>'+
    (d.warnings.length?'<div class="gate">'+d.warnings.map(x=>'<p>• '+esc(x)+'</p>').join("")+'</div>':
      '<p class="hint">目前没有自动识别的差异；不代表已完成逐票人工核销。</p>')+
    '<p class="hint">'+d.notes.map(esc).join("　")+'</p></div>';
  box.querySelector("#ledgerGoProject").onclick=()=>{location.hash="#/projects/"+encodeURIComponent(pid)};
  box.querySelector("#ledgerCsv").onclick=async()=>{try{
    const file=await api.download("/api/project-ledger/"+encodeURIComponent(pid)+"/export");
    toast("台账已导出："+file.name,"ok");
  }catch(err){toast(err.message||"导出失败","warn")}};
}
