"use strict";
/** Step 6 is strictly meeting demand form + meeting-demand ledger contract + meeting invoice. */
const {test}=require("node:test");
const assert=require("node:assert/strict");
const {DatabaseSync}=require("node:sqlite");
const {demandSopState}=require("../server/lib/meeting-demand-sop");
const {validateSopEvidence}=require("../server/lib/meeting-sop");
const project={id:"MP-MEETING-DEMAND",name:"年度论坛",date:"2027-08-10",assoc:"测试医学会",form:"线下"};
const reviewed={demandReviewed:true,meetingContractReviewed:true,meetingInvoiceReviewed:true};
function setup(){
 const db=new DatabaseSync(":memory:");
 db.exec("CREATE TABLE demand_sheets(pid TEXT PRIMARY KEY,confirmed INTEGER);"+
  "CREATE TABLE demand_items(id INTEGER PRIMARY KEY,pid TEXT,grp TEXT,item TEXT,need TEXT,budget TEXT,quantity TEXT,unit_price TEXT);"+
  "CREATE TABLE contracts(id TEXT PRIMARY KEY,pid TEXT,name TEXT,category TEXT,amount REAL,status TEXT,file_key TEXT);"+
  "CREATE TABLE materials(id INTEGER PRIMARY KEY,pid TEXT,kind TEXT,name TEXT,file_name TEXT,file_key TEXT,version TEXT,deleted_at TEXT)");
 const addMaterial=(kind,name,fileKey=null)=>db.prepare(
  "INSERT INTO materials(pid,kind,name,file_name,file_key,version) VALUES (?,?,?,?,?,'v1')"
 ).run(project.id,kind,name,name+".pdf",fileKey||"file-"+name+".pdf");
 const addContract=(id,name,category,amount=8000,fileKey=null)=>db.prepare(
  "INSERT INTO contracts(id,pid,name,category,amount,status,file_key) VALUES (?,?,?,?,?,'已签署',?)"
 ).run(id,project.id,name,category,amount,fileKey);
 return {db,addMaterial,addContract};
}
function addDemand(db,need="需要",budget="8000"){
 db.prepare("INSERT INTO demand_sheets(pid,confirmed) VALUES (?,1)").run(project.id);
 db.prepare("INSERT INTO demand_items(pid,grp,item,need,budget,quantity,unit_price) VALUES (?,?,?,?,?,?,?)")
  .run(project.id,"执行","会务执行服务",need,budget,"1",budget);
}
function addThreeSources(db,addMaterial,addContract,amount=8000){
 addContract("HT-MEETING","会务执行合同","会务需求",amount,"meeting.pdf");
 addMaterial("合同","HT-MEETING · 会务执行合同","meeting.pdf");
 addMaterial("会务发票","会务发票","invoice.pdf");
}
test("第6项：没有会务需求单不适用；即使全为不需要，有真实需求单仍必核",()=>{
 const {db}=setup();
 assert.equal(demandSopState(db,project.id).required,false);
 assert.throws(()=>validateSopEvidence(6,reviewed,project,db,0),
  e=>e.code==="SOP_NOT_APPLICABLE");
 addDemand(db,"不需要","8000");
 const state=demandSopState(db,project.id);
 assert.equal(state.required,true);
 assert.equal(state.budgetTotal,0);
 assert.equal(state.needCount,0);
 db.close();
});
test("三单一致：仅会务需求表、会务需求类别合同原件和会务发票，终版议程不参与",()=>{
 const {db,addMaterial,addContract}=setup();
 addDemand(db);addThreeSources(db,addMaterial,addContract);
 const d=demandSopState(db,project.id);
 assert.equal(d.required,true);
 assert.equal(d.contractCount,1);
 assert.deepEqual(d.agreements.map(x=>x.file_key),["meeting.pdf"]);
 assert.deepEqual(d.invoices.map(x=>x.file_key),["invoice.pdf"]);
 assert.equal(d.budgetTotal,8000);
 const result=validateSopEvidence(6,reviewed,project,db,8000);
 assert.equal(result.matchedFields,3);
 assert.equal(result.meetingMatched,true);
 assert.equal(result.comparedWith,"会务需求表+会务合同+会务发票");
 assert.equal(result.demandBudget,8000);
 db.close();
});
test("缺会务合同原件或会务发票不得通过；删终版议程不影响第6项",()=>{
 for(const kind of ["合同","会务发票"]){
  const {db,addMaterial,addContract}=setup();addDemand(db);
  addThreeSources(db,addMaterial,addContract);
  db.prepare("DELETE FROM materials WHERE pid=? AND kind=?").run(project.id,kind);
  assert.throws(()=>validateSopEvidence(6,reviewed,project,db,8000),
   e=>e.code==="SOP_MATERIAL_MISSING");
  db.close();
 }
});
test("三方原件须人工检查；不能用原来的议程七字段冒充核验",()=>{
 const {db,addMaterial,addContract}=setup();addDemand(db);
 addThreeSources(db,addMaterial,addContract);
 for(const k of Object.keys(reviewed))
  assert.throws(()=>validateSopEvidence(6,{...reviewed,[k]:false},project,db,8000),/人工检查/);
 assert.throws(()=>validateSopEvidence(6,{agendaTitle:"论坛",agreementFinal:true},project,db,8000),/人工检查/);
 db.close();
});
test("会务需求预算、已签会务合同、会务发票必须金额一致",()=>{
 const {db,addMaterial,addContract}=setup();addDemand(db);
 addThreeSources(db,addMaterial,addContract);
 assert.throws(()=>validateSopEvidence(6,reviewed,project,db,7999),/发票/);
 db.prepare("UPDATE contracts SET amount=7999 WHERE id='HT-MEETING'").run();
 assert.throws(()=>validateSopEvidence(6,reviewed,project,db,8000),/总预算/);
 db.close();
});
test("劳务专家、企业赞助合同和无关材料不参与第6项金额及证据签名",()=>{
 const {db,addMaterial,addContract}=setup();addDemand(db);
 addThreeSources(db,addMaterial,addContract);
 addContract("HT-LABOR","张三讲课合同","劳务专家",1000,"labor.pdf");
 addContract("HT-SPONSOR","企业赞助合同","企业赞助",12000,"sponsor.pdf");
 addMaterial("合同","企业赞助合同","sponsor.pdf");
 addMaterial("合同","劳务专家合同","labor.pdf");
 addMaterial("终版议程","终版议程","agenda.pdf");
 addMaterial("发票","普通收据","other-invoice.pdf");
 const d=demandSopState(db,project.id);
 assert.equal(d.contractTotal,8000);
 assert.deepEqual(d.agreements.map(x=>x.file_key),["meeting.pdf"]);
 assert.deepEqual(d.invoices.map(x=>x.file_key),["invoice.pdf"]);
 const first=d.signature;
 db.prepare("UPDATE contracts SET amount=14000 WHERE id='HT-SPONSOR'").run();
 db.prepare("UPDATE materials SET file_key='agenda-new.pdf' WHERE kind='终版议程'").run();
 assert.equal(demandSopState(db,project.id).signature,first);
 db.prepare("UPDATE materials SET file_key='meeting-replaced.pdf' WHERE file_key='meeting.pdf'").run();
 assert.notEqual(demandSopState(db,project.id).signature,first);
 db.close();
});
test("会务需求表未确认归档，不得用已录金额直接通过",()=>{
 const {db,addMaterial,addContract}=setup();addDemand(db);
 addThreeSources(db,addMaterial,addContract);
 db.prepare("UPDATE demand_sheets SET confirmed=0").run();
 assert.throws(()=>validateSopEvidence(6,reviewed,project,db,8000),
  e=>e.code==="DEMAND_NOT_CONFIRMED");
 db.close();
});
