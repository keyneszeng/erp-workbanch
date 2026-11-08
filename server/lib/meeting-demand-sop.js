"use strict";
const crypto=require("node:crypto");
const {cents}=require("./util");

function validFile(m){return !!m.file_key && String(m.file_key).trim() && !m.deleted_at;}
function isAgreement(m){
  if(!validFile(m) || m.version==="历史版")return false;
  if(m.kind==="会务协议")return true;
  if(m.kind!=="合同")return false;
  return /会务协议|会务合同|会议服务合同/.test(String(m.name||"")+" "+String(m.file_name||""));
}
/** 仅实际标记「需要」的需求才触发 SOP 6。空模板和全「不需要」不触发。 */
function demandSopState(db,pid){
  const sheet=db.prepare("SELECT confirmed FROM demand_sheets WHERE pid=?").get(pid);
  const items=db.prepare(
    "SELECT id,grp,item,need,budget,quantity,unit_price FROM demand_items WHERE pid=? AND need='需要' ORDER BY id"
  ).all(pid);
  const contracts=db.prepare(
    "SELECT id,name,category,amount,status,file_key FROM contracts WHERE pid=? AND status='已签署' "+
    "AND COALESCE(category,'') NOT IN ('劳务专家','企业赞助') ORDER BY id"
  ).all(pid);
  const materials=db.prepare(
    "SELECT id,kind,name,file_name,file_key,version,deleted_at FROM materials WHERE pid=? "+
    "AND (deleted_at IS NULL OR deleted_at='') AND file_key IS NOT NULL AND file_key<>'' ORDER BY id"
  ).all(pid);
  const agreements=materials.filter(isAgreement);
  const agenda=materials.filter(m=>m.kind==="终版议程" && m.version==="终版");
  const invoices=materials.filter(m=>m.kind==="发票"||m.kind==="会务发票");
  const budgetCents=items.reduce((n,x)=>n+cents(Number(x.budget||0)),0);
  const contractCents=contracts.reduce((n,x)=>n+cents(x.amount),0);
  // ID、金额与附件版本构成签名；修改需求/合同/原件后旧通过结论失效。
  const signature=crypto.createHash("sha256").update(JSON.stringify({
    confirmed:!!sheet?.confirmed,
    items:items.map(x=>[x.id,x.grp,x.item,x.need,x.budget,x.quantity,x.unit_price]),
    contracts:contracts.map(x=>[x.id,x.name,x.category,x.amount,x.status,x.file_key]),
    materials:materials.filter(m=>isAgreement(m)||m.kind==="终版议程"||m.kind==="发票"||m.kind==="会务发票")
      .map(m=>[m.id,m.kind,m.name,m.file_name,m.file_key,m.version])
  })).digest("hex");
  return {required:items.length>0,confirmed:!!sheet?.confirmed,needCount:items.length,
    budgetTotal:budgetCents/100,contractTotal:contractCents/100,
    contractCount:contracts.length,agreements,agenda,invoices,signature};
}
module.exports={demandSopState};
