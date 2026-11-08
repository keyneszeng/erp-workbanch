"use strict";
const {test}=require("node:test");
const assert=require("node:assert/strict");
const {parseAgenda,parseAgendaRows,extractNames,extractTopics,recognize}=require("../server/lib/ocr-engine");

test("OCR agenda parsing returns reviewable bilingual candidates without treating headings as a speaker",()=>{
  const raw=[
    "2026年医学学术会议 终版议程",
    "09:00-09:30 讲者：张三教授 课题：胃肠病诊疗新进展",
    "讲者：李四主任",
    "主题：临床研究方法与应用",
    "Speaker: Dr Alex Topic: AI Research",
    "讲者：张三教授 课题：胃肠病诊疗新进展",
    "会议时间：2026-11-03"
  ].join("\n");
  const items=parseAgenda(raw);
  assert.deepEqual(items,[
    {speaker:"张三教授",topic:"胃肠病诊疗新进展"},
    {speaker:"李四主任",topic:"临床研究方法与应用"},
    {speaker:"Dr Alex",topic:"AI Research"}
  ]);
  assert.deepEqual(parseAgenda("会议时间：2026-01-01\n会场安排"),[]);
});
test("议程表格按时间行还原成 时间/课题/讲者/单位，环节词不当讲者",()=>{
  const raw=[
    "2026年学术会议 终版议程",
    "19:35-20:05      内痔的规范化治疗: 从指南到临床      徐一劲   东莞市人民医院",
    "20:05-20:25      讨论      周志球   东莞市松山湖中心医院",
    "20:25-20:30      总结      周志球   东莞市松山湖中心医院",
    "注: 最终日程以实际发生为准。"
  ].join("\n");
  const rows=parseAgendaRows(raw);
  assert.equal(rows.length,3,"标题与脚注不应产生场次");
  assert.deepEqual(rows[0],{time:"19:35-20:05",topic:"内痔的规范化治疗: 从指南到临床",speaker:"徐一劲",org:"东莞市人民医院"});
  // 「讨论」是议程环节，不是讲者；讲者按「机构名前一个」认出来
  assert.equal(rows[1].speaker,"周志球");
  assert.equal(rows[1].topic,"");
  assert.equal(rows[2].time,"20:25-20:30");
});

test("姓名提取：表格行/职称/机构相邻/编号名单都能抓到，且不含表头词",()=>{
  const text=[
    "序号 姓名 身份证号码 手机号码 银行卡号",
    "1    刘志华    14040219830715041X   13826188969   6222023602078445731",
    "2    卢效荣    441900198501011234   13900000000   6222023602078445732",
    "19:35-20:05  内痔治疗  徐一劲   东莞市人民医院",
    "张伟教授 主讲",
    "1.蔡浩武",
    "姓名：韦明锋"
  ].join("\n");
  const names=extractNames(text);
  for(const n of ["刘志华","卢效荣","徐一劲","张伟","蔡浩武","韦明锋"])
    assert.ok(names.includes(n),"应提取到 "+n+"，实际："+names.join("、"));
  for(const bad of ["姓名","序号","身份证","银行卡"]) assert.ok(!names.includes(bad),bad+" 不应被当成人名");
});

test("课题提取：课件议程页与显式讲题都能抓，简历条目与会议信息被排除",()=>{
  const text=[
    "时间           讲题             姓名       医院",
    "19:05-",
    "         内痔规范化诊疗策略与临床实践     卢效荣   东莞市松山湖中心医院",
    "19:35",
    "              讨论主持           周志球   东莞市松山湖中心医院",
    "# 腾讯会议： 233-794-401",
    "亚太结直肠联合会亚洲结直肠盆底疾病联盟第二届理事会常务理事",
    "讲题：另一场专题报告"
  ].join("\n");
  const topics=extractTopics(text);
  assert.ok(topics.includes("内痔规范化诊疗策略与临床实践"),"应提取到课件课题，实际："+topics.join("、"));
  assert.ok(topics.includes("另一场专题报告"),"应提取到显式讲题，实际："+topics.join("、"));
  assert.ok(!topics.includes("讨论主持"),"环节词不应算课题");
  assert.ok(!topics.some(t=>t.includes("腾讯会议")),"会议信息不应算课题");
  assert.ok(!topics.some(t=>t.includes("常务理事")),"简历条目不应算课题");
});

test("OCR requires an explicit server-side enable flag; image/PDF MIME mismatch blocked",async()=>{
  const prev=process.env.ERP_OCR_ENABLED;
  delete process.env.ERP_OCR_ENABLED;
  try{
    await assert.rejects(recognize(Buffer.from("%PDF-1.4\n"),"pdf"),{code:"OCR_DISABLED"});
    process.env.ERP_OCR_ENABLED="1";
    await assert.rejects(recognize(Buffer.from("random"),"pdf"),{code:"OCR_MIME_MISMATCH"});
    await assert.rejects(recognize(Buffer.from("abc"),"docx"),{code:"OCR_UNSUPPORTED"});
  }finally{if(prev===undefined)delete process.env.ERP_OCR_ENABLED;else process.env.ERP_OCR_ENABLED=prev;}
});

test("PDF 有文字层时不用启用图片 OCR 也能提取合同内容",async()=>{
 const {extractPdfText}=require("../server/lib/ocr-engine");
 const old=process.env.ERP_OCR_ENABLED;
 delete process.env.ERP_OCR_ENABLED;
 const commands=[];
 try{
  const result=await extractPdfText(Buffer.from("%PDF-1.7\nfixture"),{
   exec:async(name)=>{
    commands.push(name);
    if(name==="pdfinfo")return "Pages: 5\n";
    return "甲方：广东省医学会\n乙方：广州睿康医疗科技有限公司\n合同金额：120000元";
   }
  });
  assert.equal(result.mode,"pdf-text");
  assert.equal(result.truncated,true);
  assert.match(result.text,/合同金额：120000元/);
  assert.deepEqual(commands,["pdfinfo","pdftotext"]);
 }finally{
  if(old===undefined)delete process.env.ERP_OCR_ENABLED;
  else process.env.ERP_OCR_ENABLED=old;
 }
});
