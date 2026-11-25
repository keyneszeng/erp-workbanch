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
 const projectList=page.locator("#paymentProjects");
 await projectList.waitFor({timeout:15000});
 assert.equal(await page.locator("#fin-payments [data-st]").count(),0,"付款状态筛选已移除");
 assert.equal(await page.locator("#paymentDetails").count(),0,"点击会议前不加载付款明细");
 const projects=await (await page.request.get(origin+"/api/projects")).json();
 for(const p of projects.rows){
  assert.equal(await projectList.locator('[data-go="finance/'+p.id+'"]').count(),p.status==="已核销"?1:0,"仅列出已核销项目");
 }
 await projectList.locator('[data-go="finance/'+pid+'"]').click();
 const details=page.locator("#paymentDetails");
 await details.waitFor({timeout:15000});
 const text=await details.innerText();
 for(const column of ["收款方","金额","付款按钮","凭证详情"])
  assert.ok(text.includes(column),"missing column: "+column);
 assert.equal(await page.locator("#newPay").count(),0,"finance should not use payment application");
 // Use an existing approved payment fixture, or create one with the test admin session.
 const adminContext=await browser.newContext();
 const login=await adminContext.request.post(origin+"/api/auth/login",{data:{username:"admin",password:"123456"}});
 assert.equal(login.status(),200);
 const created=await adminContext.request.post(origin+"/api/payments",{data:{pid,type:"学会公付",payee:"逐行付款浏览器测试",amount:76.25}});
 assert.equal(created.status(),200);
 const id=(await created.json()).payment.id;
 assert.equal((await adminContext.request.post(origin+"/api/payments/"+id+"/approve",{data:{approve:true}})).status(),200);
 await adminContext.close();
 await page.reload();
 const row=page.locator('[data-row="'+id+'"]');
 await row.waitFor({timeout:15000});
 await row.locator("[data-pay-evidence]").click();
 await page.locator("#modal.open [data-close-evidence]").click();
 await row.locator("[data-pay]").click();
 await row.getByText("已付款",{exact:false}).waitFor({timeout:15000});
 assert.equal(await page.locator("#paymentDirectPanel,#financeDirect,#modal.open").count(),0,"确认已付款不弹出登记表单");
 await row.locator("[data-receipt]").click();
 const dialog=page.locator("#modal.open");
 await dialog.locator("[data-payment-voucher]").setInputFiles({name:"银行转账凭证.pdf",mimeType:"application/pdf",buffer:PDF});
 await dialog.locator('[data-x="1"]').click();
 await row.getByText("查看付款凭证").waitFor({timeout:15000});
 const list=await (await page.request.get(origin+"/api/payments?pid="+pid)).json();
 const paid=list.rows.find(r=>r.id===id);
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
 assert.equal(await normal.locator("#financeDirect").count(),0,"exec cannot access the removed payment form");
 const forbidden=await normal.request.post(origin+"/api/payments/direct",{data:{
  pid,type:"学会公付",payee:"非法财务直付",amount:1,confirm_paid:true
 }});
 assert.equal(forbidden.status(),403);
 await normal.close();
 console.log("PASS: inline paid confirmation, linked originals, separate receipt upload and permission denial");
})().catch(e=>{console.error(e);process.exitCode=1}).finally(async()=>{
 try{await browser?.close();}finally{server?.kill("SIGTERM");fs.rmSync(dir,{recursive:true,force:true});}
});
