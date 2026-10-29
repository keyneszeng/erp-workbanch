import {api,state} from "../lib/api.js";
import {esc,money,table,pager,bindPager,toast,badge} from "../lib/ui.js";

/**
 * 仅总管理员：依会议编号聚合原始合同、付款、发票资料、结算记录。
 * 不向其他角色发送/缓存财务汇总；服务端额外做 ledger:read 鉴权。
 */
const PAGE_SIZE=30;
let search="",page=1,selected="";
const num=v=>"¥"+money(v==null?0:v);
const td=s=>esc(s==null?"—":s);
const anchor=(pid)=>'<button class="link" data-open-ledger="'+esc(pid)+'">'+esc(pid)+'</button>';
const file=(row)=>row.file_key ?
  '<a class="link" href="/api/uploads/'+encodeURIComponent(row.file_key)+'" target="_blank" rel="noopener noreferrer">'+esc(row.file_name||"查看原件")+'</a>':"未关联文件";

export async function render(root,params=[]){
  if(!state.super){
    root.innerHTML='<div class="panel">项目台账仅总管理员可以查看。</div>';return;
  }
  selected=params[0]||selected;
  root.innerHTML='<div class="phead"><div><h2>项目台账</h2><p>唯一会议编号关联全流程财务资料 · 仅总管理员 · 只读对账</p></div></div>'+
    '<div class="panel"><div class="panel-h"><h2>按会议编号对照</h2></div>'+
    '<div class="filters"><input id="ledgerSearch" type="search" placeholder="会议编号 / 会议名称 / 协会" value="'+esc(search)+'">'+
    '<button class="btn btn-o" id="ledgerSearchBtn">搜索</button></div><div id="ledgerList"></div></div>'+
    '<div id="ledgerDetail"></div>'+
    '<p class="foot-note">重要：项目台账直接读取原始业务表，不另外建账、不修改财务状态。发票号≠发票原件，现有厂家款类型≠真实厂家到账凭证；差额需要按实际业务口径人工复核。</p>';
  root.querySelector("#ledgerSearchBtn").onclick=()=>{search=root.querySelector("#ledgerSearch").value.trim();page=1;load(root)};
  root.querySelector("#ledgerSearch").onkeydown=e=>{if(e.key==="Enter"){search=e.target.value.trim();page=1;load(root)}};
  await load(root);
}
async function load(root){
  const qs=new URLSearchParams({q:search,page:String(page),size:String(PAGE_SIZE)});
  const data=await api.get("/api/project-ledger?"+qs);
  const box=root.querySelector("#ledgerList");
  box.innerHTML=table(
    [{t:"会议编号",w:"150px"},{t:"会议名称"},{t:"协会"},{t:"会议预算",w:"115px"},{t:"合同总额",w:"110px"},
      {t:"已付款",w:"110px"},{t:"结算支出",w:"110px"},{t:"提示",w:"65px"}],
    data.rows.map(x=>({c:[
      anchor(x.meeting_no),td(x.project_name),td(x.association),
      num(x.financial_summary.budget),num(x.financial_summary.contract_total),
      num(x.financial_summary.payment_paid),
      x.financial_summary.settlement_expense===null?"未生成":num(x.financial_summary.settlement_expense),
      '<span title="'+esc(x.warnings.join("；"))+'">'+x.warnings.length+' 项</span>'
    ]})),{empty:"当前没有会议项目"})
  )+pager(data,{unit:"个项目"});
  box.querySelectorAll("[data-open-ledger]").forEach(el=>el.onclick=()=>open(root,el.dataset.openLedger));
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
    ["预算",s.budget],["合同总额",s.contract_total],["已签署合同",s.signed_contracts],
    ["已付款",s.payment_paid],["待审批/待付款",s.payment_pending],
    ["结算支出",s.settlement_expense],["结算与付款差额",s.settlement_vs_paid]
  ];
  const box=root.querySelector("#ledgerDetail");
  box.innerHTML='<div class="panel mt">'+
    '<div class="panel-h"><div><h2>项目对照 · '+esc(d.meeting_no)+'</h2><p class="hint">'+esc(d.project_name)+' · '+esc(d.association)+' · '+esc(d.project_status)+'</p></div>'+
    '<div class="acts"><button class="btn btn-o" id="ledgerGoProject">会议项目</button> <button class="btn btn-p" id="ledgerCsv">导出项目台账 CSV</button></div></div>'+
    '<div class="grid g4">'+kpis.map(x=>'<div class="kpi"><div class="t">'+esc(x[0])+'</div><div class="v">'+(x[1]===null?"—":num(x[1]))+'</div></div>').join("")+'</div>'+
    '<h3 style="margin:22px 0 10px">分类付款对照</h3>'+
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
    (d.settlement?'<p>结算编号 <strong>'+td(d.settlement.id)+'</strong>　收入 '+num(d.settlement.income)+
      '　支出 '+num(d.settlement.expense)+'　结余 '+num(d.settlement.profit)+'</p>':'<p class="hint">本项目尚未生成结算单。</p>')+
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
