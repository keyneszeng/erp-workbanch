import {esc,money,table} from "./ui.js";

/** 付款明细/四个结算指标均由服务端确定；此处只负责安全展示。 */
export function renderSettlementBreakdown(data){
  if(!data||!data.summary)return '<div class="empty">暂无可查看的结算单</div>';
  const s=data.summary;
  const fmt=n=>"¥"+money(n);
  const metrics=[["预算",s.budget],["可用预算",s.available_budget],["已支付",s.paid],["结余",s.balance]];
  const groups=Array.isArray(data.groups)?data.groups:[];
  const metricHtml=metrics.map(([label,value],i)=>
    '<div class="kpi k'+(i+1)+'"><div class="t">'+label+'</div><div class="v">'+fmt(value)+'</div></div>'
  ).join("");
  const groupHtml=groups.map(group=>{
    const rows=group.items.map(x=>({c:[
      '<span class="mono">'+esc(x.id)+'</span>',
      esc(x.type),
      esc(x.payee)+'<div class="hint">'+esc(x.payee_bank||"")+(x.account_tail?" · 尾号 "+esc(x.account_tail):"")+'</div>',
      fmt(x.amount),esc(x.paid_at||"—"),esc(x.req_user||"—"),
      esc(x.invoice_no||"—")+(x.remark?" · "+esc(x.remark):"")
    ]}));
    const detail=rows.length?table(
      [{t:"付款单号",w:"114px"},{t:"付款类型",w:"90px"},{t:"收款方"},
        {t:"金额",w:"105px",cls:"num"},{t:"付款日期",w:"112px"},
        {t:"申请人",w:"85px"},{t:"发票号/备注"}],rows
    ):'<div class="empty">该分类暂无已付款明细</div>';
    return '<details class="settlement-group" data-settlement-group="'+esc(group.key)+'"'+(rows.length?' open':'')+'>'
      +'<summary aria-label="展开'+esc(group.label)+'付款明细">'
      +'<span class="sg-name">'+esc(group.label)+'</span>'
      +'<span class="sg-amount">'+fmt(group.amount)+'</span>'
      +'<span class="sg-count">'+group.count+' 笔已支付 · 可展开/收起明细</span></summary>'
      +'<div class="sg-rows">'+detail+'</div></details>';
  }).join("");
  const reconcile=data.reconciliation?'<div class="sg-reconcile">'+esc(data.reconciliation.note)
    +' 原结算记载支出 '+fmt(data.reconciliation.original_expense)
    +' · 当前已付款明细 '+fmt(data.reconciliation.paid_from_payments)+'</div>':"";
  return '<section class="settlement-detail" aria-label="结算单四项汇总及分类明细">'
    +'<div class="settlement-detail-head"><b>结算单 '+esc(data.id)+' · '+esc(data.pid)+'</b>'
    +'<span class="hint">生成时间 '+esc(data.created_at||"—")+' · 税费管理费 '+esc(s.tax_fee_rate)
    +'%（'+fmt(s.tax_fee_amount)+'）</span></div>'
    +'<div class="settlement-summary">'+metricHtml+'</div>'
    +'<div class="settlement-section-label">付款分类明细 <span class="hint">明细在各板块内直接展示，可展开或收起 · 仅汇总已付款 '
    +s.payment_count+' 笔</span></div>'
    +'<div class="settlement-groups">'+groupHtml+'</div>'
    +'<div class="hint" style="margin-top:12px">结余 = 可用预算 − 已支付；待审批、已审批及已驳回不计入已支付。历史「个人报销」归入「协会报销」。</div>'
    +reconcile+'</section>';
}
