"use strict";
/**
 * Isolated Chrome black-box audit: five seeded roles, every available sidebar
 * route, project detail tabs, modal actions, filtered lists, exports and guards.
 * Never runs against production or a shared database.
 */
const {spawn}=require("node:child_process");
const {mkdtempSync,rmSync}=require("node:fs");
const {tmpdir}=require("node:os");
const path=require("node:path");
const assert=require("node:assert/strict");
const root=path.resolve(__dirname,"../..");
const dir=mkdtempSync(path.join(tmpdir(),"erp-role-blackbox-"));
const port=15500+(process.pid%900);
const origin="http://127.0.0.1:"+port;
const env={...process.env,ERP_DEMO_MODE:"1",ERP_DB:path.join(dir,"demo.sqlite"),
  ERP_UPLOAD_DIR:path.join(dir,"uploads"),ERP_HOST:"127.0.0.1",ERP_PORT:String(port),
  ERP_BASE:origin,ERP_QA_TARGET:"isolated-local"};
let server=null,child=null;
function launch(cmd,args,opts={}){
 return new Promise((resolve,reject)=>{
  const p=spawn(cmd,args,{cwd:root,env,stdio:["ignore","pipe","pipe"],...opts});
  p.stdout.on("data",b=>process.stdout.write(b));
  p.stderr.on("data",b=>process.stderr.write(b));
  p.on("error",reject);
  p.on("exit",(code,signal)=>resolve({code,signal}));
 });
}
(async()=>{
 try{
  server=spawn(process.execPath,["--experimental-sqlite","server/index.js"],{
   cwd:root,env,stdio:["ignore","pipe","pipe"]
  });
  let stderr="";server.stderr.on("data",b=>stderr+=String(b));
  const deadline=Date.now()+24000;let up=false;
  while(Date.now()<deadline){
   if(server.exitCode!==null)throw Error("blackbox demo crashed: "+stderr);
   try{const response=await fetch(origin+"/api/health");if(response.ok){up=true;break;}}catch{}
   await new Promise(r=>setTimeout(r,125));
  }
  assert.ok(up,"isolated seeded demo unavailable: "+stderr);
  const run=await launch(process.execPath,["test/ui/live-role-coverage.js"]);
  assert.equal(run.code,0,"五角色浏览器黑盒巡检失败，检查 role-button-coverage.json");
  console.log("PASS: five-role black-box route, action and authorization inventory");
 }finally{
  if(server){server.kill("SIGTERM");await new Promise(r=>setTimeout(r,500));}
  rmSync(dir,{recursive:true,force:true});
 }
})().catch(e=>{console.error("ROLE_BUTTON_BLACKBOX_FAIL",e);process.exitCode=1;});
