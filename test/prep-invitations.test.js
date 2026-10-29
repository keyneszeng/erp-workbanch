"use strict";
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const path = require("node:path");
const fs = require("node:fs");

const PORT=8947, BASE="http://127.0.0.1:"+PORT;
const DB=path.join(__dirname,"..","data","prep-invitations-test.db");
let server, admin, assoc, exec, user, finance;
async function waitHealthy() {
  for(let i=0;i<100;i++) {
    try { const r=await fetch(BASE+"/api/health");if(r.ok)return; }catch {}
    await new Promise(resolve=>setTimeout(resolve,100));
  }
  throw Error("server did not start");
}
async function session(username) {
  const r=await fetch(BASE+"/api/auth/login",{method:"POST",headers:{"Content-Type":"application/json"},
    body:JSON.stringify({username,password:"123456"})});
  assert.equal(r.status,200,"login "+username);
  return r.headers.get("set-cookie").split(";")[0];
}
async function call(cookie,method,url,body) {
  const res=await fetch(BASE+url,{method,headers:{"Content-Type":"application/json",cookie},
    body:body?JSON.stringify(body):undefined});
  if((res.headers.get("content-type")||"").includes("application/pdf"))
    return {status:res.status,bytes:Buffer.from(await res.arrayBuffer()),headers:res.headers};
  return {status:res.status,data:await res.json(),headers:res.headers};
}
const prep=id=>"/api/projects/"+id+"/prep";
before(async()=>{
  for(const suffix of ["","-wal","-shm"])try{fs.rmSync(DB+suffix)}catch{}
  server=spawn(process.execPath,["--experimental-sqlite","server/index.js"],{
    cwd:path.join(__dirname,".."),
    env:{...process.env,ERP_DB:DB,ERP_PORT:String(PORT),
      ERP_RESEND_API_KEY:"",ERP_MAIL_FROM:""},
    stdio:["ignore","pipe","pipe"]
  });
  server.stderr.on("data",d=>{
    const s=d.toString();if(!s.includes("ExperimentalWarning"))process.stderr.write(s);
  });
  await waitHealthy();
  [admin,assoc,exec,user,finance]=await Promise.all(["admin","assoc","exec","guest","finance"].map(session));
  // Set up an explicitly published WeChat channel, without any real API credentials.
  const config=await call(admin,"GET","/api/admin/invitation-config");
  assert.equal(config.status,200);
  const draft={...config.data.live,wechat_enabled:true,mini_appid:"wx1234567890abcdef",
    mini_program_verified:true};
  assert.equal((await call(admin,"PATCH","/api/admin/invitation-config",
    {expected_version:config.data.version,config:draft})).status,200);
  assert.equal((await call(admin,"POST","/api/admin/invitation-config/publish",
    {expected_version:config.data.version})).status,200);
});
after(()=>{if(server)server.kill("SIGTERM")});

test("立项后自动匹配固定企业/嘉宾模板；草稿会议禁止生成",async()=>{
  const ok=await call(assoc,"GET",prep("MP-2026-001")+"/templates");
  assert.equal(ok.status,200);
  assert.deepEqual(ok.data.templates.map(x=>x.key),["enterprise","guest"]);
  assert.equal(ok.data.project_fields["会议名称"],"华东医学会年会");
  const notReady=await call(admin,"GET",prep("MP-2026-005")+"/templates");
  assert.equal(notReady.status,409);
});

test("只有总管理员、所属协会管理员及授权会务执行人员可生成",async()=>{
  const root=prep("MP-2026-001")+"/templates";
  assert.equal((await call(assoc,"GET",root)).status,200);
  assert.equal((await call(exec,"GET",root)).status,200);
  assert.equal((await call(user,"GET",root)).status,403);
  assert.equal((await call(finance,"GET",root)).status,403);
  const outsider=await call(assoc,"GET",prep("MP-2026-002")+"/templates");
  assert.equal(outsider.status,403);
});

test("企业邀请函个人化 PDF + 受邀响应与幂等",async()=>{
  const p="MP-2026-001";
  const create=await call(assoc,"POST",prep(p)+"/invitations",
    {type:"enterprise",recipient_org:"华星科技有限公司",recipient_title:"董事长",recipient_email:"partner@example.org"});
  assert.equal(create.status,200);
  const info=create.data;
  assert.equal(info.invitation.type,"enterprise");
  assert.equal(info.invitation.recipient_org,"华星科技有限公司");
  assert.equal(info.invitation.template_name,"企业邀请（招商）函");
  assert.equal(info.delivery_confirmed,false);
  assert.ok(info.token.length>=48);
  const pdf=await call(assoc,"GET",prep(p)+"/invitations/"+info.invitation.id+"/pdf");
  assert.equal(pdf.status,200);
  assert.equal(pdf.headers.get("content-type"),"application/pdf");
  assert.equal(pdf.bytes.subarray(0,5).toString(),"%PDF-");
  const url="/api/public/prep-invitation?token="+info.token;
  const pub=await fetch(BASE+url);
  assert.equal(pub.status,200);
  const pubDoc=await pub.json();
  assert.match(pubDoc.paragraphs.join("\n"),/华星科技有限公司/);
  const confirm=await call("","POST","/api/public/prep-invitation/respond",{token:info.token,action:"CONFIRM"});
  assert.equal(confirm.status,200);
  assert.equal(confirm.data.status,"已确认");
  const project=await call(assoc,"GET","/api/projects/"+p);
  assert.equal(project.status,200);
  assert.ok(project.data.guests.some(g=>g.invitation_id===info.invitation.id&&g.name==="华星科技有限公司")===false);

  assert.equal((await call("","POST","/api/public/prep-invitation/respond",{token:info.token,action:"CONFIRM"})).data.idempotent,true);
  assert.equal((await call("","POST","/api/public/prep-invitation/respond",{token:info.token,action:"DECLINE"})).status,409);
});

test("嘉宾邀请的角色和课题填充，邮箱未配置不能伪称发送成功",async()=>{
  const p="MP-2026-001";
  const c=await call(exec,"POST",prep(p)+"/invitations",{
    type:"guest",recipient_name:"王教授",recipient_title:"主任医师",guest_role:"主讲嘉宾",
    topic:"学术交流与科研",recipient_email:"prof@example.org"});
  assert.equal(c.status,200);
  assert.equal(c.data.invitation.recipient_name,"王教授");
  const r=await fetch(BASE+"/api/public/prep-invitation?token="+c.data.token);
  const info=await r.json();
  assert.match(info.paragraphs.join(""),/主讲嘉宾/);
  assert.match(info.paragraphs.join(""),/学术交流与科研/);
  const email=await call(exec,"POST",prep(p)+"/invitations/"+c.data.invitation.id+"/email",{});
  assert.equal(email.status,503);
  assert.equal(email.data.error.code,"MAIL_NOT_CONFIGURED");
  const list=await call(exec,"GET",prep(p)+"/invitations");
  assert.equal(list.status,200);
  const current=list.data.rows.find(x=>x.id===c.data.invitation.id);
  assert.equal(current.status,"草稿");
  const share=await call(exec,"POST",prep(p)+"/invitations/"+c.data.invitation.id+"/wechat-share",{});
  assert.equal(share.status,200);
  assert.equal(share.data.delivery_confirmed,false);
  assert.match(share.data.path,/^pages\/invite\/index\?token=[a-f0-9]+$/);
  // 令牌轮换后旧 token 失效，避免分享链接无限期泄露。
  assert.equal((await fetch(BASE+"/api/public/prep-invitation?token="+c.data.token)).status,404);
  const token=share.data.path.split("token=")[1];
  assert.equal((await fetch(BASE+"/api/public/prep-invitation?token="+token)).status,200);
  const declined=await call("","POST","/api/public/prep-invitation/respond",{token,action:"DECLINE"});
  assert.equal(declined.status,200);
  assert.equal(declined.data.status,"已拒绝");
  const project=await call(exec,"GET","/api/projects/"+p);
  assert.equal(project.status,200);
  assert.ok(project.data.guests.some(g=>g.invitation_id===c.data.invitation.id&&g.name==="王教授"&&g.status==="无法参加"));

});

test("缺失对象、模板类型与非法收件人校验",async()=>{
  assert.equal((await call(assoc,"POST",prep("MP-2026-001")+"/invitations",{type:"enterprise",recipient_title:"负责人"})).status,400);
  assert.equal((await call(assoc,"POST",prep("MP-2026-001")+"/invitations",{type:"unknown",recipient_name:"test"})).status,400);
  assert.equal((await call(assoc,"POST",prep("MP-2026-001")+"/invitations",{type:"guest",recipient_name:"张教授",recipient_email:"not an email"})).status,400);
  assert.equal((await call(assoc,"GET",prep("MP-2026-001")+"/invitations/IV-2099-000/pdf")).status,404);
});

test("授权人员撤销邀请后公开 Token 应被拒绝",async()=>{
  const p="MP-2026-001";
  const c=await call(admin,"POST",prep(p)+"/invitations",{type:"guest",recipient_name:"李教授"});
  assert.equal(c.status,200);
  const id=c.data.invitation.id;
  const revoke=await call(admin,"POST",prep(p)+"/invitations/"+id+"/revoke",{});
  assert.equal(revoke.status,200);
  assert.equal((await fetch(BASE+"/api/public/prep-invitation?token="+c.data.token)).status,410);
});


test("总管理员自助配置：权限、草稿、PDF 预览、禁止非法字段和未配置邮件上线",async()=>{
  const path="/api/admin/invitation-config";
  const all=await call(admin,"GET",path);
  assert.equal(all.status,200);
  for(const cookie of [assoc,exec,finance,user]){
    assert.equal((await call(cookie,"GET",path)).status,403);
    assert.equal((await call(cookie,"PATCH",path,{config:all.data.live,expected_version:all.data.version})).status,403);
    assert.equal((await call(cookie,"POST",path+"/publish",{expected_version:all.data.version})).status,403);
  }
  assert.equal((await call(admin,"PATCH",path,{expected_version:all.data.version,
    config:{...all.data.live,ERP_RESEND_API_KEY:"secret"}})).status,400);
  const draft={...all.data.live,org_footer:"联系秘书处以了解会议安排",
    templates:{...all.data.live.templates,
      guest:{...all.data.live.templates.guest,subject:"邀请参加{{会议名称}} · 讲者"}}};
  const saved=await call(admin,"PATCH",path,{expected_version:all.data.version,config:draft});
  assert.equal(saved.status,200);
  assert.equal(saved.data.live.org_footer,all.data.live.org_footer);
  assert.equal(saved.data.draft.org_footer,draft.org_footer);
  const pdf=await call(admin,"GET",path+"/preview?pid=MP-2026-001&type=guest");
  assert.equal(pdf.status,200);assert.equal(pdf.bytes.subarray(0,5).toString(),"%PDF-");
  const pub=await call(admin,"POST",path+"/publish",{expected_version:all.data.version});
  assert.equal(pub.status,200);assert.equal(pub.data.live.org_footer,draft.org_footer);
  assert.equal(pub.data.version,all.data.version+1);
  assert.equal((await call(admin,"POST",path+"/publish",{expected_version:all.data.version})).status,400);
  const sendEnabled={...pub.data.live,email_enabled:true};
  assert.equal((await call(admin,"PATCH",path,{expected_version:pub.data.version,config:sendEnabled})).status,200);
  assert.equal((await call(admin,"POST",path+"/publish",{expected_version:pub.data.version})).status,400);
  const rolling=await call(admin,"POST",path+"/rollback",
    {expected_version:pub.data.version,target_version:all.data.version});
  assert.equal(rolling.status,200);
  assert.equal(rolling.data.live.org_footer,all.data.live.org_footer);
});
