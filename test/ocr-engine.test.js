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

test("最终议程PDF可以扩展扫描页数，普通文档仍使用默认3页",async()=>{
 const old=process.env.ERP_OCR_ENABLED;
 process.env.ERP_OCR_ENABLED="1";
 const opened=[];
 const exec=async(program,args)=>{
   opened.push({program,args});
   if(program==="pdfinfo")return "Pages: 12\n";
   if(program==="pdftotext")return "最终议程已提取：张三、李四、王五、赵六、孙七、周八、吴九，报告人姓名出现在末页内容。";
   throw Error("Unexpected: "+program);
 };
 try{
   const source=Buffer.from("%PDF-1.7\nfixture");
   const normal=await recognize(source,"pdf",{exec});
   assert.equal(normal.pages,3);
   assert.equal(normal.truncated,true);
   const preview=await recognize(source,"pdf",{exec,maxPages:5});
   assert.equal(preview.pages,5);
   assert.equal(preview.totalPages,12);
   assert.equal(preview.truncated,true);
   const full=await recognize(source,"pdf",{exec,maxPages:20});
   assert.equal(full.pages,12);
   assert.equal(full.totalPages,12);
   assert.equal(full.truncated,false);
   const pdftotext=opened.filter(x=>x.program==="pdftotext");
   assert.equal(pdftotext.length,3);
   assert.ok(pdftotext[0].args.includes("3"));
   assert.ok(pdftotext[1].args.includes("5"));
   assert.ok(pdftotext[2].args.includes("12"));
 }finally{
   if(old===undefined)delete process.env.ERP_OCR_ENABLED;
   else process.env.ERP_OCR_ENABLED=old;
 }
});

test("PDF课件封面仅渲染OCR第一页，并合并文字层与图片里的标题",async()=>{
 const fs=require("node:fs");
 const old=process.env.ERP_OCR_ENABLED;
 process.env.ERP_OCR_ENABLED="1";
 const commands=[];
 const exec=async(program,args)=>{
  commands.push({program,args});
  if(program==="pdfinfo")return "Pages: 50\n";
  if(program==="pdftotext")return "主办单位：广东省医学会\n会议日期：2026年11月17日\n本页包含可选择的普通文字。";
  if(program==="pdftoppm"){
   fs.writeFileSync(args[args.length-1]+"-1.png",Buffer.from("fixture"));
   return "";
  }
  if(program.includes("python"))return JSON.stringify({items:[
   {text:"精准诊疗技术新进展",score:0.99,x:10,y:10,h:25,w:220}
  ]});
  throw Error("Unexpected OCR command "+program);
 };
 try{
  const doc=await recognize(Buffer.from("%PDF-1.7\nfixture"),"pdf",{maxPages:1,forceVisual:true,exec});
  assert.equal(doc.pages,1);
  assert.equal(doc.totalPages,50);
  assert.equal(doc.truncated,true);
  assert.equal(doc.mode,"pdf-cover-ocr");
  assert.match(doc.text,/精准诊疗技术新进展/);
  assert.match(doc.text,/主办单位/);
  for(const p of ["pdftotext","pdftoppm"]){
   const call=commands.find(x=>x.program===p);
   assert.ok(call,p+" should run");
   assert.equal(call.args[call.args.indexOf("-l")+1],"1","Only first page may be scanned");
  }
 }finally{
  if(old===undefined)delete process.env.ERP_OCR_ENABLED;
  else process.env.ERP_OCR_ENABLED=old;
 }
});

test("第6项可扩展PDF合同文字层提取到12页而非默认3页",async()=>{
 const {extractPdfText}=require("../server/lib/ocr-engine");
 const commands=[];
 const result=await extractPdfText(Buffer.from("%PDF-1.7\nfixture"),{
  maxPages:12,
  exec:async(program,args)=>{
   commands.push({program,args});
   if(program==="pdfinfo")return "Pages: 18\n";
   if(program==="pdftotext")return "Meeting Service Agreement: signed, budget 3175 yuan, meeting logistics";
   throw Error(program);
  }
 });
 assert.equal(result.pages,12);
 assert.equal(result.totalPages,18);
 assert.equal(result.truncated,true);
 assert.match(result.text,/Service Agreement/);
 const textCall=commands.find(x=>x.program==="pdftotext");
 assert.equal(textCall.args[textCall.args.indexOf("-l")+1],"12");
});
test("扫描版PDF合同无文字层时使用RapidOCR逐页渲染识别",async()=>{
 const fs=require("node:fs"),old=process.env.ERP_OCR_ENABLED;
 process.env.ERP_OCR_ENABLED="1";
 const calls=[];
 try{
  const result=await recognize(Buffer.from("%PDF-1.7\nfixture"),"pdf",{
   maxPages:2,exec:async(program,args)=>{
    calls.push({program,args});
    if(program==="pdfinfo")return "Pages: 7\n";
    if(program==="pdftotext")return "";
    if(program==="pdftoppm"){
     fs.writeFileSync(args[args.length-1]+"-1.png",Buffer.from("page1"));
     fs.writeFileSync(args[args.length-1]+"-2.png",Buffer.from("page2"));
     return "";
    }
    if(program.includes("python"))return JSON.stringify({items:[
     {text:"会务服务协议",score:0.98,x:10,y:10,h:20,w:140},
     {text:"合同金额 3175",score:0.97,x:10,y:48,h:20,w:140}
    ]});
    throw Error("Unexpected program "+program);
   }
  });
  assert.equal(result.pages,2);
  assert.equal(result.totalPages,7);
  assert.equal(result.truncated,true);
  assert.equal(result.mode,"pdf-ocr");
  assert.match(result.text,/会务服务协议/);
  assert.equal(calls.filter(x=>x.program.includes("python")).length,2);
  for(const program of ["pdftotext","pdftoppm"]){
   const command=calls.find(x=>x.program===program);
   assert.equal(command.args[command.args.indexOf("-l")+1],"2");
  }
 }finally{
  if(old===undefined)delete process.env.ERP_OCR_ENABLED;
  else process.env.ERP_OCR_ENABLED=old;
 }
});
