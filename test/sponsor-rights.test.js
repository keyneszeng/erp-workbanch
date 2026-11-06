"use strict";
const {test}=require("node:test");
const assert=require("node:assert/strict");
const {DatabaseSync}=require("node:sqlite");
const {parseSponsorRights,normalizedCategories,sponsorRights,validateRightsEvidence}=require("../server/lib/sponsor-rights");
function fixture(){
 const db=new DatabaseSync(":memory:");
 db.exec("CREATE TABLE meeting_sponsor_contracts(id TEXT PRIMARY KEY,pid TEXT,enterprise TEXT,contract_no TEXT,status TEXT,file_key TEXT,file_name TEXT);"+
   "CREATE TABLE sponsor_rights(id INTEGER PRIMARY KEY,pid TEXT,sponsor_id TEXT,category TEXT,source TEXT,confirmed INTEGER,updated_at TEXT);"+
   "CREATE TABLE materials(id INTEGER PRIMARY KEY,pid TEXT,kind TEXT,name TEXT,file_name TEXT,file_key TEXT,version TEXT,deleted_at TEXT,sponsor_right_id INTEGER)");
 const addSponsor=(id,pid="P1",status="已签署")=>db.prepare(
  "INSERT INTO meeting_sponsor_contracts(id,pid,enterprise,contract_no,status,file_key) VALUES(?,?,?,?,?,?)")
  .run(id,pid,id+"医药","SC-"+id,status,id+".pdf");
 const addRight=(sid,category,confirmed=1,pid="P1")=>Number(db.prepare(
  "INSERT INTO sponsor_rights(pid,sponsor_id,category,source,confirmed,updated_at) VALUES(?,?,?,?,?,?)")
  .run(pid,sid,category,"manual",confirmed,"2026-11-06").lastInsertRowid);
 const addPhoto=(rid,pid="P1",file="photo.jpg")=>db.prepare(
  "INSERT INTO materials(pid,kind,name,file_name,file_key,version,sponsor_right_id) VALUES(?,?,?,?,?,?,?)")
  .run(pid,"权益照片","权益交付照片",file,file,"v1",rid);
 return {db,addSponsor,addRight,addPhoto};
}
test("OCR权益清单提取：仅从权益章节提取条目，停止于费用及违约章节",()=>{
 const s="第一章 双方约定\n赞助权益清单：\n1. 主会场背景板LOGO露出\n2. 会议手册企业鸣谢\n3. 企业展位展示\n合同金额：人民币100000元\n4. 分期付款义务";
 assert.deepEqual(parseSponsorRights(s),["主会场背景板LOGO露出","会议手册企业鸣谢","企业展位展示"]);
 assert.deepEqual(parseSponsorRights("协议金额5000元\n甲方信息\n没有权益清单"),[]);
 assert.throws(()=>normalizedCategories(["背景板Logo展示","背景板Logo展示"]),e=>e.code==="SPONSOR_RIGHTS_INVALID");
});
test("无已签赞助合同第7项不适用；待签合同不触发",()=>{
 const {db,addSponsor}=fixture();
 assert.equal(sponsorRights(db,"P1").required,false);
 addSponsor("A","P1","待确认");
 assert.equal(sponsorRights(db,"P1").required,false);
 assert.throws(()=>validateRightsEvidence(db,"P1",{}),e=>e.code==="SOP_NOT_APPLICABLE");
 db.close();
});
test("签署合同权益必须经人工确认，OCR建议不得直接视为权益交付",()=>{
 const {db,addSponsor,addRight,addPhoto}=fixture();
 addSponsor("A");
 const r=addRight("A","品牌背景板Logo露出",0);
 addPhoto(r);
 assert.throws(()=>validateRightsEvidence(db,"P1",{verifiedRights:[r]}),
  e=>e.code==="SPONSOR_RIGHTS_UNCONFIRMED");
 db.close();
});
test("同一项目不同赞助合同分别核对，缺照片或者漏勾均阻断",()=>{
 const {db,addSponsor,addRight,addPhoto}=fixture();
 addSponsor("A");addSponsor("B");
 const a=addRight("A","主背景板Logo展示"),b=addRight("B","展位展示");
 addPhoto(a);
 assert.throws(()=>validateRightsEvidence(db,"P1",{verifiedRights:[a,b]}),e=>e.code==="RIGHT_PHOTO_MISSING");
 addPhoto(b);
 assert.throws(()=>validateRightsEvidence(db,"P1",{verifiedRights:[a]}),e=>e.code==="RIGHTS_REVIEW_INCOMPLETE");
 const result=validateRightsEvidence(db,"P1",{verifiedRights:[b,a]});
 assert.equal(result.rightsMatched,2);
 assert.equal(result.sponsorsMatched,2);
 assert.equal(result.contentManuallyReviewed,true);
 assert.ok(result.rightsSignature.length>=32);
 db.close();
});
test("跨项目照片不算目标项目权益交付；更新照片或权益后会使旧签名失效",()=>{
 const {db,addSponsor,addRight,addPhoto}=fixture();
 addSponsor("A");
 const r=addRight("A","会议手册企业鸣谢");
 addPhoto(r,"P2","wrong-project.jpg");
 assert.throws(()=>validateRightsEvidence(db,"P1",{verifiedRights:[r]}),e=>e.code==="RIGHT_PHOTO_MISSING");
 addPhoto(r,"P1","original.jpg");
 const evidence=validateRightsEvidence(db,"P1",{verifiedRights:[r]});
 db.prepare("UPDATE materials SET file_key='replacement.jpg' WHERE pid='P1'").run();
 assert.notEqual(sponsorRights(db,"P1").signature,evidence.rightsSignature);
 db.close();
});
