"use strict";
const crypto=require("node:crypto");
const {db}=require("./db");
const {now,bad}=require("./util");
const {cents}=require("./util");
const {isDemoMode}=require("./runtime");
const {laborSheetInfo}=require("./labor-sop");
const {contractPool}=require("./labor-contracts");
// Encryption key is deliberately not stored in SQLite or returned to a browser.
function key(){
 const v=String(process?.env?.ERP_FINANCIAL_DATA_KEY||"");
 return /^[0-9a-f]{64}$/i.test(v)?Buffer.from(v,"hex"):null;
}
function seal(s){
 const k=key();if(!k)return null;
 const iv=crypto.randomBytes(12),cipher=crypto.createCipheriv("aes-256-gcm",k,iv);
 const data=Buffer.concat([cipher.update(String(s),"utf8"),cipher.final()]);
 return Buffer.concat([iv,cipher.getAuthTag(),data]).toString("base64");
}
function reveal(s){
 const k=key();if(!k)return null;
 try{
  const b=Buffer.from(s,"base64");
  const de=crypto.createDecipheriv("aes-256-gcm",k,b.subarray(0,12));
  de.setAuthTag(b.subarray(12,28));
  return Buffer.concat([de.update(b.subarray(28)),de.final()]).toString("utf8");
 }catch{return null;}
}
function saveLabor(pid,records){
 if(!key())return {saved:false,reason:"ERP_FINANCIAL_DATA_KEY 未配置；敏感账号不写入数据库"};
 const insert=db.prepare("INSERT INTO verified_labor_payees(pid,name,bank,account_cipher,amount,confirmed_at) VALUES (?,?,?,?,?,?)");
 db.prepare("DELETE FROM verified_labor_payees WHERE pid=?").run(pid);
 for(const x of records){
  const account=String(x.bankAccount||"").replace(/\s/g,"");
  insert.run(pid,String(x.name).trim(),String(x.bankName||"").trim(),seal(account),Number(x.amount),now());
 }
 return {saved:true,count:records.length};
}
function options(pid){
 const contracts=db.prepare("SELECT id,vendor,amount,category FROM contracts WHERE pid=? AND status='已签署' AND COALESCE(category,'')<>'企业赞助' ORDER BY id").all(pid);
 const rows=contracts.map(x=>({id:"contract:"+x.id,label:x.vendor+"（"+x.category+"合同）",payee:x.vendor,amount:x.amount,source:"contract",bank:"",maskedAccount:""}));
 const s=laborSheetInfo(db,pid);
 const v=db.prepare("SELECT result,evidence_json FROM verify_steps WHERE pid=? AND step_no=5").get(pid);
 let valid=false;
 try{valid=s.required&&v?.result==="通过"&&JSON.parse(v.evidence_json||"{}").laborSourceSignature===s.signature && JSON.parse(v.evidence_json||"{}").contractPoolSignature===contractPool(db,pid).signature;}catch{}
 const labor=valid?db.prepare("SELECT id,name,bank,account_cipher,amount FROM verified_labor_payees WHERE pid=? ORDER BY id").all(pid):[];
 for(const x of labor){
  const account=reveal(x.account_cipher);
  if(account)rows.push({id:"labor:"+x.id,label:x.name+"（核销劳务表）",payee:x.name,
    amount:x.amount,source:"labor",bank:x.bank,maskedAccount:"尾号 "+account.slice(-4)});
 }
 return rows;
}
function resolve(pid,id){
 const value=String(id||"");
 if(value.startsWith("contract:")){
  const x=db.prepare("SELECT vendor,amount FROM contracts WHERE id=? AND pid=? AND status='已签署' AND COALESCE(category,'')<>'企业赞助'").get(value.slice(9),pid);
  if(!x)throw bad("选择的合同收款方不存在或未签署");
  return {name:x.vendor,amount:x.amount,bank:"",account:"",source:"contract"};
 }
 if(value.startsWith("labor:")){
  const s=laborSheetInfo(db,pid);
  const v=db.prepare("SELECT result,evidence_json FROM verify_steps WHERE pid=? AND step_no=5").get(pid);
  let valid=false;
  try{valid=s.required&&v?.result==="通过"&&JSON.parse(v.evidence_json||"{}").laborSourceSignature===s.signature && JSON.parse(v.evidence_json||"{}").contractPoolSignature===contractPool(db,pid).signature;}catch{}
  if(!valid)throw bad("劳务表或个人合同发生变化，请重新核验第5项");
  const x=db.prepare("SELECT * FROM verified_labor_payees WHERE id=? AND pid=?").get(Number(value.slice(6)),pid);
  if(!x)throw bad("核销劳务收款人不存在");
  const account=reveal(x.account_cipher);
  if(!account)throw bad("劳务银行账号密钥不可用，不能生成付款申请");
  return {name:x.name,amount:x.amount,bank:x.bank,account,source:"labor"};
 }
 throw bad("请选择合同或已核销的劳务收款记录");
}
module.exports={options,resolve,saveLabor};
