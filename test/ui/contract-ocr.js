"use strict";
/** Real Chrome regression: upload DOCX, call OCR/text preview, and verify DOM auto-fill. */
const assert=require("node:assert/strict");
const {chromium}=require("playwright");
const {spawn}=require("node:child_process");
const {mkdtempSync,rmSync}=require("node:fs");
const os=require("node:os"),path=require("node:path");
const PizZip=require("pizzip");
const dir=mkdtempSync(path.join(os.tmpdir(),"erp-ledger-ocr-ui-"));
const port=8986,origin="http://127.0.0.1:"+port;
let proc,browser;
function docx(lines){
 const zip=new PizZip();
 zip.file("[Content_Types].xml",'<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>');
 zip.file("_rels/.rels",'<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>');
 zip.file("word/document.xml",'<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>'+
   lines.map(line=>'<w:p><w:r><w:t>'+line+'</w:t></w:r></w:p>').join("")+
   '</w:body></w:document>');
 return zip.generate({type:"nodebuffer",compression:"DEFLATE"});
}
async function run(){
 proc=spawn(process.execPath,["--experimental-sqlite","server/index.js"],{
  cwd:path.resolve(__dirname,"../.."),
  env:{...process.env,ERP_DEMO_MODE:"1",ERP_PORT:String(port),ERP_DB:path.join(dir,"db.sqlite"),
    ERP_UPLOAD_DIR:path.join(dir,"uploads"),ERP_OCR_ENABLED:"0"},
  stdio:["ignore","pipe","pipe"]});
 let stderr="";proc.stderr.on("data",part=>stderr+=String(part));
 let ready=false;
 for(let i=0;i<250;i++){
  try{if((await fetch(origin+"/api/health")).ok){ready=true;break;}}catch{}
  if(proc.exitCode!==null)throw Error(stderr);
  await new Promise(r=>setTimeout(r,100));
 }
 assert.ok(ready,"server failed to start: "+stderr);
 browser=await chromium.launch({channel:"chrome",headless:true});
 const page=await browser.newPage({viewport:{width:1440,height:920}});
 const errors=[];page.on("pageerror",e=>errors.push(e.message));
 await page.goto(origin);
 await page.locator('input[name="username"]').fill("admin");
 await page.locator('input[name="password"]').fill("123456");
 await page.locator("#lbtn").click();
 await page.locator("#nav").waitFor({timeout:15000});
 await page.goto(origin+"/#/contracts",{waitUntil:"domcontentloaded"});
 await page.locator("#newC").waitFor({timeout:15000});
 await page.locator("#newC").click();
 const form=page.locator("#modal.open");
 await form.locator('[name="pid"]').selectOption("MP-2026-001");
 await form.locator('[name="category"]').selectOption("企业赞助");
 const content=docx([
  "企业赞助合同",
  "甲方：广东省医学会    乙方：广州睿康医疗科技有限公司",
  "合同总价：人民币88,000.00元",
  "权益内容：","1. 主会场背景板LOGO露出"
 ]);
 await form.locator('input[name="file"]').setInputFiles({
  name:"赞助协议.docx",
  mimeType:"application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  buffer:content
 });
 try{
  await page.waitForFunction(()=>{
   const root=document.querySelector("#modal.open");
   return !!root&&root.querySelector('[name="vendor"]')?.value==="广州睿康医疗科技有限公司"&&
     root.querySelector('[name="amount"]')?.value==="88000";
  },null,{timeout:20000});
 }catch(e){
  const snapshot=await form.evaluate(root=>({
   vendor:root.querySelector('[name="vendor"]')?.value,
   amount:root.querySelector('[name="amount"]')?.value,
   message:root.querySelector('[data-contract-scan]')?.textContent
  }));
  throw Error("OCR auto-fill did not reach input controls: "+JSON.stringify(snapshot)+"\n"+e.message);
 }
 const note=await form.locator("[data-contract-scan]").innerText();
 assert.match(note,/已识别并预填/);
 const rights=await form.locator('[name="rightsCategories"]').inputValue();
 assert.match(rights,/主会场背景板/);
 await form.locator('[data-x="0"]').click();
 const projectId=await page.evaluate(async()=>{
   const r=await fetch("/api/projects",{credentials:"same-origin"});
   const d=await r.json();
   return d.rows.find(p=>!["已归档","已结算","已核销"].includes(p.status))?.id;
 });
 assert.ok(projectId,"need a writable project for in-project contract entry");
 await page.goto(origin+"/#/projects/"+projectId,{waitUntil:"domcontentloaded"});
 await page.locator('[data-tab="contracts"]').waitFor({timeout:15000});
 await page.locator('[data-tab="contracts"]').first().click();
 await page.locator("#addContract").waitFor({timeout:15000});
 await page.locator("#addContract").click();
 const laborForm=page.locator("#modal.open");
 await laborForm.locator('[name="category"]').selectOption("劳务专家");
 const laborDoc=docx([
  "专家劳动报酬合同","甲方：广东省医学会","乙方：张三",
  "合同总金额：人民币20,000元",
  "劳动报酬（税前）：人民币12,600.50元",
  "其他费用：3000元"
 ]);
 await laborForm.locator('input[name="file"]').setInputFiles({
  name:"专家劳动报酬合同.docx",
  mimeType:"application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  buffer:laborDoc
 });
 try{
  await page.waitForFunction(()=>{
   const root=document.querySelector("#modal.open");
   return root?.querySelector('[name="amount"]')?.value==="12600.5";
  },null,{timeout:20000});
 }catch(e){
  const snapshot=await laborForm.evaluate(root=>({
   amount:root.querySelector('[name="amount"]')?.value,
   category:root.querySelector('[name="category"]')?.value,
   note:root.querySelector('[data-contract-scan]')?.textContent
  }));
  throw Error("Project contract labor remuneration OCR did not auto-fill: "+JSON.stringify(snapshot)+"\n"+e.message);
 }
 assert.match(await laborForm.locator('[data-contract-scan]').innerText(),/劳动报酬/);
 // A manual correction always wins over an OCR suggestion on the next file.
 await laborForm.locator('[name="amount"]').fill("12900");
 await laborForm.locator('input[name="file"]').setInputFiles({
  name:"专家劳动报酬合同-更新.docx",
  mimeType:"application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  buffer:laborDoc
 });
 await page.waitForFunction(()=>{
   const root=document.querySelector("#modal.open");
   return root?.querySelector('[data-contract-scan]')?.textContent.includes("已识别并预填");
 },null,{timeout:20000});
 assert.equal(await laborForm.locator('[name="amount"]').inputValue(),"12900",
  "manual contract amount should not be overwritten by repeat OCR");
 assert.deepEqual(errors,[],"page JavaScript errors");
 console.log("PASS: ledger sponsor OCR and project contract labor remuneration OCR auto-fill");
}
run().then(async()=>{
 await browser?.close();proc?.kill("SIGTERM");rmSync(dir,{recursive:true,force:true});
}).catch(async e=>{
 console.error(e);await browser?.close().catch(()=>{});proc?.kill("SIGTERM");
 rmSync(dir,{recursive:true,force:true});process.exitCode=1;
});
