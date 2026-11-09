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
const normName=x=>String(x||"").normalize("NFKC").replace(/\s+/g,"").trim();
/** 第5步是否仍然有效（劳务表与专家合同池都没变）。 */
function laborValid(pid){
 const s=laborSheetInfo(db,pid);
 const v=db.prepare("SELECT result,evidence_json FROM verify_steps WHERE pid=? AND step_no=5").get(pid);
 try{
  const e=JSON.parse(v?.evidence_json||"{}");
  return !!(s.required&&v?.result==="通过"&&
   String(e.laborSourceSignature)===String(s.signature)&&
   String(e.contractPoolSignature)===String(contractPool(db,pid).signature));
 }catch{return false;}
}
/** 已核验的劳务收款人（已解密）。 */
function laborPayees(pid){
 if(!laborValid(pid))return [];
 const out=[];
 for(const x of db.prepare("SELECT id,name,bank,account_cipher,amount FROM verified_labor_payees WHERE pid=? ORDER BY id").all(pid)){
  const account=reveal(x.account_cipher);
  if(!account)continue;
  out.push({...x,account,maskedAccount:"尾号 "+account.slice(-4)});
 }
 return out;
}
/** 姓名 → 劳务收款人；同名多条记为 null（歧义，不自动关联）。 */
function indexByName(list){
 const map=new Map();
 for(const x of list){
  const k=normName(x.name);
  if(map.has(k))map.set(k,null); else map.set(k,x);
 }
 return map;
}
function options(pid){
 const contracts=db.prepare("SELECT id,vendor,amount,category FROM contracts WHERE pid=? AND status='已签署' AND COALESCE(category,'')<>'企业赞助' ORDER BY id").all(pid);
 const labor=laborPayees(pid),byName=indexByName(labor),used=new Set();
 const rows=contracts.map(x=>{
  const base={id:"contract:"+x.id,label:x.vendor+"（"+x.category+"合同）",payee:x.vendor,
   amount:x.amount,source:"contract",bank:"",maskedAccount:""};
  // 劳务专家合同的收款人是个人，银行信息只存在核销劳务表里。
  // 同名唯一时自动带出，避免财务再手输一遍账号（重名则不关联）。
  if(x.category==="劳务专家"){
   const m=byName.get(normName(x.vendor));
   if(m){
    used.add(m.id);
    return {...base,source:"labor",linkedContract:true,bank:m.bank,maskedAccount:m.maskedAccount};
   }
  }
  return base;
 });
 // 没有对应合同（或重名无法自动关联）的劳务收款人仍逐条列出，由财务按尾号选。
 for(const m of labor){
  if(used.has(m.id))continue;
  rows.push({id:"labor:"+m.id,label:m.name+"（核销劳务表）",payee:m.name,
   amount:m.amount,source:"labor",bank:m.bank,maskedAccount:m.maskedAccount});
 }
 return rows;
}
function resolve(pid,id){
 const value=String(id||"");
 if(value.startsWith("contract:")){
  const x=db.prepare("SELECT vendor,amount,category FROM contracts WHERE id=? AND pid=? AND status='已签署' AND COALESCE(category,'')<>'企业赞助'").get(value.slice(9),pid);
  if(!x)throw bad("选择的合同收款方不存在或未签署");
  if(x.category==="劳务专家"){
   const m=indexByName(laborPayees(pid)).get(normName(x.vendor));
   if(m)return {name:x.vendor,amount:x.amount,bank:m.bank,account:m.account,source:"labor"};
  }
  return {name:x.vendor,amount:x.amount,bank:"",account:"",source:"contract"};
 }
 if(value.startsWith("labor:")){
  if(!laborValid(pid))throw bad("劳务表或个人合同发生变化，请重新核验第5项");
  const x=db.prepare("SELECT * FROM verified_labor_payees WHERE id=? AND pid=?").get(Number(value.slice(6)),pid);
  if(!x)throw bad("核销劳务收款人不存在");
  const account=reveal(x.account_cipher);
  if(!account)throw bad("劳务银行账号密钥不可用，不能生成付款申请");
  return {name:x.name,amount:x.amount,bank:x.bank,account,source:"labor"};
 }
 throw bad("请选择合同或已核销的劳务收款记录");
}
module.exports={options,resolve,saveLabor};
