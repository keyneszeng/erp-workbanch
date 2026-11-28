"use strict";
const {test}=require("node:test"),assert=require("node:assert/strict");
const fs=require("node:fs"),os=require("node:os"),path=require("node:path");
const dir=fs.mkdtempSync(path.join(os.tmpdir(),"erp-meeting-code-"));
process.env.ERP_DB=path.join(dir,"data.sqlite");process.env.ERP_DB_BACKEND="";
const {db,migrate,transaction}=require("../server/lib/db");
const catalog=require("../server/lib/associations");
const {nextMeetingId}=require("../server/lib/meeting-codes");
migrate();
function add(assoc,date){
 return transaction(()=>{
  const id=nextMeetingId(db,assoc,date);
  db.prepare("INSERT INTO projects(id,name,assoc,form,date,days,budget,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)")
    .run(id,"编号回归会议",assoc,"线下",date,1,100,"草稿","2026-11-24","2026-11-24");
  return id;
 });
}
test("内置协会有唯一字母代码，历史MP项目不改变",()=>{
 const info=catalog.details();
 assert.equal(info.length,10);
 assert.equal(catalog.getCode("华东医学会"),"HDYX");
 assert.equal(catalog.getCode("护理协会"),"HLXH");
 assert.equal(new Set(info.map(x=>x.code)).size,info.length);
 db.prepare("INSERT INTO projects(id,name,assoc,form,date,days,budget,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)")
 .run("MP-2026-018","历史会议","华东医学会","线下","2026-12-01",1,100,"草稿","2026-11-24","2026-11-24");
 assert.equal(db.prepare("SELECT id FROM projects WHERE id='MP-2026-018'").get().id,"MP-2026-018");
});
test("三段编码：不同协会和不同举办年份独立计数",()=>{
 assert.equal(add("华东医学会","2027-03-01"),"HDYX-2027-001");
 assert.equal(add("华东医学会","2027-11-10"),"HDYX-2027-002");
 assert.equal(add("护理协会","2027-06-01"),"HLXH-2027-001");
 assert.equal(add("华东医学会","2028-01-01"),"HDYX-2028-001");
 assert.equal(add("华东医学会","2026-12-31"),"HDYX-2026-001");
});
test("同一事务失败序号回滚，删除已存在项目不回收旧序号",()=>{
 assert.throws(()=>transaction(()=>{
  assert.equal(nextMeetingId(db,"护理协会","2028-01-01"),"HLXH-2028-001");
  throw Error("测试失败");
 }),/测试失败/);
 assert.equal(add("护理协会","2028-01-01"),"HLXH-2028-001");
 db.prepare("DELETE FROM projects WHERE id='HLXH-2028-001'").run();
 assert.equal(add("护理协会","2028-01-01"),"HLXH-2028-002");
});
test("三位顺序号001至999：跨越99继续递增，达到999后明确提示",()=>{
 db.prepare("INSERT INTO meeting_code_sequences(code,year,last_seq) VALUES (?,?,?)").run("HLXH",2030,98);
 assert.equal(add("护理协会","2030-01-01"),"HLXH-2030-099");
 assert.equal(add("护理协会","2030-01-01"),"HLXH-2030-100");
 db.prepare("UPDATE meeting_code_sequences SET last_seq=998 WHERE code='HLXH' AND year=2030").run();
 assert.equal(add("护理协会","2030-01-01"),"HLXH-2030-999");
 assert.throws(()=>transaction(()=>nextMeetingId(db,"护理协会","2030-01-01")),e=>e.code==="MEETING_CODE_EXHAUSTED");
 assert.equal(db.prepare("SELECT last_seq FROM meeting_code_sequences WHERE code='HLXH' AND year=2030").get().last_seq,999);
});
test("缺少简称时先提示管理员配置；使用后锁定旧简写",()=>{
 db.prepare("INSERT INTO associations(name,active) VALUES (?,1)").run("未配置代码协会");
 assert.throws(()=>transaction(()=>nextMeetingId(db,"未配置代码协会","2027-05-15")),e=>e.code==="ASSOCIATION_CODE_REQUIRED");
 catalog.updateCode("未配置代码协会","WPH");
 assert.equal(add("未配置代码协会","2027-05-15"),"WPH-2027-001");
 assert.throws(()=>catalog.updateCode("未配置代码协会","WPHX"),e=>e.code==="ASSOCIATION_CODE_LOCKED");
});
test("兼容已有两位会议编号，不改写历史数据，继续递增",()=>{
 db.prepare("INSERT INTO projects(id,name,assoc,form,date,days,budget,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)")
 .run("HDYX-2031-07","历史编号导入","华东医学会","线下","2031-02-01",1,100,"草稿","2026-11-24","2026-11-24");
 assert.equal(add("华东医学会","2031-05-06"),"HDYX-2031-008");
 assert.equal(db.prepare("SELECT id FROM projects WHERE id='HDYX-2031-07'").get().id,"HDYX-2031-07");
 // Imported three-digit records may be ahead of the persisted counter.
 db.prepare("INSERT INTO projects(id,name,assoc,form,date,days,budget,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)")
 .run("HDYX-2031-105","三位历史编号导入","华东医学会","线下","2031-06-01",1,100,"草稿","2026-11-24","2026-11-24");
 assert.equal(add("华东医学会","2031-07-06"),"HDYX-2031-106");
});
process.on("exit",()=>fs.rmSync(dir,{recursive:true,force:true}));
