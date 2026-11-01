"use strict";
const {test}=require("node:test");
const assert=require("node:assert/strict");
const {validateSopEvidence}=require("../server/lib/meeting-sop");
const p={id:"MP-SOP-MIX",name:"专家学术交流",date:"2027-11-01",assoc:"华东医学会",form:"线下"};
function proof(total,billable,hasInvoice=true){
 return {prepare(sql){return {get(){
   if(sql.includes("FROM contracts"))return {total:sql.includes("COALESCE(category")?billable:total};
   if(sql.includes("FROM materials"))return {n:hasInvoice?1:0};
   return {n:1};
  }};}};
}
const base={draftAmount:1000,meetingName:p.name,meetingDate:p.date};
test("SOP 6 reconciles total planned request to all signed contracts and invoices only to billable contracts",()=>{
 const db=proof(1000,700);
 const result=validateSopEvidence(6,base,p,db,700);
 assert.equal(result.invoiceAmount,700);
 assert.equal(result.nonInvoiceLaborAmount,300);
 assert.throws(()=>validateSopEvidence(6,{...base,draftAmount:900},p,db,700),/拟请款总额/);
 assert.throws(()=>validateSopEvidence(6,base,p,db,1000),/发票金额/);
});
test("SOP 6 supports purely expert-labor contracts without fabricating an invoice",()=>{
 const db=proof(300,0,false);
 const result=validateSopEvidence(6,{...base,draftAmount:300},p,db,0);
 assert.equal(result.nonInvoiceLaborAmount,300);
 assert.equal(result.invoiceAmount,0);
});
