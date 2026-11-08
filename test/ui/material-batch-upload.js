"use strict";
/**
 * Real Chrome test: Project > archived materials > register materials.
 * Parallel upload, original filename -> registered record, status list,
 * no manual material-name input, and retry without duplicate records.
 */
const assert=require("node:assert/strict");
const {chromium}=require("playwright");
const {spawn}=require("node:child_process");
const fs=require("node:fs"),os=require("node:os"),path=require("node:path");
const dir=fs.mkdtempSync(path.join(os.tmpdir(),"erp-material-batch-"));
const port=14980+(process.pid%200);
const origin="http://127.0.0.1:"+port;
const makePdf=name=>({
  name,mimeType:"application/pdf",
  buffer:Buffer.from("%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n% "+name)
});
let server,browser;
async function ready(){
  let stderr="";
  server.stderr.on("data",b=>stderr+=String(b));
  for(let i=0;i<220;i++){
    if(server.exitCode!==null)throw Error("ERP failed: "+stderr);
    try{if((await fetch(origin+"/api/health")).ok)return;}catch{}
    await new Promise(r=>setTimeout(r,100));
  }
  throw Error("ERP startup timed out: "+stderr);
}
(async()=>{
  server=spawn(process.execPath,["--experimental-sqlite","server/index.js"],{
    cwd:path.resolve(__dirname,"../.."),
    env:{...process.env,ERP_DEMO_MODE:"1",ERP_HOST:"127.0.0.1",ERP_PORT:String(port),
      ERP_DB:path.join(dir,"db.sqlite"),ERP_UPLOAD_DIR:path.join(dir,"files")},
    stdio:["ignore","pipe","pipe"]
  });
  await ready();
  browser=await chromium.launch({channel:"chrome",headless:true});
  const page=await browser.newPage({viewport:{width:1440,height:940}});
  const jsErrors=[];page.on("pageerror",e=>jsErrors.push(e.message));
  await page.goto(origin);
  await page.locator('input[name="username"]').fill("admin");
  await page.locator('input[name="password"]').fill("123456");
  await page.locator("#lbtn").click();
  await page.locator("#nav").waitFor({timeout:12000});
  const projects=await (await page.request.get(origin+"/api/projects")).json();
  const project=projects.rows.find(p=>p.id==="MP-2026-001")||
    projects.rows.find(p=>!["已结算","已归档"].includes(p.status));
  assert.ok(project,"need writable seeded meeting project");
  const pid=project.id;
  await page.goto(origin+"/#/projects/"+encodeURIComponent(pid),{waitUntil:"domcontentloaded"});
  await page.locator('.tabs [data-tab="materials"]').click();
  const add=page.locator("#addMat");
  await add.waitFor({timeout:15000});
  await add.click();
  const modal=page.locator("#modal.open");
  assert.equal(await modal.locator('[name="name"]').count(),0,
    "manual material-name input must be removed");
  assert.equal(await modal.locator('[name="version"]').count(),0);
  await modal.locator('[name="kind"]').selectOption("课件");
  const picker=modal.locator('input[name="file"]');
  assert.notEqual(await picker.getAttribute("multiple"),null,
    "default material kind allows multi-file selection");
  const names=["第一场讲座.pdf","第二场讲座.pdf","第三场讲座.pdf"];
  const fixtures=names.map(makePdf);
  await picker.setInputFiles(fixtures);
  assert.deepEqual(await modal.locator("[data-material-name]").allTextContents(),names,
    "selected file list shows exact material names, in original order");
  assert.match(await modal.locator("[data-material-batch-status]").innerText(),/3 份文件已选择/);
  let inflight=0,peak=0,uploads=0;
  const parallel=async route=>{
    inflight++;peak=Math.max(inflight,peak);uploads++;
    await new Promise(resolve=>setTimeout(resolve,220));
    try{await route.continue();}finally{inflight--;}
  };
  await page.route("**/api/uploads?pid=*",parallel);
  await modal.locator('[data-x="1"]').click();
  await modal.waitFor({state:"hidden",timeout:25000});
  await page.unroute("**/api/uploads?pid=*",parallel);
  assert.equal(uploads,3,"each selected file is uploaded once");
  assert.ok(peak>=2,"multiple files must upload simultaneously, peak="+peak);
  let list=await (await page.request.get(origin+"/api/materials")).json();
  const all=names.map(name=>list.rows.find(x=>x.pid===pid&&x.name===name&&x.file_name===name));
  assert.ok(all.every(Boolean),"each file should create its own material row with original filename");
  assert.equal(new Set(all.map(x=>x.file_key)).size,3);
  for(let i=0;i<fixtures.length;i++){
    const got=await page.request.get(origin+"/api/uploads/"+all[i].file_key);
    assert.equal(got.status(),200,"downloadable "+names[i]);
    assert.ok(Buffer.from(await got.body()).equals(fixtures[i].buffer),"original bytes retained "+names[i]);
  }
  for(const name of names)
    assert.ok((await page.locator("#content").innerText()).includes(name),"meeting materials list displays "+name);

  // Same dialog from Material Center; fail one upload then retry only that item.
  await page.goto(origin+"/#/materials",{waitUntil:"domcontentloaded"});
  await page.locator("#add").click();
  const second=page.locator("#modal.open");
  await second.locator('[name="pid"]').selectOption(pid);
  await second.locator('[name="kind"]').selectOption("劳务收集表");
  const nextNames=["报名资料A.pdf","报名资料B.pdf"];
  await second.locator('[name="file"]').setInputFiles(nextNames.map(makePdf));
  let failOnce=false,attempts=0;
  const flaky=async route=>{
    attempts++;
    const encoded=route.request().headers()["x-file-name"]||"";
    if(!failOnce&&decodeURIComponent(encoded)==="报名资料B.pdf"){
      failOnce=true;
      await route.abort("failed");
    }else await route.continue();
  };
  await page.route("**/api/uploads?pid=*",flaky);
  await second.locator('[data-x="1"]').click();
  await page.waitForFunction(()=>document.querySelector("#modal.open [data-material-batch-status]")?.textContent?.includes("成功登记 1 份，失败 1 份"),null,{timeout:20000});
  assert.equal(await second.locator('[data-material-name]').count(),2);
  assert.match(await second.locator('[data-material-status]').nth(1).innerText(),/失败/);
  await second.locator('[data-x="1"]').click();
  await second.waitFor({state:"hidden",timeout:20000});
  await page.unroute("**/api/uploads?pid=*",flaky);
  assert.equal(attempts,3,"retry uploads only the failed item");
  list=await (await page.request.get(origin+"/api/materials")).json();
  for(const name of nextNames){
    const matching=list.rows.filter(x=>x.pid===pid&&x.name===name&&x.file_name===name);
    assert.equal(matching.length,1,"retry should not duplicate successful material "+name);
  }
  // Delete through the SAME project archive page that used to display soft-deleted
  // rows. Confirm immediate removal, API filtering, and persistence after reload.
  await page.goto(origin+"/#/projects/"+encodeURIComponent(pid),{waitUntil:"domcontentloaded"});
  await page.locator('.tabs [data-tab="materials"]').click();
  await page.locator('[data-del-mat="'+all[0].id+'"]').click();
  await page.locator('#modal.open [data-x="1"]').click();
  await page.waitForFunction(name=>!document.querySelector("#content")?.innerText.includes(name),names[0],{timeout:15000});
  const detail=await (await page.request.get(origin+"/api/projects/"+encodeURIComponent(pid))).json();
  assert.ok(!detail.materials.some(m=>Number(m.id)===Number(all[0].id)),
    "deleted material excluded from project detail API");
  assert.ok(detail.materials.some(m=>Number(m.id)===Number(all[1].id)),
    "other materials remain present");
  await page.reload({waitUntil:"domcontentloaded"});
  await page.locator('.tabs [data-tab="materials"]').click();
  assert.ok(!(await page.locator("#content").innerText()).includes(names[0]),
    "deleted material must not return after project page reload");
  assert.ok((await page.locator("#content").innerText()).includes(names[1]),
    "non-deleted material still visible");
  list=await (await page.request.get(origin+"/api/materials")).json();
  assert.ok(!list.rows.some(m=>Number(m.id)===Number(all[0].id)));
  assert.deepEqual(jsErrors,[]);
  console.log("PASS: real Chrome batch uploads, original names, retry, and soft-deleted archive item disappears immediately and after reload");
})().then(async()=>{
  await browser?.close();server?.kill("SIGTERM");
  fs.rmSync(dir,{recursive:true,force:true});
}).catch(async e=>{
  console.error(e);await browser?.close().catch(()=>{});server?.kill("SIGTERM");
  fs.rmSync(dir,{recursive:true,force:true});process.exitCode=1;
});
