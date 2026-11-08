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
 assert.equal(photoName({file_name:"多人合影01.jpg",name:"张三"}),"","未指明姓名的图片不能猜人名");
});
test("讲者姓名精确比对：漏人、增人、重复、冒名都不得自动通过",()=>{
 const a=["张三教授","李四主任"];
 assert.equal(compareNames(a,["张三","李四"]).matched,true);
 const missing=compareNames(a,["张三"]);
 assert.equal(missing.matched,false);assert.deepEqual(missing.missing,["李四"]);
 const extra=compareNames(a,["张三","李四","赵六"]);
 assert.equal(extra.matched,false);assert.deepEqual(extra.extra,["赵六"]);
 const duplicate=compareNames(a,["张三","张三"]);
 assert.equal(duplicate.matched,false);assert.deepEqual(duplicate.duplicate,["张三"]);
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
