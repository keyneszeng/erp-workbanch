"use strict";
/** 业务角色零内置功能授权；总管理员逐账号自由分配，实时服务端门禁。 */
const {test,before,after}=require("node:test");
const assert=require("node:assert/strict");
const {spawn}=require("node:child_process");
const fs=require("node:fs"),os=require("node:os"),path=require("node:path");
const dir=fs.mkdtempSync(path.join(os.tmpdir(),"erp-user-access-"));
const port=8988,base="http://127.0.0.1:"+port;
let proc,cookies={},userId;
async function call(who,method,url,body){
 const res=await fetch(base+url,{method,headers:{
  ...(cookies[who]?{cookie:cookies[who]}:{}),
  ...(body!==undefined?{"content-type":"application/json"}:{})
 },body:body===undefined?undefined:JSON.stringify(body)});
 const payload=await res.json().catch(()=>null);
 return {status:res.status,body:payload};
}
async function login(name,password="123456"){
 const res=await fetch(base+"/api/auth/login",{method:"POST",
 headers:{"content-type":"application/json"},body:JSON.stringify({username:name,password})});
 assert.equal(res.status,200,name+" login "+await res.text());
 cookies[name]=(res.headers.get("set-cookie")||"").split(";")[0];
}
before(async()=>{
 proc=spawn(process.execPath,["--experimental-sqlite","server/index.js"],{
 cwd:path.resolve(__dirname,".."),
 env:{...process.env,ERP_DEMO_MODE:"1",ERP_PORT:String(port),
  ERP_DB:path.join(dir,"erp.db"),ERP_UPLOAD_DIR:path.join(dir,"uploads")},
 stdio:["ignore","pipe","pipe"]});
 let error="";proc.stderr.on("data",c=>error+=String(c));
 let ready=false;
 for(let i=0;i<400;i++){
  try{if((await fetch(base+"/api/health")).ok){ready=true;break;}}catch{}
  if(proc.exitCode!==null)throw Error("server died "+error);
  await new Promise(r=>setTimeout(r,150));
 }
 assert.ok(ready,"server start "+error);
 await login("admin");
 await login("exec");
});
after(()=>{proc?.kill("SIGTERM");fs.rmSync(dir,{recursive:true,force:true});});
test("角色元数据没有固定模块，演示账号权限为明确的用户级测试授权",async()=>{
 const meta=await call("admin","GET","/api/meta");
 assert.equal(meta.status,200);
 assert.ok(meta.body.roles.filter(x=>x.key!=="admin").every(x=>x.modules.length===0),
  JSON.stringify(meta.body.roles));
 const me=await call("exec","GET","/api/auth/me");
 assert.equal(me.status,200);
 assert.equal(me.body.user.role,"exec");
 assert.ok(me.body.role.modules.includes("projects"),
  "演示用执行账号由种子逐账号显式赋权，不是角色内置授权");
 assert.ok(me.body.perms.includes("project:create"));
});
test("新建与已有角色相同的账号无任何模块或操作权限",async()=>{
 const res=await call("admin","POST","/api/users",{
  username:"newstaff",name:"零权限测试账号",role:"exec",
  assoc:"华东医学会",assocs:["华东医学会"],dept:"非供应商",phone:"13800009999",
  password:"SecureDemo2026!"
 });
 assert.equal(res.status,200,JSON.stringify(res.body));
 userId=res.body.user.id;
 const assigned=await call("admin","GET","/api/users/"+userId+"/access");
 assert.equal(assigned.status,200,JSON.stringify(assigned.body));
 assert.deepEqual(assigned.body.access,{modules:[],permissions:[]});
 await login("newstaff","SecureDemo2026!");
 const me=await call("newstaff","GET","/api/auth/me");
 assert.equal(me.status,200);
 assert.equal(me.body.user.role,"exec");
 assert.deepEqual(me.body.role.modules,[]);
 assert.deepEqual(me.body.perms,[]);
 for(const url of ["/api/dashboard","/api/projects","/api/projects/MP-2026-001"]){
  const blocked=await call("newstaff","GET",url);
  assert.equal(blocked.status,403,JSON.stringify({url,blocked}));
 }
 assert.equal((await call("newstaff","GET","/api/users/"+userId+"/access")).status,403);
 assert.equal((await call("newstaff","PATCH","/api/users/"+userId+"/access",{modules:["system"],permissions:["user:manage"]})).status,403);
});
test("禁止提权创建第二个总管理员或把业务账号提升为超级管理员",async()=>{
 const create=await call("admin","POST","/api/users",{
  username:"fakeadmin",name:"非法管理员",role:"admin",password:"SecureDemo2026!"});
 assert.equal(create.status,400,JSON.stringify(create.body));
 const elevate=await call("admin","PATCH","/api/users/"+userId,{role:"admin"});
 assert.equal(elevate.status,400,JSON.stringify(elevate.body));
 const superAccess=await call("admin","GET","/api/users/1/access");
 assert.equal(superAccess.status,200);
 assert.equal(superAccess.body.immutable,true);
 assert.ok(superAccess.body.access.modules.includes("system"));
 const revoke=await call("admin","PATCH","/api/users/1/access",{modules:[],permissions:[]});
 assert.equal(revoke.status,409);
 assert.equal(revoke.body.error.code,"SUPER_IMMUTABLE");
});
test("输入验证：未知模块、权限、重复及不完整列表均被拒绝且不保存",async()=>{
 const payloads=[
  {modules:["nonexistent"],permissions:[]},
  {modules:[],permissions:["super:delete-everything"]},
  {modules:["dashboard","dashboard"],permissions:[]},
  {modules:[],permissions:["project:create","project:create"]},
  {modules:"dashboard",permissions:[]},
  {modules:[],permissions:null}
 ];
 for(const body of payloads){
  const response=await call("admin","PATCH","/api/users/"+userId+"/access",body);
  assert.equal(response.status,400,JSON.stringify({body,response}));
 }
 const current=await call("admin","GET","/api/users/"+userId+"/access");
 assert.deepEqual(current.body.access,{modules:[],permissions:[]});
});
test("总管理员可独立分配模块和操作；同role的用户权限不相同",async()=>{
 const changed=await call("admin","PATCH","/api/users/"+userId+"/access",{
  modules:["dashboard","projects","finance"],permissions:["project:create","payment:create"]
 });
 assert.equal(changed.status,200,JSON.stringify(changed.body));
 const oldSession=await call("newstaff","GET","/api/auth/me");
 assert.equal(oldSession.status,200,"/auth/me 是公开的登录状态探测接口");
 assert.equal(oldSession.body.user,null,"保存授权后旧会话必须视为未登录");
 await login("newstaff","SecureDemo2026!");
 const me=await call("newstaff","GET","/api/auth/me");
 assert.deepEqual(me.body.role.modules,["dashboard","projects","finance"]);
 assert.deepEqual(me.body.perms,["project:create","payment:create"]);
 assert.equal((await call("newstaff","GET","/api/dashboard")).status,200);
 assert.equal((await call("newstaff","GET","/api/projects")).status,200);
 const denied=await call("newstaff","GET","/api/users");
 assert.equal(denied.status,403);
 const exec=await call("exec","GET","/api/auth/me");
 assert.ok(exec.body.perms.includes("verify:check"));
 assert.ok(!me.body.perms.includes("verify:check"),
  "同一岗位的权限必须逐账号独立，不能从role继承");
});
test("仅总管理员拥有系统配置；授权面板拒绝把系统权限分配给业务账号",async()=>{
 const access=await call("admin","GET","/api/users/"+userId+"/access");
 assert.equal(access.status,200);
 assert.ok(!access.body.available_modules.some(x=>x.k==="system"));
 for(const p of ["user:manage","setting:write"])
   assert.ok(!access.body.available_permissions.includes(p));
 for(const requested of [
   {modules:["dashboard","projects","system"],permissions:["project:create"]},
   {modules:["dashboard","projects"],permissions:["user:manage"]},
   {modules:["dashboard","projects"],permissions:["setting:write"]}
 ]){
   const res=await call("admin","PATCH","/api/users/"+userId+"/access",requested);
   assert.equal(res.status,400,JSON.stringify(res.body));
 }
 const business=await call("admin","PATCH","/api/users/"+userId+"/access",{
   modules:["dashboard","projects","finance"],permissions:["project:create","payment:create"]
 });
 assert.equal(business.status,200,JSON.stringify(business.body));
 await login("newstaff","SecureDemo2026!");
 assert.equal((await call("newstaff","GET","/api/dashboard")).status,200);
 assert.equal((await call("newstaff","GET","/api/projects")).status,200);
});
test("普通用户即使数据库残留管理授权也不能进入配置接口",async()=>{
 const {DatabaseSync}=require("node:sqlite");
 const d=new DatabaseSync(path.join(dir,"erp.db"));
 const guest=d.prepare("SELECT id FROM users WHERE username='guest'").get();
 assert.ok(guest);
 try{
   for(const id of [userId,guest.id]){
     d.prepare("INSERT OR IGNORE INTO user_module_grants(user_id,module) VALUES (?,?)").run(id,"system");
     for(const perm of ["user:manage","setting:write"])
       d.prepare("INSERT OR IGNORE INTO user_permission_grants(user_id,permission) VALUES (?,?)").run(id,perm);
   }
 }finally{d.close();}
 await login("guest");
 for(const who of ["newstaff","guest"]){
   const me=await call(who,"GET","/api/auth/me");
   assert.equal(me.body.super,false);
   assert.ok(!me.body.role.modules.includes("system"));
   assert.ok(!me.body.perms.includes("user:manage"));
   assert.ok(!me.body.perms.includes("setting:write"));
   assert.equal((await call(who,"GET","/api/dashboard")).status,200);
   assert.equal((await call(who,"GET","/api/projects")).status,200);
   for(const [method,url,body] of [
     ["GET","/api/users"],
     ["POST","/api/users",{username:"evil",role:"user"}],
     ["PATCH","/api/users/"+userId,{name:"越权修改"}],
     ["GET","/api/users/"+userId+"/access"],
     ["PATCH","/api/users/"+userId+"/access",{modules:["system"],permissions:["user:manage"]}],
     ["POST","/api/associations",{name:"越权协会"}],
     ["DELETE","/api/associations/"+encodeURIComponent("华东医学会")],
     ["GET","/api/admin/invitation-config"],
     ["PATCH","/api/admin/invitation-config",{expected_version:1,config:{}}],
     ["GET","/api/admin/public-event-proposals"],
     ["GET","/api/admin/reset-preview"]
   ]){
     const denied=await call(who,method,url,body);
     assert.equal(denied.status,403,JSON.stringify({who,method,url,denied}));
   }
 }
 const admin=await call("admin","GET","/api/users");
 assert.equal(admin.status,200);
 const a=await call("admin","GET","/api/users/"+userId+"/access");
 assert.equal(a.status,200);
 assert.ok(!a.body.access.modules.includes("system"));
 assert.ok(!a.body.access.permissions.includes("user:manage"));
 assert.ok(!a.body.access.permissions.includes("setting:write"));
});
test("非总管理员不能修改任何账号（包括本人及总管理员）",async()=>{
 const users=await call("admin","GET","/api/users");
 assert.equal(users.status,200);
 const superUser=users.body.rows.find(x=>x.role==="admin");
 const finance=users.body.rows.find(x=>x.role==="finance");
 for(const who of ["newstaff","guest"]){
   for(const [id,body] of [[superUser.id,{name:"越权修改"}],
     [finance.id,{password:"Compromised2026!"}],[userId,{name:"擅自改名"}]]){
     const res=await call(who,"PATCH","/api/users/"+id,body);
     assert.equal(res.status,403,JSON.stringify({who,id,res}));
   }
 }
 const after=await call("admin","GET","/api/users");
 assert.equal(after.body.rows.find(x=>x.id===superUser.id).name,superUser.name);
});
test("只授权项目浏览模块的账号不能读取预算、合同、付款、审计等内部明细",async()=>{
 const created=await call("admin","POST","/api/users",{
  username:"qa_viewonly",name:"项目只读审计测试",role:"finance",
  assoc:"华东医学会",assocs:["华东医学会"],dept:"非供应商",
  phone:"13800009610",password:"ReadOnly2026!"
 });
 assert.equal(created.status,200,JSON.stringify(created.body));
 const id=created.body.user.id;
 const grant=await call("admin","PATCH","/api/users/"+id+"/access",{
  modules:["projects"],permissions:[]
 });
 assert.equal(grant.status,200,JSON.stringify(grant.body));
 await login("qa_viewonly","ReadOnly2026!");
 const list=await call("qa_viewonly","GET","/api/projects");
 assert.equal(list.status,200,JSON.stringify(list.body));
 assert.ok(list.body.rows.length>0,"只读用户应可查看所属协会的公开项目目录");
 assert.ok(list.body.summary==null,"公开项目目录不能附带预算/支付汇总");
 assert.equal(list.body.rows[0].budget,undefined);
 const detail=await call("qa_viewonly","GET","/api/projects/MP-2026-001");
 assert.equal(detail.status,200,JSON.stringify(detail.body));
 assert.equal(detail.body.visibility,"participant");
 assert.equal(detail.body.project.budget,undefined);
 for(const key of ["contracts","payments","settlement","timeline","approvals","verification","members"]){
  assert.equal(detail.body[key],undefined,key+"应由独立权限保护");
 }
 assert.equal((await call("qa_viewonly","GET","/api/contracts")).status,403);
 assert.equal((await call("qa_viewonly","GET","/api/payments")).status,403);
});
test("财务岗位仅有工作台权限时不得读取付款统计、预算明细或审计记录",async()=>{
 const account=await call("admin","POST","/api/users",{
  username:"qa_boardonly",name:"工作台财务只读验证",role:"finance",
  assoc:"华东医学会",assocs:["华东医学会"],dept:"财务部",
  phone:"13800009612",password:"NoFinance2026!"
 });
 assert.equal(account.status,200,JSON.stringify(account.body));
 const id=account.body.user.id;
 const basic=await call("admin","PATCH","/api/users/"+id+"/access",{
  modules:["dashboard"],permissions:[]
 });
 assert.equal(basic.status,200,JSON.stringify(basic.body));
 await login("qa_boardonly","NoFinance2026!");
 const res=await call("qa_boardonly","GET","/api/dashboard");
 assert.equal(res.status,200,JSON.stringify(res.body));
 assert.equal(res.body.budget,null,"仅有工作台权限不能查看项目预算");
 assert.equal(res.body.paid,null,"仅有工作台权限不能查看已付款额");
 assert.ok(res.body.statusRows.every(x=>x.budget===undefined),
  "不能通过状态分组行的 budget 字段绕过看板金额权限");
 assert.ok(res.body.upcoming.every(x=>x.budget===undefined&&x.phone===undefined),
  "不能从本周会议列表获得项目原始行内部字段");
 assert.deepEqual(res.body.recent,[],"缺少审计权不能读取最近审计日志");
 // 仅显式新增财务模块后可读取对应财务统计。
 const enabled=await call("admin","PATCH","/api/users/"+id+"/access",{
  modules:["dashboard","finance"],permissions:[]
 });
 assert.equal(enabled.status,200,JSON.stringify(enabled.body));
 await login("qa_boardonly","NoFinance2026!");
 const withFinance=await call("qa_boardonly","GET","/api/dashboard");
 assert.equal(withFinance.status,200,JSON.stringify(withFinance.body));
 assert.ok(withFinance.body.budget>0,"经总管理员授权财务模块后应看到本范围预算");
 assert.ok(withFinance.body.statusRows.some(x=>typeof x.budget==="number"));
});
test("已获功能授权的财务和执行账号不再因角色名称被遗漏工作台待办",async()=>{
 await login("finance");
 const finance=await call("finance","GET","/api/dashboard");
 assert.equal(finance.status,200,JSON.stringify(finance.body));
 assert.ok(finance.body.todos.some(x=>x.kind==="筹备"&&x.pid==="MP-2026-009"),
  "陈静作为立项负责人且有project:transition权限，应看到待筹备项目");
 const exec=await call("exec","GET","/api/dashboard");
 assert.equal(exec.status,200,JSON.stringify(exec.body));
 assert.ok(exec.body.todos.some(x=>x.kind==="待核销"&&x.pid==="MP-2026-003"),
  "张伟有verify:check权限且为待核销项目负责人，应看到核销任务");
});
test("编辑项目资料权不能顺带读取合同、付款、审计和材料原件",async()=>{
 const reader=await call("admin","GET","/api/users");
 const u=reader.body.rows.find(x=>x.username==="qa_viewonly");
 assert.ok(u);
 const grant=await call("admin","PATCH","/api/users/"+u.id+"/access",{
  modules:["projects"],permissions:["project:edit"]
 });
 assert.equal(grant.status,200,JSON.stringify(grant.body));
 await login("qa_viewonly","ReadOnly2026!");
 const detail=await call("qa_viewonly","GET","/api/projects/MP-2026-001");
 assert.equal(detail.status,200,JSON.stringify(detail.body));
 assert.ok(detail.body.project.budget>0,"编辑项目预算的账号可以查看所需预算字段");
 assert.equal(detail.body.sectionAccess.finance,false);
 assert.equal(detail.body.sectionAccess.contracts,false);
 assert.equal(detail.body.sectionAccess.audit,false);
 assert.equal(detail.body.sectionAccess.materials,false);
 for(const key of ["payments","contracts","timeline","members","materials","approvals"]){
  assert.deepEqual(detail.body[key],[],key+"不应因project:edit被间接授权");
 }
 assert.equal(detail.body.settlement,null);
 assert.equal(detail.body.paidTotal,null);
 assert.deepEqual(detail.body.sponsorRights.contracts,[]);
 const list=await call("qa_viewonly","GET","/api/projects");
 assert.equal(list.status,200,JSON.stringify(list.body));
 assert.equal(list.body.rows[0].paid_amt,undefined);
 assert.equal(list.body.rows[0].pay_cnt,undefined);
 assert.ok(list.body.rows.some(x=>Number(x.budget)>0));
 assert.equal((await call("qa_viewonly","GET","/api/payments")).status,403);
});
test("仅授予材料模块和上传权限时项目预算、合同和付款仍不可见",async()=>{
 const users=await call("admin","GET","/api/users");
 const u=users.body.rows.find(x=>x.username==="qa_viewonly");
 const grant=await call("admin","PATCH","/api/users/"+u.id+"/access",{
  modules:["projects","materials"],permissions:["material:write"]
 });
 assert.equal(grant.status,200,JSON.stringify(grant.body));
 await login("qa_viewonly","ReadOnly2026!");
 const detail=await call("qa_viewonly","GET","/api/projects/MP-2026-001");
 assert.equal(detail.status,200,JSON.stringify(detail.body));
 assert.equal(detail.body.project.budget,undefined);
 assert.equal(detail.body.project.phone,undefined);
 assert.equal(detail.body.sectionAccess.materials,true);
 assert.equal(detail.body.sectionAccess.finance,false);
 assert.equal(detail.body.payments.length,0);
 assert.equal(detail.body.contracts.length,0);
 const list=await call("qa_viewonly","GET","/api/projects");
 assert.equal(list.status,200);
 assert.equal(list.body.rows[0].budget,undefined);
 assert.ok(list.body.summary?.budget==null,"无预算权不得附带预算汇总");
});
test("撤销后立即失效；重新登录也不能访问已经撤销的模块",async()=>{
 const revoke=await call("admin","PATCH","/api/users/"+userId+"/access",{
  modules:[],permissions:[]
 });
 assert.equal(revoke.status,200);
 assert.equal((await call("newstaff","GET","/api/users")).status,401);
 await login("newstaff","SecureDemo2026!");
 const me=await call("newstaff","GET","/api/auth/me");
 assert.deepEqual(me.body.perms,[]);
 assert.deepEqual(me.body.role.modules,[]);
 assert.equal((await call("newstaff","GET","/api/users")).status,403);
 assert.equal((await call("newstaff","GET","/api/projects")).status,403);
 const audit=await call("admin","GET","/api/audit?q="+encodeURIComponent(String(userId)));
 assert.equal(audit.status,200);
 assert.ok(audit.body.rows.some(r=>r.action==="修改账号授权"));
});

test("合同签署权限仅归协会管理员和总管理员，协会管理员无需手动授权即可录入及签署",async()=>{
 const created=await call("admin","POST","/api/users",{
  username:"qa_contract_assoc",name:"合同授权协会管理员",role:"assoc",
  assoc:"华东医学会",assocs:["华东医学会"],dept:"学术部",
  phone:"13800008886",password:"SecureDemo2026!"
 });
 assert.equal(created.status,200,JSON.stringify(created.body));
 const id=created.body.user.id;
 const access=await call("admin","GET","/api/users/"+id+"/access");
 assert.equal(access.status,200,JSON.stringify(access.body));
 assert.ok(!access.body.available_permissions.includes("contract:approve"),
  "签署审批是角色固定权限，不能在普通成员授权面板分配");
 const illegal=await call("admin","PATCH","/api/users/"+userId+"/access",{
  modules:["prep"],permissions:["contract:write","contract:approve"]
 });
 assert.equal(illegal.status,400,"任何非管理员成员不能获得合同签署审批授权");
 const allowRecording=await call("admin","PATCH","/api/users/"+userId+"/access",{
  modules:["prep"],permissions:["contract:write"]
 });
 assert.equal(allowRecording.status,200,JSON.stringify(allowRecording.body));
 await login("qa_contract_assoc","SecureDemo2026!");
 await login("newstaff","SecureDemo2026!");
 const assocMe=await call("qa_contract_assoc","GET","/api/auth/me");
 assert.equal(assocMe.status,200);
 assert.ok(assocMe.body.perms.includes("contract:write"));
 assert.ok(assocMe.body.perms.includes("contract:approve"));
 assert.deepEqual(assocMe.body.role.modules,[],"不要求额外给协会管理员开筹备模块");
 assert.equal((await call("qa_contract_assoc","GET","/api/contracts")).status,200);
 assert.equal((await call("qa_contract_assoc","GET","/api/approvals")).status,200);
 const execMe=await call("newstaff","GET","/api/auth/me");
 assert.ok(execMe.body.perms.includes("contract:write"),"其他成员可获得录入/提交权限");
 assert.ok(!execMe.body.perms.includes("contract:approve"),"其他成员不可审批签署");
});
