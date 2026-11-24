"use strict";
/** Browser black box: finance direct payment is one screen, paid checkbox + voucher upload. */
const assert=require("node:assert/strict");
const {chromium}=require("playwright");
const {spawn}=require("node:child_process");
const fs=require("node:fs"),os=require("node:os"),path=require("node:path");
const dir=fs.mkdtempSync(path.join(os.tmpdir(),"erp-direct-payment-ui-"));
const port=16840+(process.pid%110),origin="http://127.0.0.1:"+port,pid="MP-2026-008";
const PDF=Buffer.from("%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n");
let server,browser;
(async()=>{
 server=spawn(process.execPath,["--experimental-sqlite","server/index.js"],{
 cwd:path.resolve(__dirname,"../.."),env:{...process.env,
 ERP_DEMO_MODE:"1",ERP_HOST:"127.0.0.1",ERP_PORT:String(port),
 ERP_DB:path.join(dir,"test.sqlite"),ERP_UPLOAD_DIR:path.join(dir,"files")},
 stdio:["ignore","pipe","pipe"]});
 let logs="";server.stderr.on("data",b=>logs+=String(b));
 let ready=false;
 for(let i=0;i<300;i++){
  try{if((await fetch(origin+"/api/health")).ok){ready=true;break;}}catch{}
  await new Promise(done=>setTimeout(done,110));
 }
 assert.ok(ready,"server start: "+logs);
 browser=await chromium.launch({channel:"chrome",headless:true});
 const page=await browser.newPage({viewport:{width:1480,height:900}});
 const jsErrors=[];page.on("pageerror",e=>jsErrors.push(e.message));
 await page.goto(origin);
 await page.locator('input[name="username"]').fill("finance");
 await page.locator('input[name="password"]').fill("123456");
 await page.locator("#lbtn").click();
 await page.locator("#nav").waitFor({timeout:15000});
 await page.goto(origin+"/#/finance");
 const form=page.locator("#financeDirect");
 await form.waitFor({timeout:15000});
 const text=await page.locator("#fin-payments").innerText();
 for(const column of ["类目","金额","付款（勾选）","凭证详情"])
  assert.ok(text.includes(column),"missing column: "+column);
 assert.equal(await page.locator("#newPay").count(),0,"finance should not use payment application");
 await form.locator('[name="pid"]').selectOption(pid);
 const payee=form.locator('[name="payee_option_id"]');
 await page.waitForFunction(()=>document.querySelector('#financeDirect select[name="payee_option_id"]')?.options?.[0]?.textContent?.includes("手动填写"),null,{timeout:15000});
 await payee.selectOption("");
 await form.locator('[name="type"]').selectOption("学会公付");
 await form.locator('[name="payee"]').fill("财务直付浏览器回单测试");
 await form.locator('[name="amount"]').fill("76.25");
 await form.locator('[name="payee_bank"]').fill("中国银行北京分行");
 await form.locator('[name="payee_account"]').fill("3210987654321098");
 await form.locator("[data-direct-voucher]").setInputFiles({
  name:"已完成银行转账凭证.pdf",mimeType:"application/pdf",buffer:PDF
 });
 await form.locator("[data-direct-paid]").check();
 await form.locator("[data-direct-submit]").click();
 const dialog=page.locator("#modal.open");
 await dialog.locator('[data-x="1"]').click();
 await page.waitForFunction(()=>[...document.querySelectorAll('[data-row]')].some(
  row=>row.innerText.includes("财务直付浏览器回单测试")&&row.innerText.includes("已付款")&&row.querySelector('a[href*="/api/uploads/"]')
 ),{timeout:15000});
 const list=await (await page.request.get(origin+"/api/payments?pid="+pid)).json();
 const paid=list.rows.find(r=>r.payee==="财务直付浏览器回单测试");
 assert.ok(paid);
 assert.equal(paid.status,"已付款");
 assert.ok(paid.receipt_file_key);
 const receipt=await page.request.get(origin+"/api/uploads/"+paid.receipt_file_key);
 assert.equal(receipt.status(),200);
 assert.deepEqual(Buffer.from(await receipt.body()),PDF);
 assert.deepEqual(jsErrors,[],"browser must have no JS errors");
 const normal=await browser.newPage();
 await normal.goto(origin);
 await normal.locator('input[name="username"]').fill("exec");
 await normal.locator('input[name="password"]').fill("123456");
 await normal.locator("#lbtn").click();
 await normal.locator("#nav").waitFor({timeout:15000});
 await normal.goto(origin+"/#/finance");
 await normal.locator("#nav").waitFor({timeout:15000});
 await normal.waitForTimeout(350); // May be redirected from finance, which is valid for a non-finance role.
 assert.equal(await normal.locator("#financeDirect").count(),0,"exec cannot access finance direct payment form");
 const forbidden=await normal.request.post(origin+"/api/payments/direct",{data:{
  pid,type:"学会公付",payee:"非法财务直付",amount:1,confirm_paid:true
 }});
 assert.equal(forbidden.status(),403);
 await normal.close();
 console.log("PASS: single-page finance direct payment, checked paid, receipt upload and non-finance denial");
})().catch(e=>{console.error(e);process.exitCode=1}).finally(async()=>{
 try{await browser?.close();}finally{server?.kill("SIGTERM");fs.rmSync(dir,{recursive:true,force:true});}
});
