"use strict";
/** Real Chrome: upload a bank transfer receipt and verify OCR candidates reach the two form controls. */
const {chromium}=require("playwright");
const {spawn}=require("node:child_process");
const {mkdtempSync,rmSync}=require("node:fs");
const {strict:assert}=require("node:assert");
const PizZip=require("pizzip");
const path=require("node:path"),os=require("node:os");
const dir=mkdtempSync(path.join(os.tmpdir(),"erp-receipt-ocr-ui-"));
const port=8988,base="http://127.0.0.1:"+port;
let proc,browser;
function docx(){
 const zip=new PizZip();
 zip.file("[Content_Types].xml",'<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>');
 zip.file("_rels/.rels",'<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>');
 const rows=[
  "中国银行电子回单",
  "付款账号：6222000000001234567",
  "交易流水号：20261108000123456789",
  "收款账号：6217000000098765432",
  "手续费：5.00",
  "转账金额：人民币954.00元"
 ];
 zip.file("word/document.xml",
  '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>'+
  rows.map(s=>'<w:p><w:r><w:t>'+s+'</w:t></w:r></w:p>').join("")+'</w:body></w:document>');
 return zip.generate({type:"nodebuffer",compression:"DEFLATE"});
}
async function run(){
 proc=spawn(process.execPath,["--experimental-sqlite","server/index.js"],{
  cwd:path.resolve(__dirname,"../.."),
  env:{...process.env,ERP_DEMO_MODE:"1",ERP_PORT:String(port),ERP_HOST:"127.0.0.1",
   ERP_OCR_ENABLED:"0",ERP_DB:path.join(dir,"db.sqlite"),ERP_UPLOAD_DIR:path.join(dir,"uploads")},
  stdio:["ignore","pipe","pipe"]});
 let stderr="";proc.stderr.on("data",s=>stderr+=String(s));
 let up=false;
 for(let i=0;i<300;i++){
  try{if((await fetch(base+"/api/health")).ok){up=true;break;}}catch{}
  if(proc.exitCode!==null)throw Error(stderr);
  await new Promise(resolve=>setTimeout(resolve,100));
 }
 assert.ok(up,"server failed to start: "+stderr);
 browser=await chromium.launch({channel:"chrome",headless:true});
 const page=await browser.newPage({viewport:{width:1440,height:920}});
 const errors=[];page.on("pageerror",e=>errors.push(e.message));
 await page.goto(base);
 await page.locator('input[name="username"]').fill("admin");
 await page.locator('input[name="password"]').fill("123456");
 await page.locator("#lbtn").click();
 await page.locator("#nav").waitFor({timeout:15000});
 const ctx=page.context();
 const post=async(url,data)=>{
  const response=await ctx.request.post(base+url,{data,headers:{"Content-Type":"application/json"}});
  const value=await response.json();
  assert.equal(response.status(),200,JSON.stringify(value));
  return value;
 };
 const p=await post("/api/projects",{
  name:"银行回单OCR浏览器端到端项目",assoc:"华东医学会",form:"线下",
  date:"2027-11-20",budget:954,people:25,owner:"陈静",agenda:"银行回单识别"
 });
 const pid=p.project.id;
 const file=await ctx.request.post(base+"/api/uploads?pid="+pid,{
  data:Buffer.from("%PDF-1.4\n1 0 obj\n<<>>\nendobj\n%%EOF"),
  headers:{"Content-Type":"application/pdf","X-File-Name":"contract.pdf"}
 });
 assert.equal(file.status(),200,await file.text());
 const key=(await file.json()).key;
 const contract=await post("/api/projects/"+pid+"/income/contracts",{
  enterprise:"广州睿康医疗科技有限公司",amount:954,file_key:key,file_name:"contract.pdf"
 });
 await post("/api/projects/"+pid+"/income/contracts/"+contract.id+"/decide",{approve:true});
 await page.goto(base+"/#/finance",{waitUntil:"domcontentloaded"});
 await page.locator("#income-project").waitFor({timeout:20000});
 await page.locator("#income-project").selectOption(pid);
 const receiptButton=page.locator('[data-sponsor-receipt="'+contract.id+'"]');
 await receiptButton.waitFor({timeout:15000});
 await receiptButton.click();
 const modal=page.locator("#modal.open");
 assert.match(await modal.innerText(),/转款金额/);
 await modal.locator('[name="file"]').setInputFiles({
  name:"receipt.docx",
  mimeType:"application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  buffer:docx()
 });
 try{
  await page.waitForFunction(()=>{
   const m=document.querySelector("#modal.open");
   return m&&m.querySelector('[name="paymentRef"]')?.value==="20261108000123456789"&&
    m.querySelector('[name="amount"]')?.value==="954";
  },null,{timeout:22000});
 }catch(e){
  const snap=await modal.evaluate(m=>({
   number:m.querySelector('[name="paymentRef"]')?.value,
   amount:m.querySelector('[name="amount"]')?.value,
   scan:m.querySelector('[data-receipt-scan]')?.textContent
  }));
  throw Error("OCR data not filled in receipt form: "+JSON.stringify(snap)+"\n"+e.message);
 }
 assert.match(await modal.locator("[data-receipt-scan]").innerText(),/已识别/);
 // Manual corrections must take priority over late OCR callbacks.
 await modal.locator('[name="amount"]').fill("955");
 await modal.locator('[name="file"]').setInputFiles({
  name:"receipt-second.docx",
  mimeType:"application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  buffer:docx()
 });
 await page.waitForFunction(()=>{
  const el=document.querySelector("#modal.open [data-receipt-scan]");
  return el&&/已识别/.test(el.textContent);
 },null,{timeout:22000});
 assert.equal(await modal.locator('[name="amount"]').inputValue(),"955");
 await modal.locator('[name="amount"]').fill("954");
 await modal.locator('[name="receivedDate"]').fill("2027-11-19");
 await modal.locator("[data-save]").click();
 await modal.waitFor({state:"hidden",timeout:20000});
 const list=await ctx.request.get(base+"/api/projects/"+pid+"/income");
 const body=await list.json();
 assert.equal(list.status(),200);
 assert.equal(body.receipts.length,1);
 assert.equal(body.receipts[0].payment_ref,"20261108000123456789");
 assert.equal(body.receipts[0].amount,954);
 assert.deepEqual(errors,[]);
 console.log("PASS: bank receipt upload -> OCR -> amount/reference inputs -> registered receipt, manual edits kept");
}
run().then(async()=>{
 await browser?.close();proc?.kill("SIGTERM");
 rmSync(dir,{recursive:true,force:true});
}).catch(async e=>{
 console.error(e);await browser?.close().catch(()=>{});proc?.kill("SIGTERM");
 rmSync(dir,{recursive:true,force:true});process.exitCode=1;
});
