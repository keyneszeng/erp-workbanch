"use strict";
const {test,before,after}=require("node:test");
const assert=require("node:assert/strict");
const {spawn}=require("node:child_process");
const fs=require("node:fs"),os=require("node:os"),path=require("node:path");
const {DatabaseSync}=require("node:sqlite");
const dir=fs.mkdtempSync(path.join(os.tmpdir(),"erp-public-intake-"));
const dbFile=path.join(dir,"test.sqlite"),port=8949,base="http://127.0.0.1:"+port;
let proc,db,adminCookie,guestCookie;
const sample={
 topic:"2027年度学术交流活动",event_date:"2027-03-14",event_time:"09:30",form:"混合",
 budget:"15000.50",agenda:"09:00 开场\n10:00 专题交流",
 contact_name:"公众联系人",contact_phone:"13800138000",
 contact_info:"contact@example.org",consent:true,website:""
};
async function req(url,method="GET",data,cookie){
 const r=await fetch(base+url,{
  method,headers:{...(data?{"content-type":"application/json"}:{}),...(cookie?{cookie}:{})},
  body:data?JSON.stringify(data):undefined
 });
 return {status:r.status,data:await r.json(),cookie:r.headers.get("set-cookie")?.split(";")[0]};
}
before(async()=>{
 proc=spawn(process.execPath,["--experimental-sqlite","server/index.js"],{
  cwd:path.join(__dirname,".."),
  env:{...process.env,ERP_DEMO_MODE:"1",ERP_PORT:String(port),ERP_DB:dbFile,ERP_PUBLIC_PROPOSALS_ENABLED:"1"},
  stdio:["ignore","pipe","pipe"]
 });
 let stderr="";proc.stderr.on("data",x=>stderr+=String(x));
 let ready=false;
 // 单实例冷启动实测约 6.4s；并行跑整套测试时磁盘/CPU 竞争会把启动推到 9s 以上。
 // 原来只等 90×100ms=9s，并发下必然误报「server did not start」。
 for(let i=0;i<600;i++){
  try{if((await fetch(base+"/api/health")).ok){ready=true;break;}}catch{}
  if(proc.exitCode!==null)break;
  await new Promise(resolve=>setTimeout(resolve,100));
 }
 assert.ok(ready,"server did not start: "+stderr);
 adminCookie=(await req("/api/auth/login","POST",{username:"admin",password:"123456"})).cookie;
 guestCookie=(await req("/api/auth/login","POST",{username:"guest",password:"123456"})).cookie;
 assert.ok(adminCookie&&guestCookie);
 db=new DatabaseSync(dbFile);
});
after(()=>{db?.close();proc?.kill("SIGTERM");fs.rmSync(dir,{force:true,recursive:true});});

test("public submits without login and no internal project or approval is created",async()=>{
 const beforeProjects=db.prepare("SELECT COUNT(*) n FROM projects").get().n;
 const beforeApprovals=db.prepare("SELECT COUNT(*) n FROM approvals").get().n;
 const result=await req("/api/public/event-proposals","POST",sample);
 assert.equal(result.status,200,JSON.stringify(result.data));
 assert.match(result.data.reference,/^PP-[a-f0-9]{24}$/);
 assert.equal(result.data.status,"已接收");
 assert.equal(db.prepare("SELECT COUNT(*) n FROM projects").get().n,beforeProjects);
 assert.equal(db.prepare("SELECT COUNT(*) n FROM approvals").get().n,beforeApprovals);
 const row=db.prepare("SELECT * FROM public_event_proposals WHERE id=?").get(result.data.reference);
 assert.equal(row.topic,sample.topic);
 assert.equal(row.contact_phone,sample.contact_phone);
 assert.equal(row.budget,15000.50);
});
test("admin sees public inbox; guest and anonymous cannot access personal contact data",async()=>{
 assert.equal((await req("/api/admin/public-event-proposals")).status,401);
 assert.equal((await req("/api/admin/public-event-proposals","GET",undefined,guestCookie)).status,403);
 const admin=await req("/api/admin/public-event-proposals","GET",undefined,adminCookie);
 assert.equal(admin.status,200);
 assert.ok(admin.data.rows.some(row=>row.contact_phone===sample.contact_phone));
});
test("public submissions validate required fields, consent and dates, and reject abuse",async()=>{
 for(const invalid of [
  {topic:""},{event_date:"2027-99-99"},{event_date:"2027-02-30"},{event_time:"25:00"},
  {form:"秘密"},{budget:"-1"},{budget:"1.234"},{budget:"1e9"},
  {agenda:""},{contact_phone:"bad"},{consent:false},{website:"bot"}
 ]){
  const result=await req("/api/public/event-proposals","POST",{...sample,...invalid});
  assert.equal(result.status,400,JSON.stringify({invalid,data:result.data}));
 }
 for(let n=1;n<8;n++){
  const r=await req("/api/public/event-proposals","POST",{...sample,topic:sample.topic+" "+n});
  assert.equal(r.status,200);
 }
 const limited=await req("/api/public/event-proposals","POST",sample);
 assert.equal(limited.status,429);
});
test("mini public page does not depend on wx.login or internal draft approval",()=>{
 const appJson=JSON.parse(fs.readFileSync(path.join(__dirname,"../miniprogram/app.json"),"utf8"));
 assert.equal(appJson.pages[0],"pages/welcome/index");
 assert.ok(appJson.pages.includes("pages/public-proposal/index"));
 const publicJs=fs.readFileSync(path.join(__dirname,"../miniprogram/pages/public-proposal/index.js"),"utf8");
 const inside=fs.readFileSync(path.join(__dirname,"../miniprogram/pages/apply/index.js"),"utf8");
 assert.match(publicJs,/\/public\/event-proposals/);
 assert.doesNotMatch(publicJs,/\/mini\/applications/);
 assert.match(inside,/\/mini\/applications/);
 const app=fs.readFileSync(path.join(__dirname,"../miniprogram/app.js"),"utf8");
 assert.match(app,/!path.startsWith\("\/public\/"\)/);
});

test("public proposal processing is superadmin-only and appears in the admin workbench todo",async()=>{
 // Previous rate-limit test deliberately exhausts the anonymous submission allowance.
 const pending=db.prepare("SELECT id FROM public_event_proposals WHERE status='已接收' ORDER BY received_at DESC LIMIT 1").get();
 assert.ok(pending);
 const id=pending.id;
 const guestProcess=await req("/api/admin/public-event-proposals/"+id+"/process","POST",{note:"guest attempt"},guestCookie);
 assert.equal(guestProcess.status,403);
 const dashboard=await req("/api/dashboard","GET",undefined,adminCookie);
 assert.ok(dashboard.data.todos.some(t=>t.kind==="公众申请"&&t.pid===id&&t.go==="public-proposals"));
 const processed=await req("/api/admin/public-event-proposals/"+id+"/process","POST",{note:"已电话联系，等待补充材料"},adminCookie);
 assert.equal(processed.status,200,JSON.stringify(processed.data));
 assert.equal(processed.data.status,"已归档");
 const row=db.prepare("SELECT status,handled_by,handled_at,handling_note FROM public_event_proposals WHERE id=?").get(id);
 assert.equal(row.status,"已归档");
 assert.ok(row.handled_by);
 assert.ok(row.handled_at);
 assert.equal(row.handling_note,"已电话联系，等待补充材料");
 const after=await req("/api/dashboard","GET",undefined,adminCookie);
 assert.equal(after.data.todos.some(t=>t.kind==="公众申请"&&t.pid===id),false);
 const repeat=await req("/api/admin/public-event-proposals/"+id+"/process","POST",{note:"再次点击"},adminCookie);
 assert.equal(repeat.status,200);
 assert.equal(db.prepare("SELECT handling_note FROM public_event_proposals WHERE id=?").get(id).handling_note,"已电话联系，等待补充材料");
});

test("superadmin converts an archived public proposal into exactly one editable internal draft",async()=>{
 const src=db.prepare("SELECT * FROM public_event_proposals WHERE status='已归档' ORDER BY received_at DESC LIMIT 1").get();
 assert.ok(src,"expected a prior archived public proposal");
 const assocResponse=await req("/api/associations","GET",undefined,adminCookie);
 assert.equal(assocResponse.status,200);
 const assoc=assocResponse.data.rows[0];
 assert.ok(assoc);
 const fullAgenda="议程完整保留："+("议程安排 ".repeat(290)).slice(0,2800);
 db.prepare("UPDATE public_event_proposals SET agenda=? WHERE id=?").run(fullAgenda,src.id);
 const beforeProjects=db.prepare("SELECT COUNT(*) AS n FROM projects").get().n;
 const beforeApprovals=db.prepare("SELECT COUNT(*) AS n FROM approvals").get().n;
 const route="/api/admin/public-event-proposals/"+src.id+"/convert";
 assert.equal((await req(route,"POST",{assoc},guestCookie)).status,403);
 assert.equal((await req(route,"POST",{assoc:"不存在的协会"},adminCookie)).status,400);
 const converted=await req(route,"POST",{assoc},adminCookie);
 assert.equal(converted.status,200,JSON.stringify(converted.data));
 assert.equal(converted.data.project.status,"草稿");
 assert.match(converted.data.project.id,/^MP-\d{4}-\d+$/);
 const p=db.prepare("SELECT * FROM projects WHERE id=?").get(converted.data.project.id);
 assert.equal(p.name,src.topic);
 assert.equal(p.assoc,assoc);
 assert.equal(p.form,src.form);
 assert.equal(p.date,src.event_date);
 assert.equal(p.public_event_time,src.event_time);
 assert.equal(p.budget,src.budget);
 assert.equal(p.agenda,fullAgenda);
 assert.equal(p.phone,src.contact_phone);
 assert.equal(p.public_contact_name,src.contact_name);
 assert.equal(p.public_contact_info,src.contact_info);
 assert.equal(p.status,"草稿");
 const linked=db.prepare("SELECT * FROM public_proposal_project_links WHERE proposal_id=?").get(src.id);
 assert.equal(linked.project_id,p.id);
 assert.equal(db.prepare("SELECT status FROM public_event_proposals WHERE id=?").get(src.id).status,"已归档");
 assert.equal(db.prepare("SELECT COUNT(*) AS n FROM projects").get().n,beforeProjects+1);
 assert.equal(db.prepare("SELECT COUNT(*) AS n FROM approvals").get().n,beforeApprovals,"conversion must never submit approval");
 const detail=await req("/api/projects/"+p.id,"GET",undefined,adminCookie);
 assert.equal(detail.status,200,JSON.stringify(detail.data));
 assert.equal(detail.data.sourcePublicProposalId,src.id);
 assert.equal(detail.data.project.public_contact_name,src.contact_name);
 const inbox=await req("/api/admin/public-event-proposals","GET",undefined,adminCookie);
 assert.ok(inbox.data.rows.some(row=>row.id===src.id&&row.project_id===p.id));
 const duplicate=await req(route,"POST",{assoc},adminCookie);
 assert.equal(duplicate.status,200);
 assert.equal(duplicate.data.project.id,p.id);
 assert.equal(duplicate.data.alreadyConverted,true);
 assert.equal(db.prepare("SELECT COUNT(*) AS n FROM projects").get().n,beforeProjects+1);
 assert.equal(db.prepare("SELECT COUNT(*) AS n FROM approvals").get().n,beforeApprovals);
 const dashboard=await req("/api/dashboard","GET",undefined,adminCookie);
 assert.equal(dashboard.data.todos.some(t=>t.pid===src.id&&t.kind==="公众申请"),false);
});
