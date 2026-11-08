"use strict";
const {bad,cents}=require("./util");

/** 费率按百分比输入，例如10表示10%，可输入0～100%且最多两位小数。 */
function parseTaxFeeRate(raw) {
  if(raw===undefined || raw===null || String(raw).trim()==="")return 0;
  const n=Number(raw);
  if(!Number.isFinite(n) || n<0 || n>100 || Math.abs(n*100-Math.round(n*100))>1e-7)
    throw bad("税费管理费率必须是 0～100 的百分数，最多保留两位小数");
  return n;
}
/** 全过程采用整数分+万分比，避免浮点尾差。 */
function availableBudget(projectOrBudget,rate) {
  const budget=typeof projectOrBudget==="object"?projectOrBudget.budget:projectOrBudget;
  const percent=typeof projectOrBudget==="object" ? projectOrBudget.tax_fee_rate : rate;
  const basis=Math.round(parseTaxFeeRate(percent)*100);
  return Math.round(cents(budget)*(10000-basis)/10000)/100;
}
function withBudgetFee(p){
  return {...p,tax_fee_rate:Number(p.tax_fee_rate)||0,available_budget:availableBudget(p)};
}
module.exports={parseTaxFeeRate,availableBudget,withBudgetFee};
