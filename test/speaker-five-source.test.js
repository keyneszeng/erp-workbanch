"use strict";
/** 使用真实 SQLite 记录核验第2步：五份源材料、照片登记姓名和当前终版。 */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { DatabaseSync } = require("node:sqlite");
const { validateSopEvidence } = require("../server/lib/meeting-sop");
const pid="MP-FIVE-SOURCES";
const project={id:pid,name:"测试会议",date:"2027-11-01",assoc:"测试协会",form:"线下"};
const base={
  agendaSpeakers:["李老师","王老师"],
  collectionSpeakers:["王老师","李老师"],
  agreementSpeakers:["李老师","王老师"],
  attendanceSpeakers:["王老师","李老师"],
  photoSpeakers:["李老师","王老师"],
  noOmissions:true
};
const kinds=["终版议程","劳务收集表","劳务协议","签到表"];
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
test("五方信息一致且各原件真实关联时成功，仅保存人数/来源摘要",()=>{
  const {db}=build();
  const r=validateSopEvidence(2,base,project,db);
  assert.equal(r.matchedPeople,2);
  assert.equal(r.photoRecordsMatched,2);
  assert.deepEqual(r.matchedSources,["终版议程","劳务收集表","劳务协议","签到表","讲者照片"]);
  assert.doesNotMatch(JSON.stringify(r),/李老师|王老师/);
  db.close();
});
test("五方任一漏名、重名、串名或未人工确认均不能通过",()=>{
  const {db}=build();
  for(const k of ["agendaSpeakers","collectionSpeakers","agreementSpeakers","attendanceSpeakers","photoSpeakers"]){
    assert.throws(()=>validateSopEvidence(2,{...base,[k]:["李老师"]},project,db),/不一致/);
    assert.throws(()=>validateSopEvidence(2,{...base,[k]:["李老师","李老师"]},project,db),/不一致/);
  }
  assert.throws(()=>validateSopEvidence(2,{...base,noOmissions:false},project,db),/人工确认/);
  db.close();
});
test("缺失五类原件中的任意一类，或只存材料名称没有附件，不能通过",()=>{
  for(const kind of [...kinds,"讲者照片"]){
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
