/** 立项和项目资料编辑共用实时税费率计算，不把派生金额写回表单。 */
import {toast} from "./ui.js";
const isCents=n=>Math.abs(n*100-Math.round(n*100))<1e-7;
export function budgetAvailablePreview(budget,percentage){
 const b=Number(budget),rate=Number(percentage);
 if(!Number.isFinite(b)||b<=0||b>1e9||!isCents(b))return null;
 if(!Number.isFinite(rate)||rate<0||rate>100||!isCents(rate))return null;
 return Math.round(Math.round(b*100)*(10000-Math.round(rate*100))/10000)/100;
}
export function bindBudgetFeePreview(modal){
 const budget=modal.querySelector('[name="budget"]');
 const fee=modal.querySelector('[name="tax_fee_rate"]');
 if(!budget||!fee)return ()=>true;
 const fld=fee.closest(".fld");
 fld.insertAdjacentHTML("afterend",`<div class="fld full" style="grid-column:1/-1">
   <label>可用预算（自动计算）</label>
   <output data-available-budget style="display:block;font-size:19px;font-weight:650" aria-live="polite">—</output>
   <div class="tip">可用预算 = 预算 ×（1 − 税费管理费率 ÷ 100）；最终以服务端精确到分的计算结果为准。</div>
 </div>`);
 const output=modal.querySelector("[data-available-budget]");
 function refresh(){
  const n=budgetAvailablePreview(budget.value,fee.value||0);
  output.textContent=n===null?"请检查预算和费率":"¥"+n.toLocaleString("zh-CN",{minimumFractionDigits:2,maximumFractionDigits:2});
  const r=Number(fee.value||0);
  fld.classList.toggle("err",!Number.isFinite(r)||r<0||r>100||!isCents(r));
  return n!==null;
 }
 budget.addEventListener("input",refresh);
 fee.addEventListener("input",refresh);
 refresh();
 return ()=>{
   if(!refresh()){
     toast("预算须大于0；税费管理费率为0～100%，最多两位小数","warn");
     return false;
   }
   return true;
 };
}
