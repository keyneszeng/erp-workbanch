"use strict";
/** Real-browser smoke test for screenshot B1–B5. Runs against isolated seeded demo DB. */
const {chromium}=require("playwright");
const {spawn}=require("node:child_process");
const fs=require("node:fs"),os=require("node:os"),path=require("node:path");
const assert=require("node:assert/strict");
(async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),"erp-ux-browser-"));
 const port=14500+(process.pid%500),origin="http://127.0.0.1:"+port;
 const child=spawn(process.execPath,["--experimental-sqlite","server/index.js"],{
  cwd:path.resolve(__dirname,"../.."),stdio:["ignore","pipe","pipe"],
  env:{...process.env,ERP_DEMO_MODE:"1",ERP_DB:path.join(dir,"demo.db"),ERP_UPLOAD_DIR:path.join(dir,"uploads"),ERP_HOST:"127.0.0.1",ERP_PORT:String(port)}
 });
 let err="";child.stderr.on("data",c=>err+=String(c));let browser;
 try{
  let started=false;
  for(let i=0;i<150;i++){
   if(child.exitCode!==null)throw Error("demo server crashed: "+err);
   try{const r=await fetch(origin+"/api/health");if(r.ok){started=true;break;}}catch{}
   await new Promise(resolve=>setTimeout(resolve,100));
  }
  assert.ok(started,"demo test server did not start "+err);
  browser=await chromium.launch({channel:"chrome",headless:true});
  const page=await browser.newPage({viewport:{width:1480,height:950}});
  const errors=[];
  page.on("pageerror",e=>errors.push(e.message));
  await page.goto(origin,{waitUntil:"domcontentloaded"});
  await page.locator('input[name="username"]').fill("admin");
  await page.locator('input[name="password"]').fill("123456");
  await page.locator("#lbtn").click();
  await page.locator(".ux-kpi-grid").waitFor({timeout:12000});
  assert.equal(await page.locator(".ux-metric").count(),4,"dashboard should show the four workbench KPI cards");
  const kpis=await page.locator(".ux-metric span").allTextContents();
  assert.deepEqual(kpis,["在管会议","待核销","预算总额","已付款"],
    "four business summary KPIs belong on my workbench in the requested order");
  await page.goto(origin+"/#/flow");
  await page.locator(".flowwrap").waitFor({timeout:12000});
  assert.equal(await page.locator(".ux-metric, .grid.g4 .kpi").count(),0,
    "flow overview should not duplicate dashboard KPIs");
  assert.ok((await page.locator("body").innerText()).includes("我的待办"));
  const list=await page.request.get(origin+"/api/projects");
  assert.ok(list.ok(),"project list should remain accessible");
  const projects=(await list.json()).rows;
  assert.ok(projects.length,"seeded demo has projects");
  await page.goto(origin+"/#/projects/"+encodeURIComponent(projects[0].id));
  await page.locator(".ux-lifecycle").waitFor({timeout:12000});
  assert.equal(await page.locator(".ux-checkpoints button").count(),4);
  await page.locator('.ux-checkpoints [data-tab="materials"]').click();
  await page.locator('.tabs [data-tab="materials"].on').waitFor();
  await page.goto(origin+"/#/materials");
  await page.locator("#materialWorkbench .panel").waitFor({timeout:12000});
  await page.locator("#materialWorkbench #wbProject").waitFor();
  await page.goto(origin+"/#/finance");
  await page.locator(".ux-finance-tabs").waitFor({timeout:12000});
  await page.locator('[data-finance-jump="fin-settlements"]').click();
  assert.equal(await page.locator(".ux-finance-tab.active").count(),1);
  assert.equal(errors.length,0,"page errors: "+errors.join(" / "));
  console.log("Browser B1/B3/B4/B5 visual smoke PASSED");
 }finally{
  if(browser)await browser.close();
  child.kill("SIGTERM");
  fs.rmSync(dir,{recursive:true,force:true});
 }
})().catch(e=>{console.error(e);process.exitCode=1;});
