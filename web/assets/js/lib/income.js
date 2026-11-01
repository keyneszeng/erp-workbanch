import {api,can} from "./api.js";
import {esc,modal,formHtml,readForm,validate,toast,money} from "./ui.js";
import {checkFile} from "./upload.js";
const link=(key,name)=>key?'<a class="link" target="_blank" rel="noopener noreferrer" href="/api/uploads/'+esc(key)+'">'+esc(name)+'</a>':"—";
export async function renderIncomePanel(root,pid){
  const d=await api.get("/api/projects/"+encodeURIComponent(pid)+"/sponsor-income"),s=d.summary;
  root.innerHTML='<div class="panel"><div class="panel-h"><h2>会议收入 · 企业赞助</h2>'+
    (can("contract:write")?'<button class="btn btn-p btn-sm" data-income-new>+ 登记赞助合同</button>':"")+
    '</div><div class="hint" style="padding:12px">赞助收入与会务支出合同独立管理。会议预算 ¥'+money(s.budget)+'</div>'+
    '<div class="grid g3"><div class="kpi"><div class="t">赞助合同合计</div><div class="v">¥'+money(s.committed)+'</div></div>'+
    '<div class="kpi k2"><div class="t">核验到账</div><div class="v">¥'+money(s.received)+'</div></div>'+
    '<div class="kpi k4"><div class="t">预算差额</div><div class="v">¥'+money(s.difference)+'</div></div></div>'+
    (s.match&&s.receivedMatched?'<div class="banner ok mt">赞助合同、已到账收入和会议预算一致</div>':
     '<div class="gate mt">如有赞助记录，财务结算前合同总额和已核验到账额均须与会议预算一致。</div>')+
    '<div class="tw mt"><table><thead><tr><th>赞助企业</th><th>金额</th><th>状态</th><th>赞助合同</th><th>到账凭证</th><th>开具发票</th><th>操作</th></tr></thead><tbody>'+
    (d.rows.map(x=>'<tr><td>'+esc(x.company)+'</td><td>¥'+money(x.amount)+'</td><td>'+esc(x.status)+'</td>'+
     '<td>'+link(x.contract_key,"打开合同")+'</td><td>'+link(x.receipt_key,"到账凭证")+'</td><td>'+link(x.invoice_key,x.invoice_no||"发票")+'</td>'+
     '<td>'+(can("payment:pay")||can("contract:approve")?
       (x.status==="待收款"?'<button class="link" data-income-action="confirm-receipt" data-income-id="'+x.id+'">核验到账</button>':
       x.status==="已核验到账"?'<button class="link" data-income-action="issue-invoice" data-income-id="'+x.id+'">登记开票</button>':"—"):"—")+'</td></tr>').join("")||
     '<tr><td colspan="7">暂无企业赞助收入记录</td></tr>')+'</tbody></table></div></div>';
  root.querySelector("[data-income-new]")?.addEventListener("click",()=>openEditor(root,pid,"new"));
  root.querySelectorAll("[data-income-action]").forEach(b=>b.onclick=()=>openEditor(root,pid,b.dataset.incomeAction,Number(b.dataset.incomeId)));
}
function openEditor(root,pid,action,id){
  const fresh=action==="new";
  const fields=fresh?[{k:"company",l:"赞助企业名称",req:1},{k:"amount",l:"赞助合同金额（元）",t:"number",req:1}]:
    action==="issue-invoice"?[{k:"invoice_no",l:"发票号码",req:1}]:[];
  const fileField=fresh?"contract_key":action==="issue-invoice"?"invoice_key":"receipt_key";
  const title=fresh?"赞助合同原件":action==="issue-invoice"?"已开具发票原件":"企业到账凭证原件";
  const m=modal({title:fresh?"登记企业赞助合同":action==="issue-invoice"?"登记发票":"核验企业赞助到账",
    body:formHtml(fields)+'<div class="fld"><label>'+title+'<span class="req">*</span></label>'+
      '<input type="file" name="'+fileField+'" accept=".pdf,.jpg,.jpeg,.png,.docx,.ppt,.pptx,.xlsx">'+
      '<div class="hint">必须上传真实原件；系统不能自动核验银行流水或税务发票真实性。</div></div>',
    footer:'<button class="btn btn-o" data-x="0">取消</button><button class="btn btn-p" data-x="1">确认保存</button>'});
  m.querySelector('[data-x="0"]').onclick=()=>m.classList.remove("open");
  m.querySelector('[data-x="1"]').onclick=async()=>{
    if(!validate(m,fields))return;
    const file=m.querySelector('[name="'+fileField+'"]').files?.[0];
    if(!file){toast("请选择"+title,"warn");return;}
    const error=checkFile(file);if(error){toast(error,"warn");return;}
    const btn=m.querySelector('[data-x="1"]');btn.disabled=true;
    try{
      btn.textContent="上传中…";
      const up=await api.upload(file,{pid});
      const data={...readForm(m),[fileField]:up.key};
      if(fresh)await api.post("/api/projects/"+pid+"/sponsor-income",data);
      else await api.patch("/api/projects/"+pid+"/sponsor-income/"+id,{...data,action});
      m.classList.remove("open");toast("收入资料已登记","ok");await renderIncomePanel(root,pid);
    }catch(e){toast(e.message,"warn");btn.disabled=false;btn.textContent="确认保存";}
  };
}
