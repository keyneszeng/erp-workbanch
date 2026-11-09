import {api} from "./api.js";
import {esc,toast} from "./ui.js";
/**
 * Verified payment recipient selector shared by project payment and finance page.
 * Show linked recipient information for review; never expose a full bank account.
 */
export async function bindPayeePicker(modal,pid,watchProject=false){
 const select=modal.querySelector('[name="payee_option_id"]');
 if(!select)return;
 const panel=document.createElement("section");
 panel.className="dsec";
 panel.setAttribute("data-payee-linked-details","");
 panel.setAttribute("aria-live","polite");
 panel.style.margin="10px 0";
 select.closest(".field")?.after(panel);
 if(!panel.parentNode)select.parentNode?.after(panel);
 let seq=0;
 const input=k=>modal.querySelector('[name="'+k+'"]');
 const showChoice=()=>{
  const rows=select.__rows||[];
  const x=rows.find(r=>r.id===select.value);
  if(!x){
   panel.innerHTML='<div class="hint"><b>关联收款方资料</b>：未选择已关联的合同或核销劳务记录，请人工填写收款信息。</div>';
   return;
  }
  const source=x.source==="labor"
    ?(x.linkedContract?"已签署劳务专家合同 + 第5项核销劳务表":"第5项已核销劳务表")
    :"已签署合同";
  const amount=Number.isFinite(Number(x.amount))?
    Number(x.amount).toLocaleString("zh-CN",{minimumFractionDigits:2,maximumFractionDigits:2}):"未登记";
  panel.innerHTML='<h4>关联收款方资料（只读）</h4>'+
   '<div class="dchk"><b>来源：</b>'+esc(source)+'</div>'+
   '<div class="dchk"><b>收款方：</b>'+esc(x.payee||"—")+'</div>'+
   '<div class="dchk"><b>关联金额：</b>'+esc(amount==="未登记"?amount:"¥"+amount)+'</div>'+
   '<div class="dchk"><b>开户行：</b>'+esc(x.bank||"资料未登记，需在申请表补充")+'</div>'+
   '<div class="dchk"><b>银行账号：</b>'+esc(x.maskedAccount||"资料未登记，需在申请表补充")+'</div>'+
   '<div class="hint">'+(x.source==="labor"&&x.maskedAccount?'开户行及银行账号已关联，提交付款申请时自动使用加密保存的账户，无需重新输入。':'来源数据仅供核对；银行账号只显示尾号。合同未登记的银行信息须人工补充。')+'</div>';
 };
 const changeChoice=()=>{
  // Do not retain a previous payee's bank details after switching recipients.
  const name=input("payee"),bank=input("payee_bank"),account=input("payee_account");
  if(name)name.value="";
  if(bank)bank.value="";
  if(account){account.value="";account.readOnly=false;account.placeholder="10~25 位数字，可含空格分隔";}
  const rows=select.__rows||[];
  const x=rows.find(r=>r.id===select.value);
  showChoice();
  if(!x)return;
  if(name)name.value=x.payee;
  if(bank&&x.bank)bank.value=x.bank;
  if(account&&x.source==="labor"&&x.maskedAccount){
   // Full account stays server-side; the verified payee ID is submitted instead.
   account.readOnly=true;
   account.value="";
   account.placeholder=x.maskedAccount+"（已自动关联，提交时由服务器安全填入）";
  }
  const amount=input("amount");
  if(amount&&x.source==="labor"&&x.amount)amount.value=x.amount;
 };
 async function update(nextPid){
  const n=++seq;
  select.disabled=true;
  panel.textContent="正在加载关联收款方资料…";
  select.__rows=[];
  select.innerHTML='<option value="">载入中…</option>';
  try{
   const d=await api.get("/api/projects/"+encodeURIComponent(nextPid)+"/payee-options");
   if(n!==seq)return;
   select.__rows=d.rows||[];
   select.innerHTML='<option value="">手动填写（仅限未建收款资料的历史业务）</option>'+
     select.__rows.map(x=>'<option value="'+esc(x.id)+'">'+esc(x.label)+(x.maskedAccount?' · '+esc(x.maskedAccount):"")+'</option>').join("");
   select.value=select.__rows.length?select.__rows[0].id:"";
   changeChoice();
  }catch(e){
   if(n===seq){
    select.innerHTML='<option value="">无法读取关联资料</option>';
    changeChoice();
    panel.innerHTML='<div class="hint">关联收款方资料加载失败，请重试或联系管理员。</div>';
    toast("无法读取核验收款方："+e.message,"warn");
   }
  }finally{if(n===seq)select.disabled=false;}
 }
 select.addEventListener("change",changeChoice);
 if(watchProject)modal.querySelector('[name="pid"]')?.addEventListener("change",e=>update(e.target.value));
 await update(pid);
}
