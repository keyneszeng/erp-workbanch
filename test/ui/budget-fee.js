"use strict";
/** 真实 Chrome 检查：立项预算下方税费管理费率与实时可用预算。 */
const {chromium}=require("playwright"),{spawn}=require("node:child_process");
const fs=require("node:fs"),os=require("node:os"),path=require("node:path");
const dir=fs.mkdtempSync(path.join(os.tmpdir(),"erp-fee-ui-")),port=8984;
const base="http://127.0.0.1:"+port;
let server,browser;
async function health(){
 for(let i=0;i<180;i++){try{if((await fetch(base+"/api/health")).ok)return;}catch{}
 await new Promise(r=>setTimeout(r,150));}
 throw Error("budget fee UI server unavailable");
}
async function run(){
 server=spawn(process.execPath,["--experimental-sqlite","server/index.js"],{
 cwd:path.join(__dirname,".."),env:{...process.env,ERP_DEMO_MODE:"1",
 ERP_DB:path.join(dir,"erp.db"),ERP_PORT:String(port),ERP_UPLOAD_DIR:path.join(dir,"uploads")},
 stdio:["ignore","pipe","pipe"]});
 server.stderr.on("data",c=>{if(!String(c).includes("ExperimentalWarning"))process.stderr.write(c)});
 await health();
 browser=await chromium.launch({channel:"chrome",headless:true});
 const page=await browser.newPage({viewport:{width:1366,height:900}});
 await page.goto(base,{waitUntil:"domcontentloaded"});
 await page.locator('input[name="username"]').fill("admin");
 await page.locator('input[name="password"]').fill("123456");
 await page.click("#lbtn");
 await page.waitForTimeout(1000);
 await page.goto(base+"/#/projects",{waitUntil:"domcontentloaded"});
 await page.locator("#newBtn").waitFor({timeout:20000});
 await page.click("#newBtn");
 const form=page.locator("#modal");
 await form.locator('input[name="tax_fee_rate"]').waitFor({timeout:15000});
 await form.locator('input[name="budget"]').fill("100000");
 await form.locator('input[name="tax_fee_rate"]').fill("10");
 const output=form.locator("[data-available-budget]");
 await output.getByText("¥90,000.00").waitFor();
 const budgetRect=await form.locator('input[name="budget"]').boundingBox();
 const feeRect=await form.locator('input[name="tax_fee_rate"]').boundingBox();
 if(!budgetRect||!feeRect||feeRect.y<=budgetRect.y)throw Error("税费管理费率应位于预算输入框下方");
 await form.locator('input[name="tax_fee_rate"]').fill("12.5");
 await output.getByText("¥87,500.00").waitFor();
 await form.locator('input[name="tax_fee_rate"]').fill("125");
 await output.getByText("请检查预算和费率").waitFor();
 await form.locator('[data-a="draft"]').click();
 if(!(await form.isVisible()))throw Error("无效费率不应允许提交");
 await form.locator('input[name="tax_fee_rate"]').fill("10");
 await form.locator('input[name="name"]').fill("税费实时计算浏览器验收");
 await form.locator('input[name="date"]').fill("2027-07-12");
 await form.locator('textarea[name="agenda"]').fill("09:00 开幕式，10:00 专题报告");
 await form.locator('select[name="owner_id"]').selectOption({index:1});
 await form.locator('[data-a="draft"]').click();
 await page.waitForURL(/#\/projects\/MP-/, {timeout:20000});
 const id=page.url().split("/").pop();
 const r=await page.request.get(base+"/api/projects/"+id);
 if(!r.ok())throw Error("获取立项详情失败 "+r.status());
 const data=await r.json();
 if(data.project.tax_fee_rate!==10||data.project.available_budget!==90000)
   throw Error("UI保存后费率及可用预算未持久化 "+JSON.stringify(data.project));
 if(!(await page.getByText("可用预算").count()))throw Error("项目详情未显示可用预算");
 console.log("PASS: tax fee field positioned below budget, live preview, validation, persistence and overview");
}
run().catch(e=>{console.error(e);process.exitCode=1}).finally(async()=>{
 await browser?.close();server?.kill("SIGTERM");fs.rmSync(dir,{recursive:true,force:true});
});
