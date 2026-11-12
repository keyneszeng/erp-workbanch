"use strict";
/** Real SQLite: verify step 2 uses only the current final agenda and speaker-photo originals. */
const {test}=require("node:test");
const assert=require("node:assert/strict");
const {DatabaseSync}=require("node:sqlite");
const {validateSopEvidence}=require("../server/lib/meeting-sop");
const pid="MP-SPEAKERS",project={id:pid,name:"测试会议",date:"2027-11-01",assoc:"测试协会",form:"线下"};
const evidence={agendaSpeakers:["张三教授","李四主任"],noOmissions:true};
function build(){
 const db=new DatabaseSync(":memory:");
 db.exec("CREATE TABLE materials(pid TEXT,kind TEXT,name TEXT,file_name TEXT,version TEXT,file_key TEXT,deleted_at TEXT)");
 const add=(kind,name,fileName=name+".pdf",version="v1",key=fileName,deletedAt=null)=>
  db.prepare("INSERT INTO materials(pid,kind,name,file_name,version,file_key,deleted_at) VALUES(?,?,?,?,?,?,?)")
  .run(pid,kind,name,fileName,version,key,deletedAt);
 add("终版议程","终版议程","终版议程.pdf","终版");
 add("签到表","签到表","签到表.xlsx");
 add("劳务表","劳务表","劳务表.xlsx");
 add("讲者照片","张三教授","张三照片.jpg");
 add("讲者照片","李四主任","李四主任.jpg");
 return {db,add};
}
test("讲者照片按原始文件名去后缀与议程姓名精确匹配",()=>{
 const {db}=build();
 const r=validateSopEvidence(2,evidence,project,db);
 assert.equal(r.matchedPeople,2);
 assert.equal(r.photoRecordsMatched,2);
 assert.deepEqual(r.matchedSources,["终版议程","讲者照片"]);
 assert.doesNotMatch(JSON.stringify(r),/张三|李四/);
 db.close();
});
test("签到表无关，不可要求第2项上传签到表或改变它的结论",()=>{
 const {db}=build();
 db.prepare("DELETE FROM materials WHERE kind IN ('签到表','劳务表')").run();
 assert.deepEqual(validateSopEvidence(2,evidence,project,db).matchedSources,["终版议程","讲者照片"]);
 db.close();
});
test("缺少终版议程或讲者照片原件必须拒绝核销",()=>{
 for(const kind of ["终版议程","讲者照片"]){
  const {db}=build();db.prepare("DELETE FROM materials WHERE kind=?").run(kind);
  assert.throws(()=>validateSopEvidence(2,evidence,project,db),x=>
   x.code==="SOP_MATERIAL_MISSING"&&x.message.includes(kind));
  db.close();
 }
});
test("仅有历史版议程、当前终版已删除均不能使用",()=>{
 for(const mode of ["历史版","删除"]){
  const {db}=build();
  if(mode==="历史版")db.prepare("UPDATE materials SET version='历史版' WHERE kind='终版议程'").run();
  else db.prepare("UPDATE materials SET deleted_at='2026-11-08' WHERE kind='终版议程'").run();
  assert.throws(()=>validateSopEvidence(2,evidence,project,db),/当前终版议程|缺少/);
  db.close();
 }
});
test("漏人、增人、重复同名照片、照片文件名与显示名称冲突均不通过",()=>{
 for(const change of [
  db=>db.prepare("DELETE FROM materials WHERE file_name='李四主任.jpg'").run(),
  db=>db.prepare("UPDATE materials SET file_name='赵六.jpg' WHERE file_name='李四主任.jpg'").run(),
  db=>db.prepare("UPDATE materials SET file_name='张三照片.jpg' WHERE file_name='李四主任.jpg'").run(),
  db=>db.prepare("UPDATE materials SET file_name='合影01.jpg' WHERE file_name='李四主任.jpg'").run()
 ]){
  const {db}=build();change(db);
  assert.throws(()=>validateSopEvidence(2,evidence,project,db),/照片原始文件名/);
  db.close();
 }
});
