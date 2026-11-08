"use strict";
/** 实测两个入口：财务结算单查看 + 项目付款页、四类点击展开。 */
const {chromium}=require("playwright"),{spawn}=require("node:child_process");
const assert=require("node:assert/strict");
const fs=require("node:fs"),os=require("node:os"),path=require("node:path");
const dir=fs.mkdtempSync(path.join(os.tmpdir(),"erp-settle-ui-"));
const port=8986,origin="http://127.0.0.1:"+port;
let proc,browser;
async function ready(){
 for(let i=0;i<160;i++){try{if((await fetch(origin+"/api/health")).ok)return;}catch{}
 await new Promise(r=>setTimeout(r,150));}
 throw Error("server unavailable");
}
async function run(){
 proc=spawn(process.execPath,["--experimental-sqlite","server/index.js"],{
  cwd:path.resolve(__dirname,"../.."),
  env:{...process.env,ERP_DEMO_MODE:"1",ERP_PORT:String(port),
    ERP_DB:path.join(dir,"test.db"),ERP_UPLOAD_DIR:path.join(dir,"uploads")},
  stdio:["ignore","pipe","pipe"]});
 proc.stderr.on("data",c=>{if(!String(c).includes("ExperimentalWarning"))process.stderr.write(c)});
 await ready();
 browser=await chromium.launch({channel:"chrome",headless:true});
 const page=await browser.newPage({viewport:{width:1450,height:1000}});
 const pageErrors=[];page.on("pageerror",e=>pageErrors.push(String(e)));
 await page.goto(origin,{waitUntil:"domcontentloaded"});
 await page.locator('input[name="username"]').fill("admin");
 await page.locator('input[name="password"]').fill("123456");
 await page.locator("#lbtn").click();
 await page.locator(".ux-kpi-grid").waitFor({timeout:15000});
 await page.goto(origin+"/#/finance");
 await page.locator("#fin-settlements").waitFor({timeout:15000});
 const button=page.locator("[data-settlement-detail]").first();
 await button.waitFor();
 const settlementId=await button.getAttribute("data-settlement-detail");
 await button.click();
 const box=page.locator("#settlementDetail");
 await box.locator(".settlement-summary .kpi").first().waitFor({timeout:15000});
 assert.deepEqual(await box.locator(".settlement-summary .kpi .t").allTextContents(),
  ["预算","可用预算","已支付","结余"]);
 assert.deepEqual(await box.locator(".sg-name").allTextContents(),
  ["劳务","会务","协会报销","其他"]);
 assert.equal(await box.locator("details[open]").count(),0,"分类明细默认收起");
 await box.locator('[data-settlement-group="labor"] summary').click();
 assert.equal(await box.locator('[data-settlement-group="labor"][open]').count(),1,"点击劳务应展开");
 assert.ok(await box.locator('[data-settlement-group="labor"] .sg-rows').isVisible());
 const response=await page.request.get(origin+"/api/settlements/"+settlementId+"/breakdown");
 assert.ok(response.ok());
 const detail=await response.json();
 await page.goto(origin+"/#/projects/"+detail.pid);
 await page.locator('.tabs [data-tab="payments"]').waitFor({timeout:15000});
 await page.locator('.tabs [data-tab="payments"]').click();
 const project=page.locator("#tabbody .settlement-detail");
 await project.waitFor({timeout:12000});
 assert.deepEqual(await project.locator(".settlement-summary .kpi .t").allTextContents(),
  ["预算","可用预算","已支付","结余"]);
 await project.locator('[data-settlement-group="association"] summary').click();
 assert.equal(await project.locator('[data-settlement-group="association"][open]').count(),1);
 assert.deepEqual(pageErrors,[],"browser errors");
 console.log("PASS: settlement summary, category toggle, finance and project tabs");
}
run().catch(e=>{console.error(e);process.exitCode=1}).finally(async()=>{
 await browser?.close();proc?.kill("SIGTERM");fs.rmSync(dir,{recursive:true,force:true});
});
