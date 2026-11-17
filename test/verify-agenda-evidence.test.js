"use strict";
const {test}=require("node:test");
const assert=require("node:assert/strict");
const {speakerName,photoName,agendaSpeakers,compareNames,topicKey,agendaTopics,courseTopics}=
 require("../server/lib/verify-agenda-evidence");

test("议程OCR按讲者字段提取姓名；独立姓名行也能识别",()=>{
 const agenda="讲者：张三教授 课题：精准诊疗技术新进展\n讲者：李四主任\n课题：人工智能与影像诊断";
 assert.deepEqual(agendaSpeakers(agenda).sort(),["张三","李四"].sort());
});
test("讲者照片按真实原文件名取姓名，移除图片后缀和常见照片标记",()=>{
 assert.equal(speakerName("张三教授"),"张三");
 assert.equal(photoName({file_name:"张三照片.jpg",name:"手动别名"}),"张三");
 assert.equal(photoName({file_name:"李四主任.webp",name:"李四主任.webp"}),"李四");
 assert.equal(photoName({file_name:"王五_讲者照片.png",name:"王五照片"}),"王五");
 assert.equal(photoName({file_name:"speaker.png",name:"测试讲者"}),"测试讲者","legacy generic image name uses explicit registered label");
 assert.equal(photoName({file_name:"多人合影01.jpg",name:"张三"}),"","未指明姓名的图片不能猜人名");
});
test("讲者照片姓名均包含在议程时一致，不要求议程所有讲者都有照片",()=>{
 const a=["张三教授","李四主任","王五医生"];
 const subset=compareNames(a,["张三","王五"]);
 assert.equal(subset.matched,true);
 assert.deepEqual(subset.missing,["李四"]);
 const extra=compareNames(a,["张三","赵六"]);
 assert.equal(extra.matched,false);
 assert.deepEqual(extra.extra,["赵六"]);
 const duplicate=compareNames(a,["张三","张三"]);
 assert.equal(duplicate.matched,true);
 assert.deepEqual(duplicate.duplicate,["张三"]);
});
test("OCR议程多场次、无课题表格和独立姓名行尽可能提取全部姓名",()=>{
 const raw=[
   "2026年学术会议 终版议程",
   "时间    内容    讲者    单位",
   "09:00-09:30    精准诊疗    徐一劲    东莞市人民医院",
   "09:35-10:10    讨论    王五主任    东莞市人民医院",
   "讲者：张三教授、李四主任",
   "姓名：赵六",
   "主持人：孙七",
   "邀请报告：周八老师"
 ].join("\n");
 const people=agendaSpeakers(raw,["徐一劲","王五","张三","李四","赵六","孙七","周八"]);
 for(const name of ["徐一劲","王五","张三","李四","赵六","孙七","周八"])
   assert.ok(people.includes(name),"应识别 "+name+"；结果："+people.join("、"));
 const onlyOCR="专题报告\n专家 李四主任\n会议简介";
 assert.ok(agendaSpeakers(onlyOCR,["李四"]).includes("李四"),
  "表格断裂时以照片姓名在原始OCR文本精确出现为兜底");
 assert.ok(!agendaSpeakers("讲者：张三丰教授",["张三"]).includes("张三"),"姓名不能误匹配另一人的前缀");
});
test("课件主题须完整匹配终版议程课题；包含关键词或较长扩展题目不算一致",()=>{
 const agenda="讲者：张三教授 课题：精准诊疗技术新进展\n讲者：李四主任 课题：人工智能与影像诊断";
 const subjects=agendaTopics(agenda);
 assert.equal(subjects.length,2);
 const allowed=new Set(subjects.map(topicKey));
 const first=courseTopics("课件主题：精准诊疗技术新进展",subjects);
 assert.deepEqual(first,["精准诊疗技术新进展"]);
 assert.ok(first.every(x=>allowed.has(topicKey(x))));
 const wrong=courseTopics("课件主题：精准诊疗技术新进展补充专题",subjects);
 assert.ok(wrong.length);assert.ok(wrong.some(x=>!allowed.has(topicKey(x))));
 const title=courseTopics("精准诊疗技术新进展\n课程重点\n诊疗分享",subjects);
 assert.deepEqual(title,["精准诊疗技术新进展"]);
 const unknown=courseTopics("课程介绍\n不同的临床研究案例",subjects);
 assert.deepEqual(unknown,[],"没有可靠主题时应标记无法确认，不能模糊猜测");
});

test("参会时长OCR单位及严格大于30分钟判定",()=>{
 const {extractDurations}=require("../server/lib/verify-duration-evidence");
 for(const phrase of ["观看时长：35分钟","累计在线 1小时20分","有效时长：45 min",
   "在线时长 00:35:00","有效观看时长 三十五分钟","1.5小时","30分钟1秒",">30分钟","超过30分钟","观看时长：1时20分","超过三十分钟"]){
   const hits=extractDurations(phrase);
   assert.ok(hits.some(x=>x.qualifies),phrase+" 应满足30分钟以上严格阈值");
 }
 for(const phrase of ["30分钟","0.5小时","30分00秒","在线时长 00:30:00",
   "观看时长 29min","10:45","30分钟以上","9时40分","9时40分-10时30分"]){
   const hits=extractDurations(phrase);
   assert.ok(!hits.some(x=>x.qualifies),phrase+" 不得作为严格大于30分钟");
 }
 assert.equal(extractDurations("参会时长20分钟; 观看时长 45分钟").some(x=>x.qualifies),true);
});
