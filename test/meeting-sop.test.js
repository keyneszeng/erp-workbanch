"use strict";
const {test}=require("node:test");
const assert=require("node:assert/strict");
const {validateSopEvidence,sameNames}=require("../server/lib/meeting-sop");
const project={id:"MP-TEST",name:"会议甲",date:"2026-11-01",assoc:"学会甲",form:"混合"};
const db={prepare(sql){return {get(pid,kind){return {n:1,total:1000};},all(){return [{name:"甲"},{name:"乙"}];}};}};
function expectBlock(no,evidence,p=project,amount=1000){
  assert.throws(()=>validateSopEvidence(no,evidence,p,db,amount));
}
test("六步核销必须有结构化证据，缺字段无法通过",()=>{
  for(let n=1;n<=6;n++)expectBlock(n,null);
});
test("盖章函件与串场三个字段一致即可通过；不需要招商主体或对照立项",()=>{
 const e={documentKind:"会议通知",meetingName:"会议乙",meetingDate:"2026-12-01",organizer:"学会乙",
   hostMeetingName:"会议乙",hostMeetingDate:"2026-12-01",hostOrganizer:"学会乙",
   stamped:true,final:true};
 const result=validateSopEvidence(1,e,project,db);
 assert.equal(result.fieldsMatched,3);
 assert.equal(result.comparedWith,"串场");
 assert.ok(!Object.hasOwn(result,"sponsor"));
 expectBlock(1,{...e,stamped:false});
 expectBlock(1,{...e,final:false});
 expectBlock(1,{...e,meetingDate:"2026-11-02"});
 expectBlock(1,{...e,hostMeetingName:"其他会议"});
 expectBlock(1,{...e,hostOrganizer:"其他学会"});
 expectBlock(1,{...e,hostMeetingDate:""});
 expectBlock(1,{...e,hostMeetingName:undefined});
});
test("第1步须有盖章函件及串场两份原件，不接受无附件材料登记",()=>{
 const e={documentKind:"会议通知",meetingName:"会议甲",meetingDate:"2026-11-01",organizer:"学会甲",
   hostMeetingName:"会议甲",hostMeetingDate:"2026-11-01",hostOrganizer:"学会甲",
   stamped:true,final:true};
 const withoutHost={prepare(sql){return {get(pid,kind){return {n:kind==="会议通知"?1:0};}};}};
 assert.throws(()=>validateSopEvidence(1,e,project,withoutHost),
   x=>x.code==="SOP_MATERIAL_MISSING"&&/串场原件/.test(x.message));
 const withoutNotice={prepare(sql){return {get(pid,kind){return {n:kind==="串场"?1:0};}};}};
 assert.throws(()=>validateSopEvidence(1,e,project,withoutNotice),
   x=>x.code==="SOP_MATERIAL_MISSING"&&/盖章/.test(x.message));
});
test("核销第1步页面不再有招商主体输入，需录入串场三项字段",()=>{
 const fs=require("node:fs"),path=require("node:path");
 const root=path.join(__dirname,"..");
 const form=fs.readFileSync(path.join(root,"web/assets/js/lib/sop-fields.js"),"utf8");
 const labels=fs.readFileSync(path.join(root,"server/lib/constants.js"),"utf8");
 const detail=fs.readFileSync(path.join(root,"web/assets/js/lib/verify-detail.js"),"utf8");
 assert.match(labels,/盖章函件与串场核验/);
 assert.match(form,/hostMeetingName/);
 assert.match(form,/hostMeetingDate/);
 assert.match(form,/hostOrganizer/);
 assert.doesNotMatch(form,/招商主体/);
 assert.match(detail,/\["会议通知","招商函","串场"\]/);
});
test("讲者五方一致：终版议程、劳务收集表、劳务协议、签到表、讲者照片",()=>{
 assert.equal(sameNames(["甲","乙"],["乙","甲"]),true);
 assert.equal(sameNames(["甲","甲"],["甲","甲"]),false);
 const x={agendaSpeakers:["甲","乙"],collectionSpeakers:["乙","甲"],agreementSpeakers:["甲","乙"],
   attendanceSpeakers:["乙","甲"],photoSpeakers:["甲","乙"],noOmissions:true};
 const result=validateSopEvidence(2,x,project,db);
 assert.equal(result.matchedPeople,2);
 assert.equal(result.photoRecordsMatched,2);
 assert.deepEqual(result.matchedSources,["终版议程","劳务收集表","劳务协议","签到表","讲者照片"]);
 assert.doesNotMatch(JSON.stringify(result),/甲|乙/,"讲者姓名不得写入核销证据摘要");
 for(const key of ["agendaSpeakers","collectionSpeakers","agreementSpeakers","attendanceSpeakers","photoSpeakers"]){
   expectBlock(2,{...x,[key]:["甲"]});
   expectBlock(2,{...x,[key]:["甲","甲"]});
   expectBlock(2,{...x,[key]:[]});
 }
 expectBlock(2,{...x,noOmissions:false});
 const noFile={prepare(sql){return {
   get(pid,kind){return {n:kind==="签到表"?0:1};},
   all(){return [{name:"甲"},{name:"乙"}];}
 };}};
 assert.throws(()=>validateSopEvidence(2,x,project,noFile),err=>
   err.code==="SOP_MATERIAL_MISSING"&&err.message.includes("签到表"));
 const noCurrentAgenda={prepare(sql){return {
   get(pid,kind){return {n:sql.includes("version='终版'")?0:1};},
   all(){return [{name:"甲"},{name:"乙"}];}
 };}};
 assert.throws(()=>validateSopEvidence(2,x,project,noCurrentAgenda),err=>
   err.code==="SOP_MATERIAL_MISSING"&&err.message.includes("当前终版议程"));
 const wrongPhotos={prepare(sql){return {
   get(){return {n:1};},all(){return [{name:"甲"},{name:"另一个人"}];}
 };}};
 assert.throws(()=>validateSopEvidence(2,x,project,wrongPhotos),err=>
   err.code==="SOP_EVIDENCE_MISMATCH"&&err.message.includes("照片登记姓名"));
 const duplicatePhotos={prepare(sql){return {
   get(){return {n:1};},all(){return [{name:"甲"},{name:"甲"}];}
 };}};
 assert.throws(()=>validateSopEvidence(2,x,project,duplicatePhotos),/照片登记姓名/);
});
test("第2步页面必须列出五份关联材料和五个讲者姓名输入",()=>{
 const fs=require("node:fs"),path=require("node:path");
 const root=path.join(__dirname,"..");
 const labels=fs.readFileSync(path.join(root,"server/lib/constants.js"),"utf8");
 const form=fs.readFileSync(path.join(root,"web/assets/js/lib/sop-fields.js"),"utf8");
 const detail=fs.readFileSync(path.join(root,"web/assets/js/lib/verify-detail.js"),"utf8");
 assert.match(labels,/讲者信息多处一致/);
 assert.match(labels,/终版议程 ∩ 劳务收集表 ∩ 劳务协议 ∩ 签到表 ∩ 讲者照片/);
 for(const key of ["agendaSpeakers","collectionSpeakers","agreementSpeakers","attendanceSpeakers","photoSpeakers"])
   assert.match(form,new RegExp(key));
 assert.match(detail,/\["终版议程","劳务收集表","劳务协议","签到表","讲者照片"\]/);
});
test("线上时长严格大于30，混合会议同时需要签到",()=>{
 expectBlock(3,{onlineMinutes:30,signedAttendance:true});
 expectBlock(3,{onlineMinutes:31,signedAttendance:false});
 assert.equal(validateSopEvidence(3,{onlineMinutes:31,signedAttendance:true},project,db).format,"混合");
 assert.equal(validateSopEvidence(3,{signedAttendance:true},{...project,form:"线下"},db).format,"线下");
});
test("第4步仅要求课件主题包含在终版议程内，允许议程有其他未上传课件主题",()=>{
 const e={agendaTopics:["课题甲","课题乙","课题丙"],courseTopics:["课题乙"]};
 const result=validateSopEvidence(4,e,project,db);
 assert.equal(result.matchedTopics,1);
 assert.equal(result.comparedWith,"终版议程");
 assert.ok(!Object.hasOwn(result,"hostNameLogoMatches"));
 assert.ok(!Object.hasOwn(result,"sponsorLogoPages"));
 assert.doesNotMatch(JSON.stringify(result),/课题乙/,"核销摘要不应保存主题原文");
 assert.equal(validateSopEvidence(4,{...e,courseTopics:["课题甲","课题丙"]},project,db).matchedTopics,2);
 assert.equal(validateSopEvidence(4,{...e,courseTopics:["课 题 乙"]},project,db).matchedTopics,1,
   "允许课题名称中多余的空格，但不使用模糊匹配");
 expectBlock(4,{...e,courseTopics:["不在议程中的课题"]});
 expectBlock(4,{...e,courseTopics:["课题乙","不在议程中的课题"]});
 expectBlock(4,{...e,courseTopics:[]});
 expectBlock(4,{...e,agendaTopics:[]});
 expectBlock(4,{...e,agendaTopics:["课题甲"]});
 const noLogoFields={...e,courseTopics:["课题甲"],hostTitleMatches:false,
   hostNameLogoMatches:false,sponsorLogoPages:["正文"]};
 assert.equal(validateSopEvidence(4,noLogoFields,project,db).matchedTopics,1,
   "旧版串场与 Logo 字段不应再作为核验条件");
});
test("核销第4步文字、关联材料与表单中不再包含串场和 Logo 必填项",()=>{
 const fs=require("node:fs"),path=require("node:path");
 const root=path.join(__dirname,"..");
 const labels=fs.readFileSync(path.join(root,"server/lib/constants.js"),"utf8");
 const form=fs.readFileSync(path.join(root,"web/assets/js/lib/sop-fields.js"),"utf8");
 const detail=fs.readFileSync(path.join(root,"web/assets/js/lib/verify-detail.js"),"utf8");
 assert.match(labels,/name: "课件主题在终版议程里"/);
 assert.match(detail,/4:\["终版议程","课件"\]/);
 assert.ok(form.includes('area("agendaTopics"'));
 assert.ok(form.includes('area("courseTopics"'));
 const stepFour=form.split("    4:area(")[1]?.split("    5:area(")[0]||"";
 assert.ok(stepFour);
 assert.doesNotMatch(stepFour,/hostTitleMatches|hostNameLogoMatches|sponsorLogoPages|logo首页|药企/);
});
test("劳务五字段即时比对，不保留任何姓名或银行账号",()=>{
 const a={name:"甲",time:"9:00",role:"讲者",amount:"100",bankAccount:"IN_MEMORY_ONLY"};
 const e={collectionRecords:[a],agreementRecords:[a]};
 const result=validateSopEvidence(5,e,project,db);
 assert.equal(result.matchedLaborRecords,1);
 assert.doesNotMatch(JSON.stringify(result),/IN_MEMORY_ONLY|甲/);
 expectBlock(5,{...e,agreementRecords:[{...a,role:"主持"}]});
});
test("正式结算单不能提前生成；核销只校验拟结算金额与会议基线",()=>{
 const e={draftAmount:1000,meetingName:project.name,meetingDate:project.date};
 assert.equal(validateSopEvidence(6,e,project,db,1000).meetingMatched,true);
 expectBlock(6,{...e,draftAmount:999},project,1000);
 expectBlock(6,{...e,meetingName:"其他会议"},project,1000);
});
