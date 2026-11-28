"use strict";
const {test}=require("node:test");
const assert=require("node:assert/strict");
const provider=require("../server/lib/liteparse-provider");
const ocr=require("../server/lib/ocr-engine");
const {checkRapidOcr}=require("../scripts/rapidocr-preflight.cjs");
const PDF=Buffer.from("%PDF-1.7\nfixture");
const page=(n,text)=>({page:n,text,text_items:[{text,x:10,y:20,width:80,height:12}]});
const fixture=JSON.stringify({total_pages:5,pages:[page(1,"会议议程"),page(2,"讲者：张三"),page(3,"合同金额：1000元")]});
async function withFlags(flag,fn){
 const old={};for(const [k,v] of Object.entries({ERP_OCR_ENABLED:"1",ERP_LITEPARSE_ENABLED:flag,ERP_LITEPARSE_BIN:provider.DEFAULT_BIN})){old[k]=process.env[k];process.env[k]=v;}
 try{return await fn();}finally{for(const [k,v] of Object.entries(old)){if(v===undefined)delete process.env[k];else process.env[k]=v;}}
}
test("LiteParse adapter checks page ordering, blanks, partial errors and page limits",()=>{
 const result=provider.parseResult(fixture,3,5);
 assert.equal(result.pages,3);assert.equal(result.totalPages,5);assert.equal(result.truncated,true);
 assert.match(result.text,/合同金额：1000元/);
 for(const invalid of [{pages:[page(1,"a"),page(3,"b")]},{pages:[page(1,"a"),page(1,"b"),page(3,"c")]},
 {pages:[page(1,"a"),page(2," "),page(3,"c")]},{pages:[page(1,"a"),page(2,"b"),page(3,"c")],page_errors:[{page:2}]}])
  assert.throws(()=>provider.parseResult(JSON.stringify(invalid),3,5));
});
test("optional hybrid PDF routes only to loopback RapidOCR and preserves page bounds",async()=>withFlags("1",async()=>{
 const commands=[];
 const result=await ocr.recognize(PDF,"pdf",{exec:async(program,args,opts)=>{
  commands.push({program,args,opts});
  if(program==="pdfinfo")return "Pages: 5\n";
  if(program===provider.DEFAULT_BIN)return fixture;
  throw Error("unexpected command");
 }});
 assert.equal(result.engine,provider.ENGINE);
 assert.equal(result.truncated,true);
 assert.deepEqual(commands.map(c=>c.program),["pdfinfo",provider.DEFAULT_BIN]);
 assert.ok(commands[1].args.includes("http://127.0.0.1:18765/ocr"));
 assert.ok(commands[1].args.includes("1-3"));
 assert.equal(commands[1].opts.rejectPartialOcr,true);
 assert.equal(ocr.providerMatches(provider.ENGINE),true);
}));
test("failed or incomplete LiteParse falls back to existing Poppler without changing policy",async()=>withFlags("1",async()=>{
 for(const data of ["bad json",JSON.stringify({pages:[page(1,"a")]})]){
  const result=await ocr.recognize(PDF,"pdf",{exec:async(program)=>{
   if(program==="pdfinfo")return "Pages: 5\n";
   if(program===provider.DEFAULT_BIN)return data;
   if(program==="pdftotext")return "甲方：某医学会 乙方：某会务公司 合同金额：1000元 本协议用于会议执行并保留原件核对依据。";
   throw Error("unexpected command");
  }});
  assert.equal(result.engine,"Poppler pdftotext");
 }
}));
test("disabled flag preserves existing OCR and historical LiteParse cache",async()=>withFlags("0",async()=>{
 const commands=[];
 const r=await ocr.recognize(PDF,"pdf",{exec:async(program)=>{
  commands.push(program);return program==="pdfinfo"?"Pages: 5\n":"甲方：某医学会 乙方：某会务公司 合同金额：1000元 本协议用于会议执行并保留原件核对依据。";
 }});
 assert.deepEqual(commands,["pdfinfo","pdftotext"]);assert.equal(r.engine,"Poppler pdftotext");
 // 关闭 LiteParse 只影响新扫描用哪个引擎；过去真实跑过的 LiteParse 识别结果仍可信，
 // 否则历史核销证据会在关闭引擎后集体失效（已归档项目突然显示核销 1/6）。
 assert.equal(ocr.providerMatches(provider.ENGINE),true);
}));
test("optional parser is bounded to one active document",async()=>{
 let finish;
 const first=provider.recognizePdf("/tmp/example.pdf",3,5,()=>new Promise(resolve=>{finish=resolve;}));
 await assert.rejects(provider.recognizePdf("/tmp/second.pdf",3,5,async()=>fixture),/busy/);
 finish(fixture);await first;
 assert.equal((await provider.recognizePdf("/tmp/third.pdf",3,5,async()=>fixture)).engine,provider.ENGINE);
});
test("optional deployment requires explicit OCR enable and correct pinned CLI",()=>{
 assert.throws(()=>checkRapidOcr({ERP_OCR_ENABLED:"0",ERP_LITEPARSE_ENABLED:"1"}),/ERP_OCR_ENABLED/);
 const env={ERP_OCR_ENABLED:"1",ERP_LITEPARSE_ENABLED:"1",ERP_LITEPARSE_BIN:provider.DEFAULT_BIN};
 const spawn=(program)=>({status:0,stdout:program===provider.DEFAULT_BIN?"2.21.4\n":""});
 assert.doesNotThrow(()=>checkRapidOcr(env,spawn));
 assert.throws(()=>checkRapidOcr(env,()=>({status:0,stdout:"other"})),/2.21.4/);
});
