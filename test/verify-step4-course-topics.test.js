"use strict";
/** 第4步：课件原件存在，且课件主题逐一属于当前已确认终版议程。 */
const {test}=require("node:test");
const assert=require("node:assert/strict");
const {DatabaseSync}=require("node:sqlite");
const {validateSopEvidence}=require("../server/lib/meeting-sop");
const project={id:"MEETING-STEP4",name:"虚拟研讨会"};
const evidence={agendaTopics:["人工智能医疗","影像诊断","临床实践"],courseTopics:["影像诊断"]};
function fixture(){
  const db=new DatabaseSync(":memory:");
  db.exec("CREATE TABLE materials(pid TEXT,kind TEXT,version TEXT,file_key TEXT,deleted_at TEXT)");
  const add=(kind,version="普通版",file_key="file.pdf")=>
    db.prepare("INSERT INTO materials(pid,kind,version,file_key,deleted_at) VALUES(?,?,?,?,NULL)")
      .run(project.id,kind,version,file_key);
  add("课件");add("终版议程","终版");
  return {db,add};
}
test("上传课件且课件主题被终版议程包含即可通过，不要求串场和Logo",()=>{
  const {db}=fixture();
  const result=validateSopEvidence(4,evidence,project,db);
  assert.equal(result.matchedTopics,1);
  assert.equal(result.comparedWith,"终版议程");
  assert.equal(validateSopEvidence(4,{...evidence,courseTopics:["影像诊断","临床实践"]},project,db).matchedTopics,2);
  assert.equal(validateSopEvidence(4,{...evidence,hostNameLogoMatches:false,hostTitleMatches:false,
    sponsorLogoPages:["正文"]},project,db).matchedTopics,1);
  assert.doesNotMatch(JSON.stringify(result),/影像诊断|人工智能医疗|临床实践/);
  db.close();
});
test("仅在课件上传后允许通过；无原件/无终版/仅历史版都拦截",()=>{
  for(const change of [
    db=>db.prepare("DELETE FROM materials WHERE kind='课件'").run(),
    db=>db.prepare("UPDATE materials SET file_key='' WHERE kind='课件'").run(),
    db=>db.prepare("DELETE FROM materials WHERE kind='终版议程'").run(),
    db=>db.prepare("UPDATE materials SET version='历史版' WHERE kind='终版议程'").run(),
    db=>db.prepare("UPDATE materials SET file_key='' WHERE kind='终版议程'").run()
  ]){
    const {db}=fixture();change(db);
    assert.throws(()=>validateSopEvidence(4,evidence,project,db),
      err=>err.code==="SOP_MATERIAL_MISSING");
    db.close();
  }
});
test("课件主题必须在终版议程内；议程其他主题不需都有课件",()=>{
  const {db}=fixture();
  assert.equal(validateSopEvidence(4,evidence,project,db).matchedTopics,1);
  for(const other of [
    {agendaTopics:["人工智能医疗","影像诊断"],courseTopics:["不存在的主题"]},
    {agendaTopics:["影像诊断"],courseTopics:["影像诊断","不存在的主题"]},
    {agendaTopics:[],courseTopics:["影像诊断"]},
    {agendaTopics:["影像诊断"],courseTopics:[]}
  ])assert.throws(()=>validateSopEvidence(4,other,project,db));
  db.close();
});
