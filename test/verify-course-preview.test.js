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
test("大型PPTX严格只解析第1张，第二张11MB XML不会阻止封面主题匹配",()=>{
 const source=deck(["精准诊疗技术新进展","X".repeat(11*1024*1024),"其他页"]);
 const r=office.extract(source,"pptx",{maxSlides:1});
 assert.equal(r.engine,office.COURSE_PREVIEW_ENGINE);
 assert.equal(r.pages,1);
 assert.equal(r.totalPages,3);
 assert.equal(r.truncated,true);
 assert.match(r.text,/精准诊疗技术新进展/);
 assert.doesNotMatch(r.text,/X{20}/);
 assert.deepEqual(courseTopics(r.text,["精准诊疗技术新进展"]),["精准诊疗技术新进展"]);
 assert.throws(()=>office.extract(source,"pptx"),e=>e.code==="OFFICE_TOO_LARGE",
  "整份扫描失败不应影响第一页提取");
});
test("主题仅出现在第二页不得误判一致，也不能用部分字符串冒充标题",()=>{
 const source=deck(["开幕致辞","精准诊疗技术新进展"]);
 const r=office.extract(source,"pptx",{maxSlides:1});
 assert.equal(r.pages,1);
 assert.equal(courseTopics(r.text,["精准诊疗技术新进展"]).length,0);
 assert.deepEqual(courseTopics("这里引用了精准诊疗技术新进展的观点",["精准诊疗技术新进展"]),[]);
});
test("首页OCR标题可能断成两行，能够拼合，但不支持段落子串匹配",()=>{
 const agenda=["精准诊疗技术新进展"];
 assert.deepEqual(courseTopics("封面\n精准诊疗\n技术新进展\n主讲：张三",agenda),agenda);
 assert.deepEqual(courseTopics("报告题目：精准诊疗技术新进展",agenda),agenda);
 assert.deepEqual(courseTopics("课程名称：精准诊疗技术新进展",agenda),agenda);
 assert.deepEqual(courseTopics("精准诊疗技术新进展补充专题",agenda),[]);
});
test("只提取第一页嵌入的JPG/PNG图像，忽略后续图片与外链",()=>{
 const zip=new PizZip();
 zip.file("[Content_Types].xml","<Types/>");
 zip.file("_rels/.rels","<Relationships/>");
 zip.file("ppt/presentation.xml","<p:presentation/>");
 zip.file("ppt/slides/slide1.xml",'<p:sld><p:pic><a:blip r:embed="rId2"/></p:pic><p:pic><a:blip r:embed="rIdExternal"/></p:pic></p:sld>');
 zip.file("ppt/slides/_rels/slide1.xml.rels",'<Relationships><Relationship Id="rId2" Type="image" Target="../media/cover.png"/><Relationship Id="rIdExternal" Type="image" TargetMode="External" Target="https://example.com/image.png"/></Relationships>');
 zip.file("ppt/slides/slide2.xml",'<p:sld><p:pic><a:blip r:embed="rId3"/></p:pic></p:sld>');
 zip.file("ppt/slides/_rels/slide2.xml.rels",'<Relationships><Relationship Id="rId3" Target="../media/second.png"/></Relationships>');
 const cover=Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9YQX8hQAAAAASUVORK5CYII=","base64");
 zip.file("ppt/media/cover.png",cover);
 zip.file("ppt/media/second.png",Buffer.from("not-first-slide"));
 const result=office.coverImages(zip.generate({type:"nodebuffer"}));
 assert.equal(result.length,1);
 assert.equal(result[0].ext,"png");
 assert.deepEqual(result[0].buffer,cover);
});
