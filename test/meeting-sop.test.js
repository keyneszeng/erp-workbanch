"use strict";
const {test}=require("node:test");
const assert=require("node:assert/strict");
const {validateSopEvidence,sameNames}=require("../server/lib/meeting-sop");
const project={id:"MP-TEST",name:"会议甲",date:"2026-11-01",assoc:"学会甲",form:"混合"};
const db={prepare(sql){return {get(pid,kind){return {n:1,total:1000};}};}};
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
test("讲者三份名单必须完全覆盖且不得重名",()=>{
 assert.equal(sameNames(["甲","乙"],["乙","甲"]),true);
 assert.equal(sameNames(["甲","甲"],["甲","甲"]),false);
 expectBlock(2,{agendaSpeakers:["甲","乙"],collectionSpeakers:["甲"],agreementSpeakers:["甲","乙"],noOmissions:true});
 const x={agendaSpeakers:["甲","乙"],collectionSpeakers:["乙","甲"],agreementSpeakers:["甲","乙"],noOmissions:true};
 assert.equal(validateSopEvidence(2,x,project,db).matchedPeople,2);
});
test("线上时长严格大于30，混合会议同时需要签到",()=>{
 expectBlock(3,{onlineMinutes:30,signedAttendance:true});
 expectBlock(3,{onlineMinutes:31,signedAttendance:false});
 assert.equal(validateSopEvidence(3,{onlineMinutes:31,signedAttendance:true},project,db).format,"混合");
 assert.equal(validateSopEvidence(3,{signedAttendance:true},{...project,form:"线下"},db).format,"线下");
});
test("课件课题与串场、logo位置不一致不能通过",()=>{
 const e={agendaTopics:["课题甲"],courseTopics:["课题甲"],hostTitleMatches:true,hostNameLogoMatches:true,sponsorLogoPages:["首页"]};
 assert.equal(validateSopEvidence(4,e,project,db).matchedTopics,1);
 expectBlock(4,{...e,courseTopics:["另一个课题"]});
 expectBlock(4,{...e,sponsorLogoPages:["正文"]});
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
