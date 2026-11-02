import {api} from "./api.js";
import {esc,toast} from "./ui.js";
/** Binds a server-scoped verified payee selector. Never exposes unmasked accounts to DOM. */
export async function bindPayeePicker(modal,pid,watchProject=false){
 const select=modal.querySelector('[name="payee_option_id"]');
 if(!select)return;
 let seq=0;
 const changeChoice=()=>{
  const selected=select.options[select.selectedIndex];
  if(!selected?.value)return;
  const rows=select.__rows||[];
  const x=rows.find(r=>r.id===selected.value);
  if(!x)return;
  const name=modal.querySelector('[name="payee"]');
  if(name)name.value=x.payee;
  const bank=modal.querySelector('[name="payee_bank"]');
  if(bank&&x.bank)bank.value=x.bank;
  const account=modal.querySelector('[name="payee_account"]');
  if(account&&x.maskedAccount)account.placeholder=x.maskedAccount+"（账号由服务器加密读取，不需重复填写）";
  // 账号解不开时明确提示，别让人以为选了就能付
  const tip=modal.querySelector("[data-payee-tip]");
  if(tip)tip.textContent=x.accountUnavailable
    ? "该收款人的银行账号无法解密（财务密钥变更过），请重新判定第 5 步，或手工填写账号"
    : "";
  // 金额也一并带出：劳务表是应发额，合同是合同总额（可改，允许部分付款）
  const amount=modal.querySelector('[name="amount"]');
  if(amount&&x.amount)amount.value=x.amount;
 };
 async function update(pid){
  const n=++seq;
  select.disabled=true;
  try{
   const d=await api.get("/api/projects/"+encodeURIComponent(pid)+"/payee-options");
   if(n!==seq)return;
   select.__rows=d.rows||[];
   select.innerHTML='<option value="">手动填写（仅限未建收款资料的历史业务）</option>'+
     select.__rows.map(x=>'<option value="'+esc(x.id)+'">'+esc(x.label)+
       (x.maskedAccount?' · '+esc(x.maskedAccount):"")+
       (x.accountUnavailable?' · 账号不可用':"")+'</option>').join("");
   if(select.__rows.length){select.value=select.__rows[0].id;changeChoice();}
  }catch(e){if(n===seq)toast("无法读取核验收款方："+e.message,"warn");}
  finally{if(n===seq)select.disabled=false;}
 }
 select.addEventListener("change",changeChoice);
 if(watchProject)modal.querySelector('[name="pid"]')?.addEventListener("change",e=>update(e.target.value));
 await update(pid);
}
