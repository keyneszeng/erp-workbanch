"use strict";
const {test}=require("node:test");
const assert=require("node:assert/strict");
const {DatabaseSync}=require("node:sqlite");
const {demandSopState}=require("../server/lib/meeting-demand-sop");
const {validateSopEvidence}=require("../server/lib/meeting-sop");
const project={id:"MP-MEETING-DEMAND",name:"年度论坛",date:"2027-08-10",assoc:"测试医学会",form:"线下"};
const fields={
  agendaTitle:"医学交流论坛",agendaTime:"2027-08-10 09:00-17:00",agendaFormat:"线下",
  agreementTitle:"医学交流论坛",agreementTime:"2027-08-10 09:00-17:00",agreementFormat:"线下",
  agreementPartyA:"测试医学会",agreementFinal:true
};
function setup(){
  const db=new DatabaseSync(":memory:");
  db.exec("CREATE TABLE demand_sheets(pid TEXT PRIMARY KEY,confirmed INTEGER);"+
    "CREATE TABLE demand_items(id INTEGER PRIMARY KEY,pid TEXT,grp TEXT,item TEXT,need TEXT,budget TEXT,quantity TEXT,unit_price TEXT);"+
    "CREATE TABLE contracts(id TEXT PRIMARY KEY,pid TEXT,name TEXT,category TEXT,amount REAL,status TEXT,file_key TEXT);"+
    "CREATE TABLE materials(id INTEGER PRIMARY KEY,pid TEXT,kind TEXT,name TEXT,file_name TEXT,file_key TEXT,version TEXT,deleted_at TEXT)");
  const addMaterial=(kind,name,version="终版")=>db.prepare(
    "INSERT INTO materials(pid,kind,name,file_name,file_key,version) VALUES(?,?,?,?,?,?)"
  ).run(project.id,kind,name,name+".pdf","file-"+name+".pdf",version);
  return {db,addMaterial};
}
function addDemand(db,need="需要",budget="8000"){
  db.prepare("INSERT INTO demand_sheets(pid,confirmed) VALUES (?,1)").run(project.id);
  db.prepare("INSERT INTO demand_items(pid,grp,item,need,budget,quantity,unit_price) VALUES (?,?,?,?,?,?,?)")
    .run(project.id,"执行","会务执行服务",need,budget,"1",budget);
}
function addRequired(db,addMaterial,amount=8000){
  db.prepare("INSERT INTO contracts(id,pid,name,category,amount,status) VALUES (?,?,?,?,?,?)")
    .run("HT-MEETING",project.id,"会务服务合同","其他",amount,"已签署");
  addMaterial("终版议程","终版议程","终版");
  addMaterial("会务协议","会务执行协议","终版");
  addMaterial("会务发票","会务发票","终版");
}
test("未建需求单/仅有默认不需要条目：第6项自动不适用",()=>{
  const {db}=setup();
  assert.equal(demandSopState(db,project.id).required,false);
  assert.throws(()=>validateSopEvidence(6,fields,project,db,0),e=>e.code==="SOP_NOT_APPLICABLE");
  addDemand(db,"不需要","8000");
  assert.equal(demandSopState(db,project.id).required,false);
  db.close();
});
test("有实际需要且确认：终版议程与会务协议字段匹配且预算=合同=发票",()=>{
  const {db,addMaterial}=setup();
  addDemand(db);addRequired(db,addMaterial);
  const state=demandSopState(db,project.id);
  assert.equal(state.required,true);assert.equal(state.budgetTotal,8000);
  assert.equal(state.contractTotal,8000);
  const r=validateSopEvidence(6,fields,project,db,8000);
  assert.equal(r.meetingMatched,true);
  assert.equal(r.needCount,1);
  assert.equal(r.meetingContractTotal,8000);
  assert.equal(r.demandBudget,8000);
  assert.ok(r.demandSopSignature);
  db.close();
});
test("缺会务协议、历史议程、缺发票原件不得核销",()=>{
  for(const kind of ["会务协议","终版议程","会务发票"]){
    const {db,addMaterial}=setup();
    addDemand(db);addRequired(db,addMaterial);
    db.prepare("DELETE FROM materials WHERE pid=? AND kind=?").run(project.id,kind);
    assert.throws(()=>validateSopEvidence(6,fields,project,db,8000),e=>e.code==="SOP_MATERIAL_MISSING");
    db.close();
  }
});
test("主题、时间、形式、协议甲方逐字段不一致拦截；终版确认不得省略",()=>{
  const {db,addMaterial}=setup();addDemand(db);addRequired(db,addMaterial);
  for(const [k,v] of [["agreementTitle","另一场活动"],["agreementTime","2027-08-11"],["agreementFormat","混合"],
                       ["agreementPartyA","其他协会"],["agreementFinal",false]]){
    assert.throws(()=>validateSopEvidence(6,{...fields,[k]:v},project,db,8000),/不一致|终版/);
  }
  db.close();
});
test("会务需求预算、会务合同总额、发票金额分别发生差异时必须阻断",()=>{
  const {db,addMaterial}=setup();addDemand(db);addRequired(db,addMaterial);
  assert.throws(()=>validateSopEvidence(6,fields,project,db,7999),/发票/);
  db.prepare("UPDATE contracts SET amount=7999 WHERE id='HT-MEETING'").run();
  assert.throws(()=>validateSopEvidence(6,fields,project,db,8000),/总预算/);
  db.close();
});
test("劳务专家合同不计入会务合同总额；文件或需求预算变化令摘要签名失效",()=>{
  const {db,addMaterial}=setup();addDemand(db);addRequired(db,addMaterial);
  db.prepare("INSERT INTO contracts(id,pid,name,category,amount,status) VALUES (?,?,?,?,?,?)")
    .run("HT-LABOR",project.id,"讲者合同","劳务专家",1000,"已签署");
  assert.equal(demandSopState(db,project.id).contractTotal,8000);
  const first=demandSopState(db,project.id).signature;
  db.prepare("UPDATE materials SET file_key='changed-agreement.pdf' WHERE kind='会务协议'").run();
  assert.notEqual(demandSopState(db,project.id).signature,first);
  const changed=demandSopState(db,project.id).signature;
  db.prepare("UPDATE demand_items SET budget='8001' WHERE pid=? AND need='需要'").run(project.id);
  assert.notEqual(demandSopState(db,project.id).signature,changed);
  db.close();
});
test("真实需求必须先确认归档，空需求不允许靠预填金额强行判定",()=>{
  const {db,addMaterial}=setup();addDemand(db);addRequired(db,addMaterial);
  db.prepare("UPDATE demand_sheets SET confirmed=0").run();
  assert.throws(()=>validateSopEvidence(6,fields,project,db,8000),e=>e.code==="DEMAND_NOT_CONFIRMED");
  db.close();
});
