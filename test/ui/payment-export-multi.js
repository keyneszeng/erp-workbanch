"use strict";
/** Chrome 黑盒：多会议勾选、搜索、全选/清空、CSV 下载与选择范围。 */
const assert=require("node:assert/strict");
const {chromium}=require("playwright");
const {spawn}=require("node:child_process");
const fs=require("node:fs"),os=require("node:os"),path=require("node:path");
const dir=fs.mkdtempSync(path.join(os.tmpdir(),"erp-pay-export-"));
const port=16220+(process.pid%120);
const origin="http://127.0.0.1:"+port;
let server,browser;
async function ready(){
 let log="";
 server.stderr.on("data",c=>log+=String(c));
 for(let i=0;i<230;i++){
  if(server.exitCode!==null)throw Error("ERP stopped: "+log);
  try{if((await fetch(origin+"/api/health")).ok)return;}catch{}
  await new Promise(r=>setTimeout(r,100));
 }
 throw Error("ERP startup timeout "+log);
}
(async()=>{
 server=spawn(process.execPath,["--experimental-sqlite","server/index.js"],{
  cwd:path.resolve(__dirname,"../.."),env:{...process.env,
   ERP_DEMO_MODE:"1",ERP_HOST:"127.0.0.1",ERP_PORT:String(port),
   ERP_DB:path.join(dir,"db.sqlite"),ERP_UPLOAD_DIR:path.join(dir,"files")},
  stdio:["ignore","pipe","pipe"]
 });
 await ready();
 browser=await chromium.launch({channel:"chrome",headless:true});
 const page=await browser.newPage({viewport:{width:1440,height:940},acceptDownloads:true});
 const jsErrors=[];page.on("pageerror",e=>jsErrors.push(e.message));
 await page.goto(origin);
 await page.locator('input[name="username"]').fill("admin");
 await page.locator('input[name="password"]').fill("123456");
 await page.locator("#lbtn").click();
 await page.locator("#nav").waitFor({timeout:12000});
 const data=await (await page.request.get(origin+"/api/projects")).json();
 const projects=data.rows.filter(p=>p.id&&p.name);
 assert.ok(projects.length>=3,"需要至少三场不同会议");
 const chosen=projects.slice(0,2),other=projects[2];
 await page.goto(origin+"/#/finance",{waitUntil:"domcontentloaded"});
 await page.locator("#expPay").waitFor({timeout:15000});
 await page.locator("#expPay").click();
 await page.locator('#modal.open [data-payment-search]').waitFor();
 assert.equal(await page.locator("[data-payment-confirm]").isDisabled(),true,
  "未选择会议必须禁用导出");
 for(const p of chosen){
  await page.locator("[data-payment-search]").fill(p.id);
  const row=page.locator('#modal [data-payment-pid="'+p.id+'"]');
  await row.waitFor({timeout:10000});
  assert.equal(await page.locator("#modal [data-payment-pid]").count(),1,
   "搜索会议编号应只显示匹配结果");
  await row.check();
 }
 await page.locator("[data-payment-search]").fill("");
 assert.equal(await page.locator("#modal [data-payment-count]").innerText(),
  "已选择 2 场会议 · 当前匹配 "+projects.length+" 场");
 for(const p of chosen)
  assert.equal(await page.locator('#modal [data-payment-pid="'+p.id+'"]').isChecked(),true,
   "跨搜索关键词切换后必须保留已勾选会议");
 assert.equal(await page.locator('#modal [data-payment-pid="'+other.id+'"]').isChecked(),false);
 let sent=null;
 page.on("request",req=>{
  if(req.url().includes("/api/export/payments")&&req.method()==="POST")
   sent=req.postDataJSON();
 });
 const [download]=await Promise.all([
  page.waitForEvent("download",{timeout:15000}),
  page.locator("[data-payment-confirm]").click()
 ]);
 const csv=fs.readFileSync(await download.path(),"utf8").replace(/^\uFEFF/,"");
 assert.deepEqual([...sent.pids].sort(),chosen.map(x=>x.id).sort(),
  "请求必须只发送两个勾选项目编号");
 assert.match(csv,/^"付款单号","会议编号","项目"/);
 assert.match(download.suggestedFilename(),/付款明细.*2场会议/);
 const rows=csv.split("\r\n").slice(1).filter(Boolean);
 for(const row of rows){
  const match=/^"[^"]*","([^"]+)"/.exec(row);
  assert.ok(match&&chosen.some(x=>x.id===match[1]),"CSV 不得泄漏未勾选会议记录");
 }
 await page.locator("#expPay").click();
 await page.locator("[data-payment-search]").fill(other.id);
 await page.locator("[data-payment-select-visible]").click();
 assert.match(await page.locator("[data-payment-count]").innerText(),/已选择 1 场会议/);
 await page.locator("[data-payment-clear]").click();
 assert.equal(await page.locator("[data-payment-confirm]").isDisabled(),true);
 await page.locator("[data-payment-cancel]").click();
 assert.equal(await page.locator("#modal.open").count(),0);
 assert.deepEqual(jsErrors,[],"UI should have no unhandled JavaScript errors");
 console.log("PASS: multi meeting selection, scoped CSV, search, select-all, clear and cancellation");
})().catch(e=>{console.error(e);process.exitCode=1}).finally(async()=>{
 await browser?.close();server?.kill("SIGTERM");fs.rmSync(dir,{recursive:true,force:true});
});
