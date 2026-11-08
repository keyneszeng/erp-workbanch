"use strict";
/** Real Chrome black-box: three contract categories and isolated step 6/7 source lists. */
const assert=require("node:assert/strict");
const {chromium}=require("playwright");
const {spawn}=require("node:child_process");
const fs=require("node:fs"),os=require("node:os"),path=require("node:path");
const dir=fs.mkdtempSync(path.join(os.tmpdir(),"erp-step6-step7-ui-"));
const port=15310+(process.pid%210),origin="http://127.0.0.1:"+port;
let server,browser;
(async()=>{
 server=spawn(process.execPath,["--experimental-sqlite","server/index.js"],{
  cwd:path.resolve(__dirname,"../.."),
  env:{...process.env,ERP_DEMO_MODE:"1",ERP_PORT:String(port),ERP_HOST:"127.0.0.1",
   ERP_DB:path.join(dir,"db.sqlite"),ERP_UPLOAD_DIR:path.join(dir,"uploads")},
  stdio:["ignore","pipe","pipe"]});
 let ready=false;
 for(let i=0;i<180;i++){
  if(server.exitCode!==null)throw Error("ERP test server exited");
  try{if((await fetch(origin+"/api/health")).ok){ready=true;break;}}catch{}
  await new Promise(r=>setTimeout(r,100));
 }
 assert.ok(ready);
 browser=await chromium.launch({channel:"chrome",headless:true});
 const page=await browser.newPage({viewport:{width:1380,height:930}});
 await page.goto(origin);
 await page.locator('input[name="username"]').fill("admin");
 await page.locator('input[name="password"]').fill("123456");
 await page.locator("#lbtn").click();
 await page.locator("#nav").waitFor({timeout:14000});
 await page.goto(origin+"/#/projects/MP-2026-001");
 await page.locator('.tabs [data-tab="contracts"]').click();
 await page.locator("#addContract").click();
 const labels=await page.locator('#modal [name="category"] option').allTextContents();
 assert.deepEqual(labels.filter(Boolean),["会务需求","劳务专家","企业赞助"],
  "contract form must expose exactly three requested categories");
 await page.locator('#modal [data-x="0"]').click();
 const html=await page.evaluate(async()=>{
  const {stepBody}=await import("/assets/js/lib/verify-detail.js");
  const materials=[
   {id:1,kind:"合同",name:"HT-001 · 会务合同",file_name:"会务原件.pdf",file_key:"meeting.pdf"},
   {id:2,kind:"合同",name:"HT-002 · 劳务专家合同",file_name:"专家原件.pdf",file_key:"labor.pdf"},
   {id:3,kind:"合同",name:"HT-003 · 赞助合同",file_name:"赞助原件.pdf",file_key:"sponsor.pdf"},
   {id:4,kind:"会务发票",name:"会务发票",file_name:"会务发票.pdf",file_key:"meeting-invoice.pdf"},
   {id:5,kind:"发票",name:"赞助收据",file_name:"赞助发票.pdf",file_key:"sponsor-invoice.pdf"},
   {id:6,kind:"终版议程",name:"终版议程",file_name:"旧议程.pdf",file_key:"agenda.pdf"},
   {id:7,kind:"权益照片",name:"背景板交付",file_name:"权益照片.jpg",file_key:"right-photo.jpg",sponsor_right_id:71},
   {id:8,kind:"课件",name:"课件",file_name:"讲课.pptx",file_key:"course.pptx"}
  ];
  const contracts=[
   {id:"HT1",category:"会务需求",status:"已签署",file_key:"meeting.pdf",amount:5000},
   {id:"HT2",category:"劳务专家",status:"已签署",file_key:"labor.pdf",amount:2000},
   {id:"HT3",category:"企业赞助",status:"已签署",file_key:"sponsor.pdf",amount:9000}
  ];
  const sponsorRights={
    contracts:[{id:"SC1",enterprise:"企业A",status:"已签署",file_key:"sponsor.pdf",file_name:"赞助原件.pdf"}],
    requiredRights:[{id:71,sponsor_id:"SC1",category:"背景板Logo",confirmed:1}],
    photos:[materials[6]]
  };
  const d={materials,contracts,sponsorRights,
    demand:{archived:true,budgetTotal:5000},
    verification:{steps:[{no:6,result:"待判定",invoiceAmount:5000},
      {no:7,result:"待判定"}]}};
  return {six:stepBody(d,6),seven:stepBody(d,7)};
 });
 for(const name of ["会务原件.pdf","会务发票.pdf","会务需求表"]){
  assert.ok(html.six.includes(name),"step 6 must include "+name);
 }
 for(const excluded of ["专家原件.pdf","赞助原件.pdf","赞助发票.pdf","旧议程.pdf"]){
  assert.ok(!html.six.includes(excluded),"step 6 unrelated file leaked: "+excluded);
 }
 for(const name of ["赞助原件.pdf","权益照片.jpg","背景板Logo"]){
  assert.ok(html.seven.includes(name),"step 7 must include "+name);
 }
 for(const excluded of ["会务原件.pdf","会务发票.pdf","专家原件.pdf","旧议程.pdf"]){
  assert.ok(!html.seven.includes(excluded),"step 7 unrelated file leaked: "+excluded);
 }
 console.log("PASS: project contract categories and step6/step7 linked sources in real Chrome");
})().then(async()=>{
 await browser?.close();server?.kill("SIGTERM");fs.rmSync(dir,{recursive:true,force:true});
}).catch(async e=>{
 console.error(e);await browser?.close().catch(()=>{});server?.kill("SIGTERM");
 fs.rmSync(dir,{recursive:true,force:true});process.exitCode=1;
});
