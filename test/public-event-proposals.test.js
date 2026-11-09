"use strict";
const {test,before,after}=require("node:test");
const assert=require("node:assert/strict");
const {spawn}=require("node:child_process");
const fs=require("node:fs"),os=require("node:os"),path=require("node:path");
const {DatabaseSync}=require("node:sqlite");
const dir=fs.mkdtempSync(path.join(os.tmpdir(),"erp-public-intake-"));
const dbFile=path.join(dir,"test.sqlite"),port=8947,base="http://127.0.0.1:"+port;
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
 for(let i=0;i<90;i++){
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
