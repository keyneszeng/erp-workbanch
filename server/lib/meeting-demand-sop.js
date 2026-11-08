"use strict";
const crypto=require("node:crypto");
const {cents}=require("./util");
const MEETING="会务需求";
const LEGACY_MEETING=/(?:会务协议|会务合同|会议服务合同|会议执行合同|会务执行合同)/;

function validFile(m){return !!m.file_key && String(m.file_key).trim() && !m.deleted_at;}
/** Contract ledger category wins; a sponsor/labor file must never be matched by its title. */
function isMeetingAgreement(m,byKey){
 if(!validFile(m)||m.version==="历史版")return false;
 const contracts=byKey.get(m.file_key)||[];
 if(contracts.length)return contracts.length===1 && contracts[0].category===MEETING;
 return m.kind==="会务协议" ||
   (m.kind==="合同"&&LEGACY_MEETING.test(String(m.name||"")+" "+String(m.file_name||"")));
}
function isMeetingInvoice(m){
 if(!validFile(m))return false;
 return m.kind==="会务发票" || (m.kind==="发票"&&
  /会务|会议服务|会议执行/.test(String(m.name||"")+" "+String(m.file_name||"")));
}
/**
 * Verification step 6 is exactly: persisted demand form, meeting-demand
 * ledger agreements & originals, and meeting-service invoices. Never agenda,
 * expert labor, enterprise sponsor or unrelated generic contracts.
 */
function demandSopState(db,pid){
 const sheet=db.prepare("SELECT * FROM demand_sheets WHERE pid=?").get(pid);
 const items=db.prepare(
  "SELECT id,grp,item,need,budget,quantity,unit_price FROM demand_items WHERE pid=? AND need='需要' ORDER BY id"
 ).all(pid);
 const contracts=db.prepare(
  "SELECT id,name,category,amount,status,file_key FROM contracts WHERE pid=? AND category=? AND status='已签署' ORDER BY id"
 ).all(pid,MEETING);
 const allLedger=db.prepare("SELECT id,category,file_key FROM contracts WHERE pid=? AND file_key IS NOT NULL AND file_key<>'' ORDER BY id").all(pid);
 const byKey=new Map();
 for(const item of allLedger){
  if(!byKey.has(item.file_key))byKey.set(item.file_key,[]);
  byKey.get(item.file_key).push(item);
 }
 const materials=db.prepare(
  "SELECT id,kind,name,file_name,file_key,version,deleted_at FROM materials WHERE pid=? "+
  "AND (deleted_at IS NULL OR deleted_at='') AND file_key IS NOT NULL AND file_key<>'' ORDER BY id"
 ).all(pid);
 const agreements=materials.filter(m=>isMeetingAgreement(m,byKey));
 const invoices=materials.filter(isMeetingInvoice);
 const budgetCents=items.reduce((n,x)=>n+cents(Number(x.budget||0)),0);
 const contractCents=contracts.reduce((n,x)=>n+cents(x.amount),0);
 const signature=crypto.createHash("sha256").update(JSON.stringify({
  sheet:sheet?[sheet.created_at,sheet.confirmed,sheet.updated_at]:null,
  items:items.map(x=>[x.id,x.grp,x.item,x.need,x.budget,x.quantity,x.unit_price]),
  contracts:contracts.map(x=>[x.id,x.name,x.category,x.amount,x.status,x.file_key]),
  agreements:agreements.map(m=>[m.id,m.kind,m.name,m.file_name,m.file_key,m.version]),
  invoices:invoices.map(m=>[m.id,m.kind,m.name,m.file_name,m.file_key,m.version])
 })).digest("hex");
 return {
  required:!!sheet,confirmed:!!sheet?.confirmed,needCount:items.length,
  budgetTotal:budgetCents/100,contractTotal:contractCents/100,contractCount:contracts.length,
  agreements,invoices,signature
 };
}
module.exports={demandSopState,isMeetingAgreement,isMeetingInvoice};
