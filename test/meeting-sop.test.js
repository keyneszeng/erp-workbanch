"use strict";
const {test}=require("node:test");
const assert=require("node:assert/strict");
const {validateSopEvidence,sameNames}=require("../server/lib/meeting-sop");
const project={id:"MP-TEST",name:"会议甲",date:"2026-11-01",assoc:"学会甲",form:"混合"};
const stubDb={prepare(sql){return {get(pid,kind){return {n:1,total:1000};}};}};
// 旧用例直接引用 db，保留别名，避免为了改名去动一堆断言
const db=stubDb;
/**
 * 可控制「哪些材料已上传」的 db 桩。
 * 材料类校验只认 kind + file_key，合同校验只看「已签署 + 劳务专家」的条数，
 * 所以桩只要按 SQL 里的特征返回对应数字即可。
 */
function dbWith({ kinds = [], laborContracts = 0, signedTotal = 1000 } = {}) {
  return {
    prepare(sql) {
      return {
        get(pid, kind) {
          if (/FROM materials/i.test(sql)) return { n: kinds.includes(kind) ? 1 : 0 };
          if (/category='劳务专家'/i.test(sql)) return { n: laborContracts, total: signedTotal };
          return { n: 1, total: signedTotal };
        }
      };
    }
  };
}
function expectBlock(no,evidence,p=project,amount=1000,db=stubDb){
  assert.throws(()=>validateSopEvidence(no,evidence,p,db,amount));
}
test("六步核销必须有结构化证据，缺字段无法通过",()=>{
  for(let n=1;n<=6;n++)expectBlock(n,null);
});
test("第一步：关联材料为立项文件 + 终版议程，且盖章函件与会议基线一致",()=>{
 const e={meetingName:project.name,meetingDate:project.date,organizer:project.assoc,sponsor:"不适用",stamped:true,final:true};
 const ok=dbWith({kinds:["立项文件","终版议程"]});
 assert.equal(validateSopEvidence(1,e,project,ok).fieldsMatched,4);
 expectBlock(1,{...e,stamped:false},project,1000,ok);
 expectBlock(1,{...e,meetingDate:"2026-11-02"},project,1000,ok);
 // 只有会议通知/招商函不再算数：第一步核的是立项文件与终版议程
 assert.throws(()=>validateSopEvidence(1,e,project,dbWith({kinds:["会议通知"]})),/立项文件/);
 assert.throws(()=>validateSopEvidence(1,e,project,dbWith({kinds:["立项文件"]})),/终版议程/);
});
test("第二步：必须用终版议程，普通议程不算",()=>{
 const e={agendaSpeakers:["甲"],collectionSpeakers:["甲"],agreementSpeakers:["甲"],noOmissions:true};
 assert.equal(validateSopEvidence(2,e,project,dbWith({kinds:["终版议程","劳务收集表","劳务协议"]})).matchedPeople,1);
 assert.throws(()=>validateSopEvidence(2,e,project,dbWith({kinds:["议程","劳务收集表","劳务协议"]})),/终版议程/);
 assert.throws(()=>validateSopEvidence(2,e,project,dbWith({kinds:["终版议程","劳务收集表"]})),/劳务协议/);
});
test("第三步：关联材料为参会数据，签到表同样算参会数据",()=>{
 const offline={...project,form:"线下"};
 const online={...project,form:"线上"};
 assert.equal(validateSopEvidence(3,{signedAttendance:true},offline,dbWith({kinds:["签到表"]})).format,"线下");
 assert.equal(validateSopEvidence(3,{onlineMinutes:45},online,dbWith({kinds:["参会数据"]})).format,"线上");
 // 腾讯会议的参会数据导出常被登记成「签到表」，线上会议同样认
 assert.equal(validateSopEvidence(3,{onlineMinutes:45},online,dbWith({kinds:["签到表"]})).format,"线上");
 assert.throws(()=>validateSopEvidence(3,{signedAttendance:true},offline,dbWith({kinds:[]})),/参会数据/);
});
test("第四步：关联材料为终版议程 + 课件 + 串场",()=>{
 const e={agendaTopics:["课题甲"],courseTopics:["课题甲"],hostTitleMatches:true,hostNameLogoMatches:true,sponsorLogoPages:["首页"]};
 const all=dbWith({kinds:["终版议程","课件","串场"]});
 assert.equal(validateSopEvidence(4,e,project,all).matchedTopics,1);
 for(const missing of ["终版议程","课件","串场"]){
   const kinds=["终版议程","课件","串场"].filter(k=>k!==missing);
   assert.throws(()=>validateSopEvidence(4,e,project,dbWith({kinds})),new RegExp(missing));
 }
});
test("第五步：关联劳务收集表原件与劳务/专家类合同",()=>{
 const a={name:"甲",time:"9:00",role:"讲者",amount:"100",bankAccount:"IN_MEMORY_ONLY"};
 const e={collectionRecords:[a],agreementRecords:[a]};
 const ok=dbWith({kinds:["劳务收集表"],laborContracts:1});
 assert.equal(validateSopEvidence(5,e,project,ok).laborContracts,1);
 assert.throws(()=>validateSopEvidence(5,e,project,dbWith({kinds:["劳务收集表"],laborContracts:0})),/劳务\/专家类合同/);
 assert.throws(()=>validateSopEvidence(5,e,project,dbWith({kinds:[],laborContracts:1})),/劳务收集表/);
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
test("第五步宽松比对：人员对上即可，字段缺一侧或金额写法不同不拦",()=>{
  const dbOk=()=>dbWith({kinds:["劳务收集表"],laborContracts:1});
  // 收集表有开户行、协议没填 → 不比开户行，放行
  const a1={name:"甲",bankAccount:"6222000000000001",bankName:"工商银行广州分行",amount:"1000"};
  const b1={name:"甲",bankAccount:"6222000000000001",amount:"¥1,000.00"};
  assert.equal(validateSopEvidence(5,{collectionRecords:[a1],agreementRecords:[b1]},project,dbOk()).lenient,true);
  // 账号写法带空格/短横 → 归一化后相同，放行
  const a2={name:"乙",bankAccount:"6222 0000-0000 0001",amount:"500"};
  const b2={name:"乙",bankAccount:"6222000000000001",amount:"500.00"};
  assert.equal(validateSopEvidence(5,{collectionRecords:[a2],agreementRecords:[b2]},project,dbOk()).matchedLaborRecords,1);
  // 金额真的不一致 → 拦
  assert.throws(()=>validateSopEvidence(5,{collectionRecords:[a1],agreementRecords:[{...b1,amount:"1200"}]},project,dbOk()),/金额不一致/);
  // 人员对不上 → 拦
  assert.throws(()=>validateSopEvidence(5,{collectionRecords:[a1],agreementRecords:[{...b1,name:"丙"}]},project,dbOk()),/姓名对不上/);
});

test("正式结算单不能提前生成；核销只校验拟结算金额与会议基线",()=>{
 const e={draftAmount:1000,meetingName:project.name,meetingDate:project.date};
 assert.equal(validateSopEvidence(6,e,project,db,1000).meetingMatched,true);
 expectBlock(6,{...e,draftAmount:999},project,1000);
 expectBlock(6,{...e,meetingName:"其他会议"},project,1000);
});
