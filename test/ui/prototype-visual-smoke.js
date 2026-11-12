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
  assert.ok((await page.locator("body").innerText()).includes("我的待办"),
    "my workbench must retain the to-do panel");
  await page.goto(origin+"/#/flow");
  await page.locator(".flowwrap").waitFor({timeout:12000});
  assert.equal(await page.locator(".ux-metric, .grid.g4 .kpi").count(),0,
    "flow overview should not duplicate dashboard KPIs");
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
  await page.locator("#add").waitFor({timeout:12000});
  assert.equal(await page.locator("#materialWorkbench").count(),0,
    "deprecated final-agenda module and task panel must be removed");
  assert.doesNotMatch(await page.locator("body").innerText(),
    /终版议程\s*[·•]\s*材料模块与待办|从终版议程生成待办/,
    "final agenda must not require a separate speaker/topic task wizard");
  assert.ok((await page.locator("body").innerText()).includes("项目材料上传情况"),
    "material center should show flexible upload status instead of 8/8 mandatory categories");
  await page.locator("#add").click();
  assert.equal(await page.locator('#modal [name="version"]').count(),0,
    "登记材料表单应彻底移除版本输入框");
  const sizeBoundary=await page.evaluate(async()=>{
    const {MAX_UPLOAD_BYTES,checkFile}=await import("/assets/js/lib/upload.js");
    return {max:MAX_UPLOAD_BYTES,exact:checkFile({name:"large.pdf",size:50*1024*1024}),
      over:checkFile({name:"large.pdf",size:50*1024*1024+1})};
  });
  assert.equal(sizeBoundary.max,50*1024*1024);
  assert.equal(sizeBoundary.exact,null,"前端必须允许单文件恰好 50MB");
  assert.match(sizeBoundary.over,/50(?:\.0)? MB/,"超出 50MB 须明确拦截并提示上限");
  const options=await page.locator('#modal [name="kind"] option').allTextContents();
  assert.ok(options.some(x=>x.includes("权益照片")),"rights photos must be available in material category options");
  assert.ok(options.some(x=>x.includes("终版议程")),"final agenda must be a material registration category");
  assert.doesNotMatch((await page.locator("#modal").innerText()),/必备.?8|8.?类.*必备/,
    "material form must not claim eight categories are mandatory");
  await page.locator('#modal [name="kind"]').selectOption("终版议程");
  assert.equal(await page.locator('#modal [name="name"]').isVisible(),false,
    "final agenda needs no manually typed material name");
  assert.equal(await page.locator('#modal [name="version"]').isVisible(),false,
    "final agenda version must be set automatically");
  const finalUpload=page.locator('#modal input[type="file"]');
  assert.equal(await finalUpload.getAttribute("multiple"),null,
    "final agenda should accept exactly one original per confirmation");
  await page.locator('#modal [data-x="1"]').click();
  assert.equal(await page.locator("#modal.open").count(),1,
    "cannot confirm a final agenda without uploading a file");
  const chosenPid=await page.locator('#modal [name="pid"]').inputValue();
  const finalPdf=Buffer.from("%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF\n");
  await finalUpload.setInputFiles({name:"会议终版议程.pdf",mimeType:"application/pdf",buffer:finalPdf});
  await page.locator('#modal [data-x="1"]').click();
  await page.waitForFunction(()=>!document.querySelector("#modal.open"),null,{timeout:15000});
  const finalMaterialsResponse=await page.request.get(origin+"/api/materials");
  assert.equal(finalMaterialsResponse.status(),200);
  const finalMaterials=await finalMaterialsResponse.json();
  const finalRow=finalMaterials.rows.find(m=>m.pid===chosenPid&&m.kind==="终版议程"
    &&m.file_name==="会议终版议程.pdf");
  assert.ok(finalRow?.file_key,"uploaded final agenda should be available in materials");
  assert.equal(finalRow.version,"终版","upload automatically confirms final version");
  await page.goto(origin+"/#/finance");
  await page.locator(".ux-finance-tabs").waitFor({timeout:12000});
  await page.locator('[data-finance-jump="fin-settlements"]').click();
  assert.equal(await page.locator(".ux-finance-tab.active").count(),1);

  // Regression: a plain quoted HTML string previously displayed the raw
  // ${state.demo ? "新建账号" : "录入手机号"} expression as garbled button text.
  await page.goto(origin+"/#/users");
  const createAccount=page.locator("#newU");
  await createAccount.waitFor({timeout:12000});
  assert.equal((await createAccount.innerText()).trim(),"+ 新建账号",
    "super-admin new-account action should display Chinese text, never template source");
  assert.ok(!(await page.locator("#content").innerText()).includes("${state.demo"),
    "do not expose raw JavaScript interpolation in user/permissions UI");
  await createAccount.click();
  const createModal=page.locator("#modal.open");
  await createModal.waitFor({timeout:12000});
  assert.equal((await createModal.locator(".mh h3").innerText()).trim(),"新建账号",
    "button must open the correct create-account dialog");
  for(const field of ["username","name","role","dept","phone","password"]){
    assert.equal(await createModal.locator('[name="'+field+'"]').count(),1,
      "required account field missing: "+field);
  }
  assert.ok(await createModal.locator('[data-assoc-pick]').count()>0, 'association choices must be selectable');
  await createModal.locator('[data-x="0"]').click();
  assert.equal(await page.locator("#modal.open").count(),0,"cancel must close the modal");
  assert.equal(errors.length,0,"page errors: "+errors.join(" / "));
  console.log("Browser B1/B3/B4/B5 visual smoke PASSED");
 }finally{
  if(browser)await browser.close();
  child.kill("SIGTERM");
  fs.rmSync(dir,{recursive:true,force:true});
 }
})().catch(e=>{console.error(e);process.exitCode=1;});
