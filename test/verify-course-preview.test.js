"use strict";
const {test}=require("node:test"),assert=require("node:assert/strict");
const PizZip=require("pizzip");
const office=require("../server/lib/verify-office-text");
const {courseTopics,topicKey}=require("../server/lib/verify-agenda-evidence");
function deck(slides){
 const zip=new PizZip();
 zip.file("[Content_Types].xml","<Types/>");
 zip.file("_rels/.rels","<Relationships/>");
 zip.file("ppt/presentation.xml","<p:presentation/>");
 for(let i=0;i<slides.length;i++)
  zip.file("ppt/slides/slide"+(i+1)+".xml","<p:sld><a:p><a:t>"+slides[i]+"</a:t></a:p></p:sld>");
 return zip.generate({type:"nodebuffer",compression:"DEFLATE"});
}
test("巨型串场PPTX只解压前5页，后续11MB幻灯片不妨碍提取第5页主题",()=>{
 const source=deck(["封面","主持人介绍","日程安排","嘉宾介绍","精准诊疗技术新进展","X".repeat(11*1024*1024),"附件"]);
 const r=office.extract(source,"pptx",{maxSlides:5});
 assert.equal(r.engine,office.COURSE_PREVIEW_ENGINE);
 assert.equal(r.pages,5);
 assert.equal(r.totalPages,7);
 assert.equal(r.truncated,true);
 assert.match(r.text,/精准诊疗技术新进展/);
 assert.doesNotMatch(r.text,/X{20}/);
 assert.ok(courseTopics(r.text,["精准诊疗技术新进展"]).some(x=>topicKey(x)===topicKey("精准诊疗技术新进展")));
 assert.throws(()=>office.extract(source,"pptx"),e=>e.code==="OFFICE_TOO_LARGE",
  "全量扫描无法读取的幻灯片不可阻止前5张的有效主题匹配");
});
test("主题不在前五页时不能假定匹配，也不能用子串冒充完整主题",()=>{
 const base=["封面","开场","嘉宾","议程","精准诊疗技术新进展补充版","精准诊疗技术新进展"];
 const scan=office.extract(deck(base),"pptx",{maxSlides:5});
 assert.equal(scan.pages,5);
 assert.equal(scan.totalPages,6);
 assert.equal(courseTopics(scan.text,["精准诊疗技术新进展"]).length,0);
 const unlabelled=courseTopics("这里引用了精准诊疗技术新进展的观点",["精准诊疗技术新进展"]);
 assert.deepEqual(unlabelled,[]);
});
test("独立主题可能出现在前五张的第20行之后，仍需识别",()=>{
 const lines=Array.from({length:50},(_,i)=>"内容说明 "+i);
 lines.push("精准诊疗技术新进展");
 const found=courseTopics(lines.join("\n"),["精准诊疗技术新进展"]);
 assert.deepEqual(found,["精准诊疗技术新进展"]);
});
