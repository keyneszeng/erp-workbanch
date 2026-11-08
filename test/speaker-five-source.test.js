"use strict";
/** 真实 SQLite：第二项只对比终版议程、签到表、讲者照片；劳务表不影响此项。 */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { DatabaseSync } = require("node:sqlite");
const { validateSopEvidence } = require("../server/lib/meeting-sop");
const pid="MP-FIVE-SOURCES";
const project={id:pid,name:"测试会议",date:"2027-11-01",assoc:"测试协会",form:"线下"};
const base={
  agendaSpeakers:["李老师","王老师"],
  attendanceSpeakers:["王老师","李老师"],
  photoSpeakers:["李老师","王老师"],
  noOmissions:true
};
const kinds=["终版议程","劳务收集表","签到表"];
function build(){
  const db=new DatabaseSync(":memory:");
  db.exec("CREATE TABLE materials(pid TEXT,kind TEXT,name TEXT,version TEXT,file_key TEXT,deleted_at TEXT)");
  const add=(kind,name,version="v1",key="test.pdf",deleted_at=null)=>
    db.prepare("INSERT INTO materials(pid,kind,name,version,file_key,deleted_at) VALUES(?,?,?,?,?,?)")
      .run(pid,kind,name,version,key,deleted_at);
  for(const k of kinds)add(k,k,k==="终版议程"?"终版":"v1");
  add("讲者照片","李老师","v1","speaker1.jpg");
  add("讲者照片","王老师","v1","speaker2.jpg");
  return {db,add};
}
test("终版议程、签到表、讲者照片一致且附件真实时通过",()=>{
  const {db}=build();
  const r=validateSopEvidence(2,base,project,db);
  assert.equal(r.matchedPeople,2);
  assert.equal(r.photoRecordsMatched,2);
  assert.deepEqual(r.matchedSources,["终版议程","签到表","讲者照片"]);
  assert.doesNotMatch(JSON.stringify(r),/李老师|王老师/);
  db.close();
});
test("适用讲者名单任一漏名、重名、串名或未确认不得通过",()=>{
  const {db}=build();
  for(const k of ["agendaSpeakers","attendanceSpeakers","photoSpeakers"]){
    assert.throws(()=>validateSopEvidence(2,{...base,[k]:["李老师"]},project,db),/不一致|重复姓名/);
    assert.throws(()=>validateSopEvidence(2,{...base,[k]:["李老师","李老师"]},project,db),/不一致|重复姓名/);
  }
  assert.throws(()=>validateSopEvidence(2,{...base,noOmissions:false},project,db),/人工确认/);
  db.close();
});
test("缺失必需原件、或只登记文件名却没有附件，不能通过",()=>{
  for(const kind of ["终版议程","签到表","讲者照片"]){
    const {db}=build();
    db.prepare("DELETE FROM materials WHERE kind=?").run(kind);
    assert.throws(()=>validateSopEvidence(2,base,project,db),err=>
      err.code==="SOP_MATERIAL_MISSING" && err.message.includes(kind));
    db.close();
  }
  const {db}=build();
  db.prepare("UPDATE materials SET file_key='' WHERE kind='签到表'").run();
  assert.throws(()=>validateSopEvidence(2,base,project,db),/缺少已上传的 签到表/);
  db.close();
});
test("劳务表缺失或其中姓名不一致，不影响第2项三份材料核验",()=>{
  const {db}=build();
  db.prepare("DELETE FROM materials WHERE kind='劳务收集表'").run();
  const r=validateSopEvidence(2,{...base,collectionSpeakers:["另一个人"]},project,db);
  assert.deepEqual(r.matchedSources,["终版议程","签到表","讲者照片"]);
  db.close();
  const other=build();
  const withLabor=validateSopEvidence(2,{...base,collectionSpeakers:["另一个人"]},project,other.db);
  assert.deepEqual(withLabor.matchedSources,["终版议程","签到表","讲者照片"]);
  other.db.close();
});
test("仅有历史议程而没有当前终版，不能用于第2步核销",()=>{
  const {db}=build();
  db.prepare("UPDATE materials SET version='历史版' WHERE kind='终版议程'").run();
  assert.throws(()=>validateSopEvidence(2,base,project,db),err=>
    err.code==="SOP_MATERIAL_MISSING" && /当前终版议程/.test(err.message));
  db.close();
});
test("照片姓名依真实材料记录核对，漏照片、重复照片、冒名照片都不能通过",()=>{
  for(const mutate of [
    db=>db.prepare("DELETE FROM materials WHERE kind='讲者照片' AND name='王老师'").run(),
    db=>db.prepare("UPDATE materials SET name='冒名讲者' WHERE kind='讲者照片' AND name='王老师'").run(),
    db=>db.prepare("UPDATE materials SET name='李老师' WHERE kind='讲者照片' AND name='王老师'").run()
  ]){
    const {db}=build();mutate(db);
    assert.throws(()=>validateSopEvidence(2,base,project,db),/照片登记姓名/);
    db.close();
  }
});
