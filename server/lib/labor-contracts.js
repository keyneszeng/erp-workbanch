"use strict";
const crypto=require("node:crypto");

/**
 * Step 5 sources ONLY:
 *  - archived expert-labor contract documents;
 *  - documents linked by file_key to THIS project's ledger contract whose
 *    category is exactly "劳务专家".
 * A generic material kind="合同" is not proof that it is an expert contract.
 * Meeting services, sponsor, venue and other contracts must never leak into
 * the labor verification or invalidate its evidence when they change.
 */
const EXPERT_KINDS=new Set(["劳务专家合同","专家劳务合同","劳务合同","专家合同"]);
const EXPLICIT_EXPERT=/(?:劳务专家|专家劳务|劳务合同|专家合同|讲课合同|讲师合同|讲者合同|授课合同|劳务服务合同)/u;
const OTHER_BUSINESS=/(?:赞助合同|企业赞助|招商合同|会务合同|会务协议|会议服务合同|场地合同|酒店合同|采购合同|设备合同)/u;
function isExpertDocument(m){
 if(EXPERT_KINDS.has(String(m.kind||"")))return true;
 if(m.kind!=="合同")return false;
 const title=String(m.name||"")+" "+String(m.file_name||"");
 return EXPLICIT_EXPERT.test(title)&&!OTHER_BUSINESS.test(title);
}
/** Use immutable file key, not a similar contract title, for ledger association. */
function contractPool(db,pid){
 const rows=db.prepare(
  "SELECT rowid AS id,kind,name,file_name,file_key FROM materials WHERE pid=? "+
  "AND kind IN ('合同','劳务专家合同','专家劳务合同','劳务合同','专家合同') "+
  "AND (deleted_at IS NULL OR deleted_at='') "+
  "AND file_key IS NOT NULL AND file_key<>'' ORDER BY id"
 ).all(pid);
 const ledgers=db.prepare(
  "SELECT id,name,vendor,category,status,file_key FROM contracts WHERE pid=? "+
  "AND file_key IS NOT NULL AND file_key<>'' ORDER BY id"
 ).all(pid);
 const byKey=new Map();
 for(const c of ledgers){
  const key=String(c.file_key||"");
  if(!byKey.has(key))byKey.set(key,[]);
  byKey.get(key).push(c);
 }
 const onlyLabor=rows.flatMap(m=>{
  const linked=byKey.get(m.file_key)||[];
  // If an archived document is owned by ANY explicitly categorized ledger
  // contract, its ledger category is authoritative. No name-based override.
  if(linked.length){
   const eligible=linked.filter(x=>x.category==="劳务专家");
   if(eligible.length!==1 || eligible.length!==linked.length)return [];
   return [{...m,expertVendor:eligible[0].vendor,ledgerContractId:eligible[0].id,
     ledgerName:eligible[0].name,ledgerCategory:eligible[0].category,
     ledgerStatus:eligible[0].status}];
  }
  return isExpertDocument(m)?[{...m,expertVendor:"",ledgerContractId:""}]:[];
 });
 const signature=crypto.createHash("sha256").update(JSON.stringify(onlyLabor.map(r=>
  [r.id,r.kind,r.name,r.file_name,r.file_key,
   r.expertVendor,r.ledgerContractId,r.ledgerName,r.ledgerCategory,r.ledgerStatus]))).digest("hex");
 return {rows:onlyLabor,signature};
}
function personKey(s){
 return String(s??"").normalize("NFKC").replace(/\s+/g,"").trim();
}
function contractNameKey(text){
 return personKey(text)
  .replace(/\.(?:pdf|docx?|png|jpe?g|webp|xlsx?|pptx?)$/i,"")
  .replace(/(?:-|_|—|－)?(?:劳务专家合同|专家劳务合同|劳务服务合同|劳务合同|专家合同|讲课合同|讲师合同|授课合同|合同)$/u,"");
}
/** Exact complete name only; never use shared surnames or fuzzy substrings. */
function matchesPerson(material,person){
 const name=personKey(person);
 if(!name)return false;
 if(material.expertVendor&&personKey(material.expertVendor)===name)return true;
 return [material.file_name,material.name].some(t=>t&&contractNameKey(t)===name);
}
function linkLaborContracts(db,pid,people){
 const pool=contractPool(db,pid);
 const linked=[],missing=[],ambiguous=[];
 for(const person of people){
  const hits=pool.rows.filter(m=>matchesPerson(m,person));
  if(hits.length===0)missing.push(String(person));
  else if(hits.length>1)ambiguous.push(String(person));
  else linked.push(hits[0]);
 }
 return {linked,missing,ambiguous,contractPoolSignature:pool.signature};
}
module.exports={contractPool,linkLaborContracts,contractNameKey,matchesPerson,isExpertDocument};
