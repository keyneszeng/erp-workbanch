"use strict";
/** Browser regression: Step-5 linked source panel must only show labor sheets and expert labor contracts. */
const assert=require("node:assert/strict");
const {chromium}=require("playwright");
const {spawn}=require("node:child_process");
const fs=require("node:fs"),os=require("node:os"),path=require("node:path");
const dir=fs.mkdtempSync(path.join(os.tmpdir(),"erp-labor-step5-ui-"));
const port=15210+(process.pid%200);
const url="http://127.0.0.1:"+port;
let server,browser;
(async()=>{
 server=spawn(process.execPath,["--experimental-sqlite","server/index.js"],{
  cwd:path.resolve(__dirname,"../.."),
  env:{...process.env,ERP_DEMO_MODE:"1",ERP_PORT:String(port),ERP_HOST:"127.0.0.1",
    ERP_DB:path.join(dir,"db.sqlite"),ERP_UPLOAD_DIR:path.join(dir,"uploads")},
  stdio:["ignore","pipe","pipe"]
 });
 let ready=false;
 for(let i=0;i<180;i++){
  if(server.exitCode!==null)throw Error("Test server exited");
  try{if((await fetch(url+"/api/health")).ok){ready=true;break;}}catch{}
  await new Promise(r=>setTimeout(r,100));
 }
 assert.ok(ready,"Test server did not start");
 browser=await chromium.launch({channel:"chrome",headless:true});
 const page=await browser.newPage();
 await page.goto(url,{waitUntil:"domcontentloaded"});
 const html=await page.evaluate(async()=>{
  const {stepBody}=await import("/assets/js/lib/verify-detail.js");
  const materials=[
    {id:1,kind:"劳务登记表",name:"劳务登记表.xlsx",file_name:"劳务登记表.xlsx",file_key:"labor-sheet.xlsx"},
    {id:2,kind:"合同",name:"HT-123 · 张三专家合同",file_name:"张三专家劳务.pdf",file_key:"expert.pdf"},
    {id:3,kind:"合同",name:"会务服务总合同",file_name:"会议执行服务.pdf",file_key:"meeting.pdf"},
    {id:4,kind:"合同",name:"企业赞助协议",file_name:"某企业赞助.pdf",file_key:"sponsor.pdf"},
    {id:5,kind:"劳务专家合同",name:"李四劳务专家合同",file_name:"李四劳务专家合同.pdf",file_key:"expert2.pdf"}
  ];
  const contracts=[
    {id:"HT1",category:"劳务专家",file_key:"expert.pdf"},
    {id:"HT2",category:"会务服务",file_key:"meeting.pdf"},
    {id:"HT3",category:"企业赞助",file_key:"sponsor.pdf"}
  ];
  const d={materials,contracts,payments:[{id:"PAY-1",type:"专家费",payee:"张三",amount:1000}],
    verification:{steps:[{no:5,result:"通过",evidence:{matchedContractMaterialIds:[2,3,4,5]}}]}};
  return stepBody(d,5);
 });
 assert.ok(html.includes("劳务登记表.xlsx"));
 assert.ok(html.includes("张三专家劳务.pdf"));
 assert.ok(html.includes("李四劳务专家合同.pdf"));
 assert.ok(!html.includes("会议执行服务.pdf"),"meeting-service original must never appear");
 assert.ok(!html.includes("某企业赞助.pdf"),"sponsor original must never appear");
 assert.ok(!html.includes("PAY-1"),"unrelated payment listing is not a step-5 source");
 console.log("PASS: Step-5 UI sources only labor registration and actual expert labor contracts");
})().then(async()=>{
 await browser?.close();server?.kill("SIGTERM");fs.rmSync(dir,{recursive:true,force:true});
}).catch(async e=>{
 console.error(e);await browser?.close().catch(()=>{});server?.kill("SIGTERM");
 fs.rmSync(dir,{recursive:true,force:true});process.exitCode=1;
});
