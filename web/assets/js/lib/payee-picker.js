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
  // 开户行：选中就覆盖，没带开户行就清空 —— 否则切换收款方后会留着上一个人的开户行
  const bank=modal.querySelector('[name="payee_bank"]');
  if(bank)bank.value=x.bank||"";
  /**
   * 银行账号：核销里已经核验过的账号，直接把尾号填进输入框并锁住。
   * 原来只写 placeholder，框里还是空的 —— 财务看着空框会以为必须自己填一遍，
   * 于是又去翻合同找账号。完整账号始终只在服务端解密，前端只显示尾号。
   */
  const account=modal.querySelector('[name="payee_account"]');
  const verified=!!(x.maskedAccount&&!x.accountUnavailable);
  if(account){
   if(verified){
    account.value=x.maskedAccount;
    account.readOnly=true;
    account.dataset.auto="1";
    account.placeholder="由核销资料带入，无需填写";
    account.title="完整账号由服务器加密读取，前端不显示明文";
   }else{
    account.value="";
    account.readOnly=false;
    delete account.dataset.auto;
    account.placeholder="10~25 位数字，可含空格分隔";
    account.title="";
   }
  }
  // 账号解不开 / 台账没登记，要说清楚该怎么办，别让人以为选了就能付
  const tip=modal.querySelector("[data-payee-tip]");
  if(tip)tip.textContent=x.accountUnavailable
    ? "该收款人的银行账号无法解密（财务密钥变更过），请重新判定第 5 步，或手工填写账号"
    : (x.maskedAccount ? "" : "该收款方在合同台账里没有登记收款账号，请手工填写；也可以在合同台账补录后再选一次");
  // 金额也一并带出：劳务表是应发额，合同是合同总额（可改，允许部分付款）
  const amount=modal.querySelector('[name="amount"]');
  if(amount)amount.value=x.amount??"";
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
