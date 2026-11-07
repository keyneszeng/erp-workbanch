"use strict";
const {cents}=require("./util");
const {availableBudget}=require("./budget-fee");

const GROUPS=Object.freeze([
  {key:"labor",label:"劳务",types:["专家费"]},
  {key:"meeting",label:"会务",types:["学会公付"]},
  {key:"association",label:"协会报销",types:["个人报销","协会报销"]},
  {key:"other",label:"其他",types:["厂家款"]}
]);
const groupForType=type=>GROUPS.find(x=>x.types.includes(type))?.key||"other";
const moneyFromCents=x=>Math.round(x)/100;

/** 账单分类只能由已付款记录构建；审批、拒绝与未付绝不能混入。 */
function buildSettlementBreakdown(settlement,project,payments){
  const paid=(payments||[]).filter(x=>x.status==="已付款");
  const sections=GROUPS.map(x=>({key:x.key,label:x.label,amount:0,count:0,items:[]}));
  const byKey=Object.fromEntries(sections.map(x=>[x.key,x]));
  let totalCents=0;
  for(const row of paid){
    const amountCents=cents(row.amount);
    totalCents+=amountCents;
    const group=byKey[groupForType(row.type)];
    group.count++;
    group.amount=moneyFromCents(cents(group.amount)+amountCents);
    group.items.push({
      id:row.id,type:row.type,payee:row.payee||"",
      amount:moneyFromCents(amountCents),
      invoice_no:row.invoice_no||"",req_user:row.req_user||"",
      paid_at:row.paid_at||"",remark:row.remark||"",
      payee_bank:row.payee_bank||"",
      account_tail:row.payee_account?String(row.payee_account).slice(-4):""
    });
  }
  // 已生成结算单的原预算使用结算时冻结的 income，而非可被强制纠错的项目预算。
  const budget=moneyFromCents(cents(settlement.income));
  const rate=Number(project.tax_fee_rate)||0;
  const usable=availableBudget(budget,rate);
  const paidTotal=moneyFromCents(totalCents);
  const legacyExpenseMismatch=cents(settlement.expense)!==totalCents;
  return {
    id:settlement.id,pid:settlement.pid,created_at:settlement.created_at||"",
    payee:settlement.payee||"",payee_bank:settlement.payee_bank||"",
    account_tail:settlement.payee_account?String(settlement.payee_account).slice(-4):"",
    summary:{
      budget,tax_fee_rate:rate,
      tax_fee_amount:moneyFromCents(cents(budget)-cents(usable)),
      available_budget:usable,paid:paidTotal,
      balance:moneyFromCents(cents(usable)-totalCents),
      payment_count:paid.length
    },
    groups:sections,
    reconciliation:legacyExpenseMismatch?{
      original_expense:moneyFromCents(cents(settlement.expense)),
      paid_from_payments:paidTotal,
      note:"历史结算单原记载支出与当前已付款明细不一致；请核对原始凭证。分类和已支付以实际已付款记录为准。"
    }:null
  };
}
module.exports={GROUPS,groupForType,buildSettlementBreakdown};
