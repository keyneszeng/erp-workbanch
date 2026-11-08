"use strict";
const {chromium}=require("playwright");
const {DatabaseSync}=require("node:sqlite");
const {PDFDocument}=require("pdf-lib");
const {spawn}=require("node:child_process"),fs=require("node:fs"),os=require("node:os"),path=require("node:path");
const assert=require("node:assert/strict");
const dir=fs.mkdtempSync(path.join(os.tmpdir(),"erp-export-ui-"));
const dbFile=path.join(dir,"db.sqlite"),uploads=path.join(dir,"uploads");
const port=8987,origin="http://127.0.0.1:"+port;
let proc,browser,database;
async function run(){
 proc=spawn(process.execPath,["--experimental-sqlite","server/index.js"],{
  cwd:path.resolve(__dirname,"../.."),env:{...process.env,ERP_PORT:String(port),
  ERP_DEMO_MODE:"1",ERP_DB:dbFile,ERP_UPLOAD_DIR:uploads},stdio:["ignore","pipe","pipe"]});
 let stderr="";proc.stderr.on("data",c=>stderr+=String(c));
 let ready=false;
 for(let i=0;i<180;i++){try{if((await fetch(origin+"/api/health")).ok){ready=true;break;}}catch{}
  if(proc.exitCode!==null)throw Error("server exited "+stderr);
  await new Promise(r=>setTimeout(r,120));}
 assert.ok(ready,"server failed to boot "+stderr);
 database=new DatabaseSync(dbFile);
 const original=await PDFDocument.create();original.addPage([400,450]);
 const pdfBytes=Buffer.from(await original.save());
 for(const [index,kind] of ["签到表","终版议程"].entries()){
  const key=String(index+1).repeat(32)+".pdf";
  fs.mkdirSync(path.join(uploads,key.slice(0,2)),{recursive:true});
  fs.writeFileSync(path.join(uploads,key.slice(0,2),key),pdfBytes);
  database.prepare("INSERT INTO materials(pid,kind,name,version,uploader,created_at,file_key,file_name,file_size,file_mime) VALUES (?,?,?,?,?,?,?,?,?,?)")
  .run("MP-2026-015",kind,kind+"-测试","终版","管理员","2026-11-07 10:00",key,kind+".pdf",pdfBytes.length,"application/pdf");
 }
 browser=await chromium.launch({channel:"chrome",headless:true});
 const context=await browser.newContext({acceptDownloads:true,viewport:{width:1400,height:900}});
 const page=await context.newPage(),errors=[];
 page.on("pageerror",e=>errors.push(String(e)));
 await page.goto(origin);
 await page.locator('input[name="username"]').fill("admin");
 await page.locator('input[name="password"]').fill("123456");
 await page.locator("#lbtn").click();
 await page.locator(".ux-kpi-grid").waitFor({timeout:15000});
 await page.goto(origin+"/#/projects/MP-2026-015");
 const open=page.locator("#downloadArchivePdf");await open.waitFor({timeout:15000});
 assert.match(await open.innerText(),/材料下载/);
 await open.click();
 const modal=page.locator("#modal.open");
 await modal.locator('input[name="material_category"]').first().waitFor({timeout:15000});
 assert.equal(await modal.locator('input[name="material_category"]:not([disabled])').count()>=2,true);
 const names=await modal.locator('input[name="material_category"]').evaluateAll(xs=>xs.map(x=>x.value));
 assert.ok(names.includes("签到表")&&names.includes("终版议程"));
 const mode=modal.locator('select[name="watermark_mode"]');
 await mode.selectOption("custom");
 await modal.locator('input[name="watermark_text"]').fill("内部档案测试水印");
 await modal.locator("[data-clear-all]").click();
 assert.equal(await modal.locator('input[name="material_category"]:checked').count(),0);
 await modal.locator('input[name="material_category"][value="签到表"]').check();
 const event=page.waitForEvent("download",{timeout:60000});
 await modal.locator("[data-export]").click();
 const file=await event;
 assert.match(file.suggestedFilename(),/\.pdf$/i);
 const bytes=fs.readFileSync(await file.path());
 const doc=await PDFDocument.load(bytes);
 assert.equal(doc.getPageCount(),2,"cover plus selected original");
 assert.match(doc.getKeywords()||"",/watermark:custom/);
 await page.goto(origin+"/#/archive");
 const archiveButton=page.locator('[data-archive-pdf="MP-2026-015"]').first();
 await archiveButton.waitFor({timeout:15000});
 await archiveButton.click();
 await page.locator("#modal.open select[name=watermark_mode]").selectOption("none");
 await page.locator("#modal.open [data-cancel]").click();
 assert.equal(await page.locator("#modal.open").count(),0);
 await context.close();
 const assocContext=await browser.newContext({acceptDownloads:true});
 const assoc=await assocContext.newPage();
 await assoc.goto(origin);
 await assoc.locator('input[name="username"]').fill("assoc");
 await assoc.locator('input[name="password"]').fill("123456");
 await assoc.locator("#lbtn").click();
 await assoc.locator(".ux-kpi-grid").waitFor({timeout:15000});
 await assoc.goto(origin+"/#/projects/MP-2026-015");
 await assoc.locator("#downloadArchivePdf").click();
 assert.equal(await assoc.locator('#modal.open select[name="watermark_mode"]').count(),0,
  "non-super admin cannot choose watermark mode");
 assert.equal(errors.length,0,errors.join("\n"));
 console.log("PASS: category selection, custom watermark download, archive entry, ordinary watermark policy");
 await assocContext.close();
}
run().catch(e=>{console.error(e);process.exitCode=1}).finally(async()=>{
 try{await browser?.close();}finally{database?.close();proc?.kill("SIGTERM");fs.rmSync(dir,{recursive:true,force:true});}
});
