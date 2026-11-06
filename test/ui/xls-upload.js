"use strict";
/** 真实 Chrome：材料中心允许选旧版 .xls，并实际上传、归档、下载完整原件。 */
const {chromium}=require("playwright");
const {spawn}=require("node:child_process");
const fs=require("node:fs"),path=require("node:path");
const {cfbFixture}=require("../lib/legacy-office-fixture");

const ROOT=path.join(__dirname,"..","..");
const PORT=8897,BASE="http://127.0.0.1:"+PORT;
const DB=path.join(ROOT,"data","ui-xls-upload.db");
const UP=path.join(ROOT,"data","ui-xls-upload-files");
const BYTES=cfbFixture("Workbook");
let server,browser;
async function waitReady() {
  for(let i=0;i<150;i++) {
    try { if((await fetch(BASE+"/api/health")).ok)return; } catch {}
    await new Promise(r=>setTimeout(r,180));
  }
  throw Error("test ERP not ready");
}
(async()=>{
  for(const suffix of ["","-wal","-shm"])fs.rmSync(DB+suffix,{force:true});
  fs.rmSync(UP,{force:true,recursive:true});
  server=spawn(process.execPath,["--experimental-sqlite","server/index.js"],{
    cwd:ROOT,env:{...process.env,ERP_DEMO_MODE:"1",ERP_DB:DB,ERP_PORT:String(PORT),ERP_UPLOAD_DIR:UP},
    stdio:["ignore","pipe","pipe"]
  });
  server.stderr.on("data",b=>{if(!String(b).includes("ExperimentalWarning"))process.stderr.write(String(b));});
  await waitReady();
  browser=await chromium.launch({channel:"chrome",headless:true});
  const page=await browser.newPage({viewport:{width:1440,height:900}});
  page.on("pageerror",error=>{throw error;});
  await page.goto(BASE,{waitUntil:"domcontentloaded"});
  await page.fill('input[name="username"]',"admin");
  await page.fill('input[name="password"]',"123456");
  await page.click("#lbtn");
  await page.waitForSelector("#pwdBtn");
  await page.goto(BASE+"/#/materials",{waitUntil:"domcontentloaded"});
  await page.waitForSelector("#add");
  await page.click("#add");
  const input=page.locator('#modal input[type="file"]');
  await input.waitFor();
  const accept=await input.getAttribute("accept");
  if(!accept?.includes(".xls"))throw Error("材料上传控件没有 .xls: "+accept);
  await input.setInputFiles({name:"测试旧版.xls",mimeType:"application/vnd.ms-excel",buffer:BYTES});
  await page.waitForTimeout(300);
  const pid=await page.locator('#modal [name="pid"]').evaluate(el=>{
    const opt=Array.from(el.options).find(o=>o.value);
    return opt?.value || "";
  });
  if(!pid)throw Error("no accessible project");
  await page.selectOption('#modal [name="pid"]',pid);
  await page.selectOption('#modal [name="kind"]',"劳务收集表");
  await page.fill('#modal [name="name"]',"旧版Excel名单浏览器上传测试");
  await page.click('#modal [data-x="1"]');
  await page.waitForFunction(()=>!document.querySelector("#modal.open"),null,{timeout:15000});
  const response=await page.request.get(BASE+"/api/materials");
  if(!response.ok())throw Error("material list failed "+response.status());
  const data=await response.json();
  const row=data.rows.find(x=>x.file_name==="测试旧版.xls");
  if(!row || !row.file_key?.endsWith(".xls"))throw Error("XLS file missing from material list");
  const file=await page.request.get(BASE+"/api/uploads/"+row.file_key);
  if(file.status()!==200 || file.headers()["content-type"]!=="application/vnd.ms-excel")
    throw Error("XLS download returned "+file.status()+" "+file.headers()["content-type"]);
  if(!Buffer.from(await file.body()).equals(BYTES))throw Error("XLS bytes changed after upload");
  if(!file.headers()["content-disposition"]?.startsWith("attachment;"))
    throw Error("legacy Excel should force download rather than embed");
  await page.reload({waitUntil:"domcontentloaded"});
  await page.waitForTimeout(500);
  const text=await page.textContent("body");
  if(!text.includes("测试旧版.xls"))throw Error("material list did not show XLS download");
  if(await page.locator('img.thumb[src$=".xls"]').count())throw Error("XLS wrongly rendered as image");
  console.log("✓ .xls 可选、可上传、按 Excel MIME 保存、下载字节一致、材料列表正确显示");
})().then(async()=>{await browser?.close();server?.kill("SIGTERM");fs.rmSync(UP,{force:true,recursive:true});})
  .catch(async e=>{console.error(e);await browser?.close();server?.kill("SIGTERM");process.exitCode=1;});
