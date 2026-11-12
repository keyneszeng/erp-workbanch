import {api} from "./api.js";
import {esc,modal,toast} from "./ui.js";

const FILE_KEY=/^[a-f0-9]{32}\.(?:jpg|png|webp|gif|pdf|ppt|doc|docx|pptx|xls|xlsx|csv|txt)$/;
/** Finance payment execution: inspect real linked originals before confirming an offline transfer. */
export async function openPaymentExecution(id,onDone){
 let data;
 try{data=await api.get("/api/payments/"+encodeURIComponent(id)+"/evidence");}
 catch(e){toast("无法读取付款依据："+e.message,"warn");return;}
 const y=data.payment||{},docs=data.evidence||[];
 const fileView=f=>{
  if(!FILE_KEY.test(f.fileKey||""))return "";
  const url="/api/uploads/"+encodeURIComponent(f.fileKey);
  const name=esc(f.fileName||f.name||"业务原件");
  const ext=String(f.fileKey).split(".").pop().toLowerCase();
  const preview=ext==="pdf"?'<iframe title="'+name+'" src="'+url+'#view=FitH" style="width:100%;height:330px;border:1px solid var(--line);border-radius:6px"></iframe>':
    ["jpg","png","webp","gif"].includes(ext)?'<img alt="'+name+'" src="'+url+'" style="max-width:100%;max-height:360px;object-fit:contain">':"Office 文件请使用下方链接查看原件。";
  return '<details style="margin:10px 0;padding:9px;border:1px solid var(--line);border-radius:7px"><summary style="cursor:pointer"><b>'+
   esc(f.type)+"</b> · "+name+'</summary><div style="margin-top:8px">'+preview+
   '<div><a class="link" target="_blank" rel="noopener" href="'+url+'">新窗口查看原件</a></div></div></details>';
 };
 const body='<div class="gate"><b>银行实际转账由财务线下操作</b>请先核对收款方、金额、合同及发票原件。系统仅登记已完成的付款，不发起银行转账。</div>'+
  '<div class="dsec"><h4>付款信息</h4><div class="dchk">付款单：'+esc(y.id)+' · 收款方：'+esc(y.payee)+
  ' · 金额：¥'+Number(y.amount||0).toLocaleString("zh-CN")+'</div><div class="dchk">开户行：'+esc(y.bank||"待财务核实")+
  ' · 账号：'+esc(y.maskedAccount||"尚未登记")+'</div></div>'+
  '<div class="dsec"><h4>关联文件原件（'+docs.length+'）</h4>'+
  (docs.length?docs.map(fileView).join(""):'<div class="hint">暂无关联的合同或发票原件，请先核实资料，禁止盲目付款。</div>')+
  '<p class="hint">'+esc(data.warning||"")+'</p></div>'+
  ((!y.bank||!y.maskedAccount)?'<div class="dsec"><h4>财务确认收款账号（执行付款时补录）</h4>'+
   '<label>开户行<input name="payee_bank" placeholder="开户行名称" autocomplete="off"></label>'+
   '<label>银行账号<input name="payee_account" placeholder="银行账号" autocomplete="off"></label></div>':"")+
  '<label class="hint"><input type="checkbox" data-verified> 我已核对关联原件、收款方和实际银行转账记录，确认付款已完成</label>';
 const m=modal({title:"财务执行付款 · 原件核对",width:"820px",body,
   footer:'<button class="btn btn-o" data-x="0">取消</button><button class="btn btn-p" data-x="1">确认已付款</button>'});
 m.querySelector('[data-x="0"]').onclick=()=>m.classList.remove("open");
 const btn=m.querySelector('[data-x="1"]');
 btn.onclick=async()=>{
  if(!docs.length){toast("未关联付款依据原件，请补充原件后再确认","warn");return;}
  if(!m.querySelector("[data-verified]")?.checked){toast("请先核对原件和线下付款事实","warn");return;}
  btn.disabled=true;
  try{
   if(!y.bank||!y.maskedAccount){
    const bank=m.querySelector('[name="payee_bank"]')?.value.trim();
    const account=m.querySelector('[name="payee_account"]')?.value.trim();
    if(!bank||!account){toast("执行付款时请核实并填写开户行及银行账号","warn");return;}
    await api.patch("/api/payments/"+encodeURIComponent(id)+"/account",{payee_bank:bank,payee_account:account});
   }
   const r=await api.post("/api/payments/"+encodeURIComponent(id)+"/pay",{});
   toast(r.message,"ok");m.classList.remove("open");
   if(onDone)await onDone();
  }catch(e){toast(e.message,"warn");}
  finally{btn.disabled=false;}
 };
}
