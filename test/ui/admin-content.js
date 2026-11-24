"use strict";
/** Real Chrome: superadmin edits archived data and inspects history; regular accounts have no access. */
const assert=require("node:assert/strict");
const {chromium}=require("playwright");
const {spawn}=require("node:child_process");
const fs=require("node:fs"),os=require("node:os"),path=require("node:path");
const dir=fs.mkdtempSync(path.join(os.tmpdir(),"erp-admin-content-ui-"));
const port=8998,origin="http://127.0.0.1:"+port;
let proc,browser;
(async()=>{
 proc=spawn(process.execPath,["--experimental-sqlite","server/index.js"],{
  cwd:path.resolve(__dirname,"../.."),env:{...process.env,ERP_DEMO_MODE:"1",
   ERP_PORT:String(port),ERP_DB:path.join(dir,"db.sqlite"),
   ERP_UPLOAD_DIR:path.join(dir,"uploads")},stdio:["ignore","pipe","pipe"]});
 let err="";proc.stderr.on("data",b=>err+=String(b));
 let ready=false;
 for(let i=0;i<250;i++){
  try{if((await fetch(origin+"/api/health")).ok){ready=true;break;}}catch{}
  await new Promise(resolve=>setTimeout(resolve,110));
 }
 assert.ok(ready,"demo server not ready "+err);
 browser=await chromium.launch({channel:"chrome",headless:true});
 const page=await browser.newPage({viewport:{width:1440,height:900}});
 const errors=[];page.on("pageerror",e=>errors.push(e.message));
 await page.goto(origin);
 await page.locator('input[name="username"]').fill("admin");
 await page.locator('input[name="password"]').fill("123456");
 await page.locator("#lbtn").click();
 await page.locator(".ux-kpi-grid").waitFor({timeout:15000});
 assert.equal(await page.locator('#nav [data-go="admin-content"]').count(),1,
  "superadmin must see content correction navigation");
 await page.goto(origin+"/#/admin-content");
 await page.locator("#admin-content-search").waitFor({timeout:15000});
 assert.ok((await page.locator("#content").innerText()).includes("全部")||
  (await page.locator("#content").innerText()).includes("内容修订"));
 const pid="MP-2026-015";
 const entry=page.locator('#content [data-go="admin-content/'+pid+'"]');
 await entry.waitFor({timeout:15000});
 await entry.click();
 await page.locator("#admin-content-type").waitFor({timeout:15000});
 const categories=await page.locator("#admin-content-type option").count();
 assert.ok(categories>=18,"every business domain must be reachable");
 const edit=page.locator('[data-admin-edit="'+pid+'"]');
 await edit.waitFor({timeout:10000});
 await edit.click();
 const m=page.locator("#modal.open");
 await m.locator('input[name="name"]').waitFor({timeout:10000});
 const old=await m.locator('input[name="name"]').inputValue(),updated=old+"（修改权限测试）";
 await m.locator('input[name="name"]').fill(updated);
 await m.locator('[name="admin_reason"]').fill("核对原始文件后更正项目标题，确认总管理员可在归档后编辑");
 await m.locator('[data-x="1"]').click();
 const confirm=page.locator("#modal.open");
 await confirm.getByText("确认修订",{exact:true}).click();
 await page.locator("#admin-content-type").waitFor({timeout:15000});
 const record=page.locator('[data-admin-history="'+pid+'"]');
 await record.waitFor({timeout:15000});
 await record.click();
 await page.getByText("内容修订历史 · "+pid).waitFor({timeout:15000});
 assert.match(await page.locator("#modal.open").innerText(),/修改权限测试/);
 await page.locator("#modal.open [data-x='0']").click();
 const project=await (await page.request.get(origin+"/api/projects/"+pid)).json();
 assert.equal(project.project.name,updated);
 const normal=await browser.newPage();
 await normal.goto(origin);
 await normal.locator('input[name="username"]').fill("exec");
 await normal.locator('input[name="password"]').fill("123456");
 await normal.locator("#lbtn").click();
 await normal.locator(".ux-kpi-grid").waitFor({timeout:15000});
 assert.equal(await normal.locator('#nav [data-go="admin-content"]').count(),0);
 await normal.goto(origin+"/#/admin-content");
 await normal.waitForURL(origin+"/#/dashboard",{timeout:15000});
 assert.equal((await normal.request.get(origin+"/api/admin/content/types")).status(),403);
 assert.deepEqual(errors,[],"superadmin UI should not throw JS errors");
 await normal.close();
 console.log("PASS: superadmin content editor, archived project correction, audit history and ordinary-user isolation");
})().catch(e=>{console.error(e);process.exitCode=1}).finally(async()=>{
 try{await browser?.close();}finally{proc?.kill("SIGTERM");fs.rmSync(dir,{recursive:true,force:true});}
});
