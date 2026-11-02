"use strict";
const {test}=require("node:test");
const assert=require("node:assert/strict");
const {validateSopEvidence}=require("../server/lib/meeting-sop");
const p={id:"MP-SOP-MIX",name:"专家学术交流",date:"2027-11-01",assoc:"华东医学会",form:"线下"};
function proof(total,billable,hasInvoice=true){
 return {prepare(sql){return {get(){
   // 第 6 步有两条合同查询：合同总额（全部支出合同）与「可开票」金额（排除劳务专家）。
   // 用「排除劳务专家」这个条件区分，别用 COALESCE(category —— 收入类排除条件里也有它。
   if(sql.includes("FROM contracts"))return {total:sql.includes("<>'劳务专家'")?billable:total};
   if(sql.includes("FROM materials"))return {n:hasInvoice?1:0};
   return {n:1};
  }};}};
}
const base={draftAmount:1000,meetingName:p.name,meetingDate:p.date};
test("SOP 6 只校验拟请款总额与已签合同一致，不再比对发票金额",()=>{
 const db=proof(1000,700);
 const result=validateSopEvidence(6,base,p,db);
 assert.equal(result.draftAmount,1000);
 assert.equal(result.meetingMatched,true);
 assert.equal(result.invoiceAmount,undefined,"发票金额已不再记录");
 // 拟请款与合同总额不符 → 拦
 assert.throws(()=>validateSopEvidence(6,{...base,draftAmount:900},p,db),/拟请款总额/);
 // 发票金额传什么都不再影响判定（规则已去掉）
 assert.doesNotThrow(()=>validateSopEvidence(6,base,p,db,1000));
 assert.doesNotThrow(()=>validateSopEvidence(6,base,p,db,0));
});
test("SOP 6 纯专家劳务合同：没有发票原件也不拦",()=>{
 const db=proof(300,0,false);
 const result=validateSopEvidence(6,{...base,draftAmount:300},p,db);
 assert.equal(result.draftAmount,300);
});
