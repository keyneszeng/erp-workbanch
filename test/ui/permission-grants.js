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

 // The shared association picker must select the current active directory,
 // allow manual exceptions and never save merely by clicking Select All.
 await page.locator("#newU").click();
 const createModal=page.locator("#modal.open");
 const choices=createModal.locator("[data-assoc-pick]");
 const totalAssocs=await choices.count();
 assert.ok(totalAssocs>1);
 await createModal.locator("[data-assoc-select-all]").click();
 assert.equal(await createModal.locator("[data-assoc-pick]:checked").count(),totalAssocs);
 assert.equal(await createModal.locator("[data-assoc-select-all]").isDisabled(),true);
 await choices.first().uncheck();
 assert.equal(await createModal.locator("[data-assoc-pick]:checked").count(),totalAssocs-1);
 assert.equal(await createModal.locator("[data-assoc-select-all]").isEnabled(),true);
 await createModal.locator('[data-x="0"]').click();
 const user=page.locator('tr').filter({hasText:"刘洋"});
 await user.locator("[data-edit]").click();
 const editModal=page.locator("#modal.open");
 const before=await editModal.locator("[data-assoc-pick]:checked").count();
 if(before<totalAssocs)await editModal.locator("[data-assoc-select-all]").click();
 assert.equal(await editModal.locator("[data-assoc-pick]:checked").count(),totalAssocs);
 await editModal.locator('[data-x="0"]').click();
 await user.locator("[data-edit]").click();
 assert.equal(await page.locator("#modal.open [data-assoc-pick]:checked").count(),before,"取消不应修改协会授权");
 await page.locator('#modal.open [data-x="0"]').click();
 const edit=user.locator("[data-user-access]");
 await edit.click();
 const modal=page.locator("#modal.open");
 await modal.locator('input[data-grant="module"]').first().waitFor({timeout:10000});
 const rights=modal.locator('input[data-grant="permission"]');
 assert.ok(await rights.count()>=23);
 assert.equal(await modal.locator('input[data-grant="module"][value="system"]').count(),0);
 assert.equal(await modal.locator('input[data-grant="permission"][value="user:manage"]').count(),0);
 assert.equal(await modal.locator('input[data-grant="permission"][value="setting:write"]').count(),0);
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
 // Even a genuine business-permission holder must not access system pages.
 const memberContext=await browser.newContext({viewport:{width:1100,height:860}});
 const memberPage=await memberContext.newPage();
 memberPage.on("pageerror",e=>jsErrors.push(String(e)));
 await memberPage.goto(origin);
 await memberPage.locator('input[name="username"]').fill("guest");
 await memberPage.locator('input[name="password"]').fill("123456");
 await memberPage.locator("#lbtn").click();
 await memberPage.locator("#nav").waitFor({timeout:15000});
 assert.doesNotMatch(await memberPage.locator("#nav").innerText(),/系统配置|用户与权限|邀请函上线配置/);
 await memberPage.goto(origin+"/#/users");
 await memberPage.waitForURL(/#\/dashboard$/, {timeout:15000});
 assert.doesNotMatch(await memberPage.locator("#content").innerText(),/账号列表|分配权限/);
 await memberContext.close();

 // 零权限账号应仅有可进入的“我的工作台”，不再展示点击后被弹回的总览。
 const created=await page.evaluate(async()=>{
  const response=await fetch("/api/users",{method:"POST",headers:{"content-type":"application/json"},
   body:JSON.stringify({username:"qa_nogrants",name:"零权限浏览器测试",
    role:"user",assoc:"华东医学会",assocs:["华东医学会"],
    dept:"非供应商",phone:"13800009611",password:"NoGrants2026!"})});
  return {status:response.status,payload:await response.json()};
 });
 assert.equal(created.status,200,JSON.stringify(created.payload));
 await page.reload();
 const freshUser=page.locator("tr").filter({hasText:"零权限浏览器测试"});
 await freshUser.locator("[data-edit]").click();
 const assocModal=page.locator("#modal.open");
 await assocModal.locator("[data-assoc-select-all]").click();
 await assocModal.locator('[data-x="1"]').click();
 await assocModal.waitFor({state:"hidden",timeout:15000});
 const saved=await page.evaluate(async()=>{
   const users=await (await fetch("/api/users")).json();
   const directory=await (await fetch("/api/associations")).json();
   return {assigned:users.rows.find(x=>x.username==="qa_nogrants").assocs,active:directory.rows};
 });
 assert.deepEqual(saved.assigned.slice().sort(),saved.active.slice().sort());
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
 // 项目模块只读不意味着能浏览财务明细，页面不应显示NaN/无权页签。
 const projectReader=await page.evaluate(async()=>{
  const r=await fetch("/api/users",{method:"POST",headers:{"content-type":"application/json"},
   body:JSON.stringify({username:"qa_projectread",name:"项目模块只读",
     role:"finance",assoc:"华东医学会",assocs:["华东医学会"],
     dept:"财务部",phone:"13800009613",password:"ProjectReader2026!"})});
  return {status:r.status,payload:await r.json()};
 });
 assert.equal(projectReader.status,200,JSON.stringify(projectReader.payload));
 const granting=await page.evaluate(async userId=>{
  const r=await fetch("/api/users/"+userId+"/access",{method:"PATCH",headers:{"content-type":"application/json"},
    body:JSON.stringify({modules:["projects"],permissions:[]})});
  return {status:r.status,payload:await r.json()};
 },projectReader.payload.user.id);
 assert.equal(granting.status,200,JSON.stringify(granting.payload));
 const readerContext=await browser.newContext({viewport:{width:1280,height:900}});
 const readerPage=await readerContext.newPage();
 readerPage.on("pageerror",e=>jsErrors.push(String(e)));
 await readerPage.goto(origin);
 await readerPage.locator('input[name="username"]').fill("qa_projectread");
 await readerPage.locator('input[name="password"]').fill("ProjectReader2026!");
 await readerPage.locator("#lbtn").click();
 await readerPage.goto(origin+"/#/projects");
 await readerPage.locator("#list tr[data-pid]").first().waitFor({timeout:15000});
 assert.match(await readerPage.locator("#sum").innerText(),/仅显示授权范围内的会议/);
 assert.doesNotMatch(await readerPage.locator("#content").innerText(),/NaN/);
 await readerPage.locator("#list tr[data-pid]").first().click();
 await readerPage.locator("#tabbody").waitFor({timeout:15000});
 assert.equal(await readerPage.locator(".tabs button").count(),1,"只读会议只能看到会议概览");
 assert.doesNotMatch(await readerPage.locator("#content").innerText(),/NaN/);
 await readerContext.close();
 assert.deepEqual(jsErrors,[]);
 console.log("PASS: superadmin can select, revoke and persist per-account modules and actions");
 await context.close();
}
run().catch(e=>{console.error(e);process.exitCode=1}).finally(async()=>{
 await browser?.close();proc?.kill("SIGTERM");fs.rmSync(dir,{recursive:true,force:true});
});
