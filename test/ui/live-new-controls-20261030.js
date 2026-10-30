"use strict";
const { chromium } = require("playwright");
const fs = require("node:fs");
fs.mkdirSync("artifacts/live-new-controls",{recursive:true});
const BASE=process.env.ERP_BASE||"https://erp.aibuild.work";
const results=[]; let failures=0,passed=0,skipped=0;
function record(role,action,status,detail=""){
  results.push({role,action,status,detail:String(detail).slice(0,400)});
  if(status==="FAIL")failures++;else if(status==="PASS")passed++;else skipped++;
  console.log("NEW_CONTROL",role,action,status,detail);
}
async function route(page,key){
  await page.goto(BASE+"/#/"+key,{waitUntil:"domcontentloaded"});
  await page.waitForFunction(()=>!document.querySelector("#content .sk"),{timeout:20000}).catch(()=>{});
}
async function run(browser,role){
 const context=await browser.newContext({viewport:{width:1366,height:860},acceptDownloads:true});
 const page=await context.newPage();
 try{
  await page.goto(BASE);
  await page.locator("#lform").waitFor();
  await page.fill('input[name="username"]',role);
  await page.fill('input[name="password"]',"123456");
  await page.click("#lbtn");
  await page.locator("#app:not([hidden])").waitFor({timeout:20000});
  const nav=await page.locator("#nav [data-go]").evaluateAll(es=>es.map(e=>e.dataset.go));
  record(role,"侧栏只显示被授权邀请函模块",role==="finance"?(!nav.includes("prep-invitations")?"PASS":"FAIL"):"PASS",nav.join(","));
  if(role==="admin"){
    await route(page,"project-ledger");
    const q=page.locator("#ledgerSearch");
    await q.fill("MP-2026");
    await page.click("#ledgerSearchBtn");
    await page.waitForTimeout(450);
    record(role,"项目台账搜索",(await page.locator("#ledgerList").innerText()).includes("MP-2026")?"PASS":"FAIL");
    const first=page.locator("[data-open-ledger]").first();
    if(await first.count()){
      await first.click();await page.waitForTimeout(300);
      record(role,"项目台账查看详情",(await page.locator("#ledgerDetail").innerText()).includes("项目对照")?"PASS":"FAIL");
      const pending=page.waitForEvent("download",{timeout:20000});
      await page.click("#ledgerCsv");
      const file=await pending;
      record(role,"项目台账 CSV 导出",file.suggestedFilename().endsWith(".csv")?"PASS":"FAIL",file.suggestedFilename());
    }else record(role,"台账明细", "SKIP","无可见项目");
    await route(page,"invitation-config");
    const buttons=await page.locator("#content button").allTextContents();
    record(role,"邀请函配置按钮及发布入口",buttons.some(t=>t.includes("发布生效"))?"PASS":"FAIL",buttons.join("|"));
    const preview=page.locator("#preview-pdf");
    record(role,"邀请函模板预览按钮存在",await preview.count()?"PASS":"FAIL");
    record(role,"发布/回退和删除邮件密钥","SKIP","避免改变实际发布配置、发送能力与业务凭证");
  }
  if(["admin","assoc","exec"].includes(role)){
    await route(page,"prep-invitations");
    const select=page.locator("#templateType");
    if(await select.count()){
      await select.selectOption("guest");
      record(role,"嘉宾邀请模板切换",await page.locator("#recipientName").isVisible()?"PASS":"FAIL");
      await select.selectOption("enterprise");
      record(role,"企业邀请模板切换",await page.locator("#recipientOrg").isVisible()?"PASS":"FAIL");
      record(role,"真实邮件发送/微信小程序分享","SKIP","未发送外部消息，保留原有业务数据");
    }else record(role,"邀请函创建条件","SKIP","当前账户没有可生成邀请函的筹备会议");
  }
  if(["admin","assoc"].includes(role)){
    await route(page,"archive");
    const b=page.locator("[data-archive-pdf]").first();
    if(await b.count()){
      const pending=page.waitForEvent("download",{timeout:25000});
      await b.click();const item=await pending;
      record(role,"归档资料 PDF 按钮实际下载",item.suggestedFilename().endsWith(".pdf")?"PASS":"FAIL",item.suggestedFilename());
    }else record(role,"归档 PDF 下载","SKIP","没有已归档的可见会议");
  }
  if(role==="guest"){
    await route(page,"archive");
    record(role,"访客禁止进入档案模块",!new URL(page.url()).hash.startsWith("#/archive")?"PASS":"FAIL");
  }
  await page.screenshot({path:"artifacts/live-new-controls/"+role+"-final.png",fullPage:true});
 }catch(e){record(role,"交互脚本异常","FAIL",e.message);}
 await context.close();
}
(async()=>{
 const browser=await chromium.launch({headless:true});
 for(const role of ["admin","assoc","exec","finance","guest"]) await run(browser,role);
 await browser.close();
 fs.writeFileSync("artifacts/live-new-controls/results.json",JSON.stringify({passed,failures,skipped,results},null,2));
 console.log("LIVE_NEW_CONTROLS",JSON.stringify({passed,failures,skipped}));
 process.exitCode=failures?1:0;
})().catch(e=>{console.error("FATAL",e.stack);process.exitCode=2;});
