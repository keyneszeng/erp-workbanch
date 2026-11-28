"use strict";
// Reimbursement is supported only by an explicitly reviewed, version-bound material.
// Never infer the actual reimbursement recipient from the invoice seller or buyer.
const {db}=require("./db");
const {bad,conflict,cents}=require("./util");
const KINDS=["协会报销","其他费用"];
const isExpenseKind=k=>KINDS.includes(k);
const isExpenseSource=id=>/^expense:[1-9]\d*$/.test(String(id||""));
const normalizeTicket=v=>String(v||"").normalize("NFKC").replace(/\s+/g,"").toLowerCase();
const sourceId=id=>"expense:"+id;
const activePayments=pid=>db.prepare("SELECT id,pid,type,payee,amount,invoice_no,payee_source_id,status FROM payments WHERE pid=? AND status<>'已驳回'").all(pid);
function list(pid){
 const rows=db.prepare(`SELECT m.id,m.pid,m.kind,m.name,m.file_key,m.file_name,m.file_mime,
   r.state,r.payee,r.amount,r.ticket_no,r.reason,r.reviewed_at
   FROM materials m LEFT JOIN expense_ticket_reviews r ON r.material_id=m.id AND r.pid=m.pid
     AND r.file_key=m.file_key AND r.kind=m.kind
   WHERE m.pid=? AND m.deleted_at IS NULL AND m.kind IN ('协会报销','其他费用') AND COALESCE(m.file_key,'')<>'' ORDER BY m.id`).all(pid);
 const paid=activePayments(pid);
 return rows.map(m=>{
   const payment=paid.find(y=>y.payee_source_id===sourceId(m.id));
   return {...m,source_id:sourceId(m.id),state:m.state||"unreviewed",payment_id:payment?.id||null,payment_status:payment?.status||null};
 });
}
function options(pid){
 return list(pid).filter(m=>m.state==="confirmed"&&Number(m.amount)>0).map(m=>({
  id:m.source_id,source:"expense",type:m.kind,payee:m.payee,amount:m.amount,
  label:m.kind+" · "+(m.ticket_no||m.name),bank:"",maskedAccount:""
 }));
}
function resolve(pid,id){
 const m=list(pid).find(m=>m.source_id===id&&m.state==="confirmed");
 if(!m)throw bad("票据尚未确认或原件已变化，请重新核对");
 return {name:m.payee,amount:m.amount,bank:"",account:"",source:"expense",type:m.kind,ticketNo:m.ticket_no,materialId:m.id,fileKey:m.file_key};
}
function validate(body){
 const payee=String(body.payee||"").trim(),ticketNo=String(body.ticket_no||"").normalize("NFKC").trim(),amount=Number(body.amount);
 if(!payee||payee.length>60)throw bad("请填写实际收款方（60字以内）");
 if(!ticketNo||ticketNo.length>40||!normalizeTicket(ticketNo))throw bad("请填写票据号码或原始单据唯一编号（40字以内）");
 if(!Number.isFinite(amount)||amount<=0||amount>1e9||cents(amount)/100!==amount)throw bad("报销金额必须大于0，最多两位小数");
 return {payee,ticketNo,ticketKey:normalizeTicket(ticketNo),amount};
}
function assertUnique(m,v,hash){
 const dup=db.prepare("SELECT material_id FROM expense_ticket_reviews WHERE material_id<>? AND state='confirmed' AND (ticket_key=? OR file_hash=? OR file_key=?) LIMIT 1").get(m.id,v.ticketKey,hash,m.file_key);
 if(dup)throw conflict("票据号码或原件已用于其他报销，不可重复确认","DUPLICATE_EXPENSE_TICKET");
 // Historical payment records may already contain this ticket number, including contract-linked payments.
 const old=db.prepare("SELECT id,invoice_no FROM payments WHERE status<>'已驳回' AND COALESCE(invoice_no,'')<>''").all().find(y=>normalizeTicket(y.invoice_no)===v.ticketKey);
 if(old)throw conflict("该票据号码已有有效付款记录，请核对原付款","DUPLICATE_EXPENSE_TICKET");
 const linked=db.prepare("SELECT 1 FROM contracts WHERE file_key=? AND deleted_at IS NULL UNION SELECT 1 FROM meeting_sponsor_contracts WHERE file_key=? UNION SELECT 1 FROM meeting_sponsor_invoices WHERE file_key=? UNION SELECT 1 FROM meeting_sponsor_receipts WHERE file_key=? UNION SELECT 1 FROM payments WHERE receipt_file_key=? UNION SELECT 1 FROM materials WHERE file_key=? AND deleted_at IS NULL AND kind IN ('发票','会务发票','合同')").get(m.file_key,m.file_key,m.file_key,m.file_key,m.file_key,m.file_key);
 if(linked)throw conflict("原件已用于合同、会务发票、赞助或付款回单，不可作为独立报销票据","DUPLICATE_EXPENSE_TICKET");
}
function pending(pid){
 return list(pid).filter(m=>m.state!=="excluded"&&(m.state!=="confirmed"||m.payment_status!=="已付款")).length;
}
module.exports={KINDS,isExpenseKind,isExpenseSource,sourceId,normalizeTicket,list,options,resolve,validate,assertUnique,pending};
