"use strict";
/**
 * Read-only real Cloudflare post-deploy verification of newly shipped invites.
 * Never creates a document, never sends email/WeChat, never changes config.
 */
const assert=require("node:assert/strict");
const {PDFDocument}=require("pdf-lib");
const BASE=process.env.ERP_BASE||"https://erp.aibuild.work";
let checked=0;
async function login(username) {
 const r=await fetch(BASE+"/api/auth/login",{method:"POST",headers:{"Content-Type":"application/json"},
   body:JSON.stringify({username,password:"123456"})});
 assert.equal(r.status,200,"Demo account "+username+" login");
 const cookie=(r.headers.get("set-cookie")||"").split(";")[0];
 assert.ok(cookie.includes("="),username+" session cookie missing");
 return cookie;
}
async function req(cookie,path) {
 return fetch(BASE+path,{headers:cookie?{Cookie:cookie}:undefined,redirect:"manual",cache:"no-store"});
}
async function checkStatus(cookie,path,expected,label) {
 const r=await req(cookie,path);
 assert.equal(r.status,expected, label+" "+path);
 console.log("PASS",label,r.status);
 checked++;
 return r;
}
(async()=>{
 const auth={};
 for(const u of ["admin","assoc","exec","finance","guest"]) auth[u]=await login(u);
 console.log("PASS five demo-role logins");

 for(const path of ["/invite.html","/assets/js/invitation-public.js",
    "/assets/js/pages/prep-invitations.js","/assets/js/pages/invitation-config.js"]) {
   const r=await checkStatus("",path,200,"public UI asset");
   const txt=await r.text();
   assert.ok(txt.length>100,path+" empty body");
 }
 const cfg=await checkStatus(auth.admin,"/api/admin/invitation-config",200,"admin config");
 const settings=await cfg.json();
 assert.equal(typeof settings.version,"number");
 assert.ok(settings.live.templates.enterprise);
 assert.ok(settings.live.templates.guest);
 assert.equal(JSON.stringify(settings).includes("re_test_only_"),false);
 console.log("PASS live configuration version",settings.version,"mail ready",settings.readiness.mail_service_ready);
 for(const role of ["assoc","exec","finance","guest"]) {
   await checkStatus(auth[role],"/api/admin/invitation-config",403,role+" denied admin settings");
 }
 const templates="/api/projects/MP-2026-001/prep/templates";
 for(const role of ["admin","assoc","exec"]) {
   const r=await checkStatus(auth[role],templates,200,role+" meeting preparation");
   const body=await r.json();
   assert.deepEqual(body.templates.map(x=>x.key),["enterprise","guest"]);
   assert.ok(body.project_fields["会议名称"]);
 }
 for(const role of ["finance","guest"]) await checkStatus(auth[role],templates,403,role+" denied invitations");
 await checkStatus(auth.assoc,"/api/projects/MP-2026-002/prep/templates",403,"cross-association denied");
 await checkStatus(auth.admin,"/api/projects/MP-2026-018/prep/templates",409,"draft project denied");
 const preview="/api/admin/invitation-config/preview?pid=MP-2026-001&type=guest";
 const pdf=await checkStatus(auth.admin,preview,200,"super admin invitation PDF preview");
 assert.match(pdf.headers.get("content-type")||"",/^application\/pdf/);
 const raw=new Uint8Array(await pdf.arrayBuffer());
 assert.equal(Buffer.from(raw).toString("ascii",0,5),"%PDF-");
 assert.ok((await PDFDocument.load(raw)).getPageCount()>0);
 console.log("PASS invitation preview PDF bytes",raw.length);
 await checkStatus(auth.assoc,preview,403,"association admin denied config preview");
 const invalid="deadbeef".repeat(6);
 await checkStatus("","/api/public/prep-invitation?token="+invalid,404,"invalid public token denied");
 await checkStatus(auth.admin,"/api/projects/MP-2026-001/prep/invitations",200,"project invitation list");
 console.log("PREP_INVITATION_LIVE_PASS",checked,"checks");
})().catch(err=>{console.error("PREP_INVITATION_LIVE_FAIL",err.stack||err);process.exitCode=1;});
