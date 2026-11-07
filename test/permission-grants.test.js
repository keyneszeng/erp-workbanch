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
 for(let i=0;i<200;i++){
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
 assert.equal((await call("newstaff","GET","/api/auth/me")).status,401,
  "保存授权后须令旧会话失效");
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
test("总管理员可授权用户管理，但该用户绝对无权再授权他人",async()=>{
 const set=await call("admin","PATCH","/api/users/"+userId+"/access",{
  modules:["dashboard","projects","system"],permissions:["user:manage"]
 });
 assert.equal(set.status,200);
 await login("newstaff","SecureDemo2026!");
 const list=await call("newstaff","GET","/api/users");
 assert.equal(list.status,200,"已被授权管理账号可见账号列表");
 const grant=await call("newstaff","PATCH","/api/users/2/access",{
  modules:["system"],permissions:["user:manage"]
 });
 assert.equal(grant.status,403,"非总管理员不能再分配权限");
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
