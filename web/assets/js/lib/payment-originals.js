import {api} from "./api.js";
import {confirmBox,esc,modal,toast} from "./ui.js";

/** View project-scoped original documents before registering an actual bank payment.
 * This UI never asks for a bank account number; no transfer is initiated.
 */
export async function executePaymentWithOriginals(id,onPaid){
 let data;
 try{data=await api.get("/api/payments/"+encodeURIComponent(id)+"/originals");}
 catch(e){toast("无法获取关联原件："+e.message,"warn");return;}
 const rows=data.originals||[];
 const linked=!!data.hasLinkedOriginal;
 const originals=rows.length?rows.map(x=>
   '<div class="dchk"><b>'+esc(x.kind)+'</b> · '+
    '<a class="link" target="_blank" rel="noopener" href="/api/uploads/'+encodeURIComponent(x.file_key)+'">'+esc(x.name)+'</a></div>'
 ).join(""):'<div class="hint">未找到可查看的关联原件，请先在本项目合同或材料中心上传并关联。</div>';
 const dialog=modal({
  title:"执行付款 · 核验关联原件",
  body:'<div class="dsec"><h4>付款单信息</h4>'+
   '<div class="dchk">单号：'+esc(data.payment.id)+' · 收款方：'+esc(data.payment.payee)+
   ' · 金额：¥'+Number(data.payment.amount).toLocaleString("zh-CN")+'</div></div>'+
   '<div class="dsec"><h4>关联文件原件</h4>'+originals+'</div>'+
   '<div class="hint">请打开并核对原件中的收款资料，与银行实际转账凭证一致后，才登记为已付款。此操作不自动转账。</div>'+
   (linked?'':'<div class="gate">缺少可确认归属的合同或劳务原件，暂不能登记付款。</div>'),
  footer:'<button class="btn btn-o" data-x="0">关闭</button>'+
   (linked?'<button class="btn btn-p" data-x="1">已核对原件，登记付款</button>':"")
 });
 dialog.querySelector('[data-x="0"]').onclick=()=>dialog.classList.remove("open");
 const btn=dialog.querySelector('[data-x="1"]');
 if(!btn)return;
 btn.onclick=async()=>{
  if(!await confirmBox("已核对收款方关联原件和实际银行转账凭证，确认登记为「已付款」？系统不会发起银行转账。",{ok:"确认登记"}))return;
  if(btn.disabled)return;
  btn.disabled=true;
  try{
   const r=await api.post("/api/payments/"+encodeURIComponent(id)+"/pay",{});
   toast(r.message,"ok");
   dialog.classList.remove("open");
   await onPaid?.();
  }catch(e){toast(e.message,"warn");btn.disabled=false;}
 };
}
