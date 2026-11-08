"use strict";
const {test}=require("node:test");
const assert=require("node:assert/strict");
const {DatabaseSync}=require("node:sqlite");
const {validateSopEvidence}=require("../server/lib/meeting-sop");
const {linkLaborContracts,contractPool,matchesPerson}=require("../server/lib/labor-contracts");
const project={id:"MP-PERSON-CONTRACT",name:"测试会议",date:"2027-01-01",form:"线下"};
const record=(name)=>({name,time:"2027-01-01",role:"讲者",amount:"1000",bankAccount:"NEVER_LOG_BANK"});
function fixture(){
 const db=new DatabaseSync(":memory:");
 db.exec("CREATE TABLE materials(id INTEGER PRIMARY KEY AUTOINCREMENT,pid TEXT,kind TEXT,name TEXT,file_name TEXT,file_key TEXT,deleted_at TEXT)");
 const add=(pid,kind,name,file_name,file_key="file.pdf",deleted_at=null)=>
   Number(db.prepare("INSERT INTO materials(pid,kind,name,file_name,file_key,deleted_at) VALUES(?,?,?,?,?,?)")
     .run(pid,kind,name,file_name,file_key,deleted_at).lastInsertRowid);
 add(project.id,"劳务表","本项目劳务表","labor.pdf","labor.pdf");
 return {db,add};
}
test("逐人匹配：甲合同、乙本人.pdf；不读取合同台账总合同",()=>{
 const {db,add}=fixture();
 const a=add(project.id,"合同","专家合同","甲合同.pdf","file-a.pdf");
 const b=add(project.id,"合同","乙","乙.pdf","file-b.pdf");
 add(project.id,"合同","会议服务合同","venue.pdf","file-c.pdf");
 const r=validateSopEvidence(5,{collectionRecords:[record("甲"),record("乙")]},project,db);
 assert.equal(r.matchedContracts,2);
 assert.deepEqual(r.matchedContractMaterialIds,[a,b]);
 assert.ok(r.contractPoolSignature.length>=32);
 assert.doesNotMatch(JSON.stringify(r),/NEVER_LOG_BANK|姓名|乙|甲/);
 db.close();
});
test("只有总合同，或其他项目的个人合同，均不允许通过",()=>{
 const {db,add}=fixture();
 add(project.id,"合同","会议服务总合同","总合同.pdf");
 add("MP-OTHER","合同","甲","甲.pdf");
 assert.throws(()=>validateSopEvidence(5,{collectionRecords:[record("甲")]},project,db),
   e=>e.code==="SOP_PERSON_CONTRACT_MISSING");
 db.close();
});
test("不进行姓氏/子串猜测：甲不匹配甲乙，不匹配扫描件的正文",()=>{
 const {db,add}=fixture();
 add(project.id,"合同","甲乙","甲乙.pdf");
 assert.equal(matchesPerson({name:"甲乙",file_name:"甲乙.pdf"},"甲"),false);
 assert.throws(()=>validateSopEvidence(5,{collectionRecords:[record("甲")]},project,db),
   e=>e.code==="SOP_PERSON_CONTRACT_MISSING");
 db.close();
});
test("同一人有两份合同候选时报歧义，不随机关联",()=>{
 const {db,add}=fixture();
 add(project.id,"合同","甲","甲.pdf","x.pdf");
 add(project.id,"合同","甲劳务合同","甲劳务合同.pdf","y.pdf");
 assert.throws(()=>validateSopEvidence(5,{collectionRecords:[record("甲")]},project,db),
   e=>e.code==="SOP_PERSON_CONTRACT_AMBIGUOUS");
 db.close();
});
test("已删除、无真实附件、非合同类别不参与匹配",()=>{
 const {db,add}=fixture();
 add(project.id,"合同","甲","甲.pdf","removed.pdf","2026-12-31");
 add(project.id,"合同","甲","甲.pdf",null);
 add(project.id,"发票","甲","甲.pdf","receipt.pdf");
 assert.throws(()=>validateSopEvidence(5,{collectionRecords:[record("甲")]},project,db),
   e=>e.code==="SOP_PERSON_CONTRACT_MISSING");
 db.close();
});
test("同名合同重新上传或重新命名会改变指纹，防止旧核验结论复用",()=>{
 const {db,add}=fixture();
 const id=add(project.id,"合同","甲","甲.pdf","original.pdf");
 const first=contractPool(db,project.id).signature;
 db.prepare("UPDATE materials SET file_key='replacement.pdf' WHERE id=?").run(id);
 assert.notEqual(contractPool(db,project.id).signature,first);
 const second=contractPool(db,project.id).signature;
 add(project.id,"合同","乙","乙.pdf","other.pdf");
 assert.notEqual(contractPool(db,project.id).signature,second);
 db.close();
});
