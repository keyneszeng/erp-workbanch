"use strict";
const {chromium}=require("playwright");
const {spawn}=require("node:child_process");
const assert=require("node:assert/strict");
const fs=require("node:fs"),os=require("node:os"),path=require("node:path");
const dir=fs.mkdtempSync(path.join(os.tmpdir(),"erp-access-ui-"));
const port=8990,origin="http://127.0.0.1:"+port;
let proc,browser;
async function run(){
 proc=spawn(process.execPath,["--experimental-sqlite","server/index.js"],{
  cwd:path.resolve(__dirname,"../.."),
  env:{...process.env,ERP_DEMO_MODE:"1",ERP_PORT:String(port),ERP_DB:path.join(dir,"db.sqlite"),ERP_UPLOAD_DIR:path.join(dir,"uploads")},
  stdio:["ignore","pipe","pipe"]});
 let stderr="";proc.stderr.on("data",c=>stderr+=String(c));
 let ok=false;
 for(let i=0;i<200;i++){
  try{if((await fetch(origin+"/api/health")).ok){ok=true;break;}}catch{}
  if(proc.exitCode!==null)throw Error(stderr);
  await new Promise(r=>setTimeout(r,120));
 }
 assert.ok(ok,"server not ready "+stderr);
 browser=await chromium.launch({channel:"chrome",headless:true});
 const context=await browser.newContext({viewport:{width:1460,height:940}});
 const page=await context.newPage();
 const jsErrors=[];page.on("pageerror",e=>jsErrors.push(String(e)));
 await page.goto(origin);
 await page.locator('input[name="username"]').fill("admin");
 await page.locator('input[name="password"]').fill("123456");
 await page.locator("#lbtn").click();
 await page.goto(origin+"/#/users");
 await page.locator("#newU").waitFor({timeout:20000});
 assert.match(await page.locator("#content").innerText(),/按账号分配权限/);
 const user=page.locator('tr').filter({hasText:"刘洋"});
 const edit=user.locator("[data-user-access]");
 await edit.click();
 const modal=page.locator("#modal.open");
 await modal.locator('input[data-grant="module"]').first().waitFor({timeout:10000});
 const rights=modal.locator('input[data-grant="permission"]');
 assert.ok(await rights.count()>=25);
 await modal.locator('[data-grant-none="permission"]').click();
 assert.equal(await modal.locator('input[data-grant="permission"]:checked').count(),0);
 await modal.locator('[data-grant-none="module"]').click();
 await modal.locator('input[data-grant="module"][value="dashboard"]').check();
 await modal.locator('input[data-grant="module"][value="materials"]').check();
 await modal.locator('input[data-grant="permission"][value="material:write"]').check();
 await modal.locator('[data-x="1"]').click();
 await page.locator("#modal.open").waitFor({state:"hidden",timeout:15000});
 await user.locator("[data-user-access]").click();
 const reopen=page.locator("#modal.open");
 assert.equal(await reopen.locator('input[data-grant="permission"][value="material:write"]').isChecked(),true);
 assert.equal(await reopen.locator('input[data-grant="module"][value="materials"]').isChecked(),true);
 await reopen.locator('[data-x="0"]').click();
 // 零权限账号应仅有可进入的“我的工作台”，不再展示点击后被弹回的总览。
 const created=await page.evaluate(async()=>{
  const response=await fetch("/api/users",{method:"POST",headers:{"content-type":"application/json"},
   body:JSON.stringify({username:"qa_nogrants",name:"零权限浏览器测试",
    role:"user",assoc:"华东医学会",assocs:["华东医学会"],
    dept:"非供应商",phone:"13800009611",password:"NoGrants2026!"})});
  return {status:response.status,payload:await response.json()};
 });
 assert.equal(created.status,200,JSON.stringify(created.payload));
 const anonymous=await browser.newContext({viewport:{width:1100,height:860}});
 const limitedPage=await anonymous.newPage();
 limitedPage.on("pageerror",e=>jsErrors.push(String(e)));
 await limitedPage.goto(origin);
 await limitedPage.locator('input[name="username"]').fill("qa_nogrants");
 await limitedPage.locator('input[name="password"]').fill("NoGrants2026!");
 await limitedPage.locator("#lbtn").click();
 await limitedPage.locator("#content").getByText("账号尚未获得功能授权").waitFor({timeout:15000});
 const navText=await limitedPage.locator("#nav").innerText();
 assert.match(navText,/我的工作台/);
 assert.doesNotMatch(navText,/全流程总览|项目管理|财务结算|系统配置/);
 await anonymous.close();
 assert.deepEqual(jsErrors,[]);
 console.log("PASS: superadmin can select, revoke and persist per-account modules and actions");
 await context.close();
}
run().catch(e=>{console.error(e);process.exitCode=1}).finally(async()=>{
 await browser?.close();proc?.kill("SIGTERM");fs.rmSync(dir,{recursive:true,force:true});
});
