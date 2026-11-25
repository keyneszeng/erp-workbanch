import {api,can} from "./api.js";
import {modal,toast,esc} from "./ui.js";

/** Attach a missing receipt to a historically completed payment without altering money. */
export function openPaymentVoucher(id,pid,onDone){
 if(!can("payment:pay"))return toast("需要付款执行权限才能管理付款凭证","warn");
 const m=modal({title:"补传付款凭证 · "+esc(id),
  body:'<div class="gate">付款凭证只允许补传缺失文件。已有凭证不可直接覆盖，以免破坏历史记录。</div>'+
   '<div class="fld"><label>实际转账回单 <span class="req">*</span></label>'+
   '<input type="file" data-payment-voucher accept=".pdf,.jpg,.jpeg,.png,.webp,.doc,.docx,.xls,.xlsx">'+
   '<p class="hint">需上传真实回单，最多20MB；保存后财务人员可在“凭证详情”查看。</p></div>',
  footer:'<button class="btn btn-o" data-x="0">取消</button><button class="btn btn-p" data-x="1">上传并归档</button>'});
 m.querySelector('[data-x="0"]').onclick=()=>m.classList.remove("open");
 const btn=m.querySelector('[data-x="1"]');
 btn.onclick=async()=>{
  const file=m.querySelector("[data-payment-voucher]")?.files?.[0];
  if(!file||file.size>20*1024*1024){toast("请选择不超过20MB的付款凭证","warn");return;}
  btn.disabled=true;
  try{
   const upload=await api.upload(file,{pid});
   const r=await api.post("/api/payments/"+encodeURIComponent(id)+"/receipt",{
    file_key:upload.key,file_name:upload.name
   });
   toast(r.message,"ok");m.classList.remove("open");
   await onDone?.();
  }catch(e){toast(e.message,"warn");}
  finally{btn.disabled=false;}
 };
}
