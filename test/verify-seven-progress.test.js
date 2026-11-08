"use strict";
/** Seven-step progress displayed by both project lists must match project-detail verification. */
const {test}=require("node:test");
const assert=require("node:assert/strict");
const {spawn}=require("node:child_process");
const {DatabaseSync}=require("node:sqlite");
const fs=require("node:fs"),os=require("node:os"),path=require("node:path");
test("项目列表、分页列表、核销看板按前4项必核和5/6/7条件计数，并保留7条步骤",async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),"erp-seven-step-"));
 const port=15500+(process.pid%190),origin="http://127.0.0.1:"+port;
 const dbFile=path.join(dir,"erp.db");
 let proc,db;
 try{
  proc=spawn(process.execPath,["--experimental-sqlite","server/index.js"],{
   cwd:path.resolve(__dirname,".."),
   env:{...process.env,ERP_DEMO_MODE:"1",ERP_PORT:String(port),ERP_HOST:"127.0.0.1",ERP_DB:dbFile,
    ERP_UPLOAD_DIR:path.join(dir,"uploads")},stdio:["ignore","pipe","pipe"]
  });
  let errors="";proc.stderr.on("data",chunk=>errors+=String(chunk));
  let ready=false;
  for(let i=0;i<200;i++){
   if(proc.exitCode!==null)throw Error(errors);
   try{if((await fetch(origin+"/api/health")).ok){ready=true;break;}}catch{}
   await new Promise(resolve=>setTimeout(resolve,100));
  }
  assert.ok(ready,"ERP demo server unavailable");
  const auth=await fetch(origin+"/api/auth/login",{method:"POST",headers:{"content-type":"application/json"},
   body:JSON.stringify({username:"admin",password:"123456"})});
  assert.equal(auth.status,200);
  const cookie=(auth.headers.get("set-cookie")||"").split(";")[0];
  const get=async url=>{
   const res=await fetch(origin+url,{headers:{cookie}});
   assert.equal(res.status,200,url+": "+await res.clone().text());
   return res.json();
  };
  const list=async paged=>paged?
   (await get("/api/projects?page=1&size=100")).rows:(await get("/api/projects")).rows;
  const initial=await list(false),paged=await list(true);
  assert.ok(initial.length,"seeded projects should exist");
  for(const p of initial){
   const detail=(await get("/api/projects/"+p.id+"/verify")).verification;
   assert.equal(detail.steps.length,7,"every project has all seven steps");
   assert.equal(Number(p.v_total),detail.total,"unpaged required count for "+p.id);
   assert.equal(Number(p.v_passed),detail.passed,"unpaged passed count for "+p.id);
   const onPage=paged.find(x=>x.id===p.id);
   if(onPage){
    assert.equal(Number(onPage.v_total),detail.total,"paged required count for "+p.id);
    assert.equal(Number(onPage.v_passed),detail.passed,"paged passed count for "+p.id);
   }
  }
  const target=initial.find(p=>Number(p.v_total)===4);
  assert.ok(target,"need a seeded project with only steps 1-4 applicable");
  db=new DatabaseSync(dbFile);db.exec("PRAGMA busy_timeout=5000");
  const pid=target.id,now="2026-11-08 16:00";
  const check=async expected=>{
   const current=(await list(false)).find(x=>x.id===pid);
   assert.equal(current.v_total,expected,"project list conditional denominator");
   const detail=(await get("/api/projects/"+pid+"/verify")).verification;
   assert.equal(detail.total,expected,"project detail conditional denominator");
   assert.equal(detail.steps.length,7,"all seven steps remain visible even when not applicable");
   const onPage=(await list(true)).find(x=>x.id===pid);
   if(onPage)assert.equal(onPage.v_total,expected,"paged denominator");
  };
  await check(4);
  const labor=db.prepare("INSERT INTO materials(pid,kind,name,file_name,version,file_key,created_at) VALUES (?,?,?,?,?,?,?)")
   .run(pid,"劳务登记表","劳务名单.xlsx","劳务名单.xlsx","v1","labor-seven.xlsx",now);
  await check(5);
  db.prepare("INSERT INTO demand_sheets(pid,confirmed,created_at,updated_at) VALUES (?,0,?,?)").run(pid,now,now);
  await check(6);
  const rightsPhoto=db.prepare("INSERT INTO materials(pid,kind,name,file_name,version,file_key,created_at) VALUES (?,?,?,?,?,?,?)")
   .run(pid,"权益照片","背景板照片.jpg","背景板照片.jpg","v1","sponsor-right-photo.jpg",now);
  await check(7);
  db.prepare("UPDATE materials SET deleted_at=? WHERE id=?").run(now,rightsPhoto.lastInsertRowid);
  await check(6);
  db.prepare("UPDATE materials SET deleted_at=? WHERE id=?").run(now,labor.lastInsertRowid);
  await check(5);
  db.prepare("DELETE FROM demand_sheets WHERE pid=?").run(pid);
  await check(4);
 }finally{
  db?.close();proc?.kill("SIGTERM");fs.rmSync(dir,{recursive:true,force:true});
 }
});
