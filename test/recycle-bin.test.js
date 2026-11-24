"use strict";
/** 废件箱集成测试：仅总管理员，下载隔离，原地恢复，合同回滚审批安全，冻结及旧版本拦截。 */
const {test,before,after}=require("node:test");
const assert=require("node:assert/strict");
const {spawn}=require("node:child_process");
const {DatabaseSync}=require("node:sqlite");
const fs=require("node:fs"),path=require("node:path"),os=require("node:os");
const root=path.join(__dirname,"..");
const dir=fs.mkdtempSync(path.join(os.tmpdir(),"erp-recycle-"));
const DB=path.join(dir,"db.sqlite"),UP=path.join(dir,"uploads");
const PORT=8997,BASE="http://127.0.0.1:"+PORT;
const PID="MP-2026-001";
const PDF=Buffer.from("%PDF-1.4\n1 0 obj\n<< /Type /Catalog /Title (recycle) >>\nendobj\n%%EOF\n");
let server,users={};
async function ready(){
 for(let i=0;i<300;i++){try{if((await fetch(BASE+"/api/health")).ok)return;}catch{}
 await new Promise(r=>setTimeout(r,130));}
 throw Error("废件箱测试服务未启动");
}
async function login(user){
 const r=await fetch(BASE+"/api/auth/login",{method:"POST",headers:{"content-type":"application/json"},
  body:JSON.stringify({username:user,password:"123456"})});
 assert.equal(r.status,200,JSON.stringify({user,status:r.status}));
 users[user]=r.headers.get("set-cookie").split(";")[0];
}
async function req(user,method,url,data){
 const r=await fetch(BASE+url,{method,headers:{cookie:users[user],"content-type":"application/json"},
  body:data===undefined?undefined:JSON.stringify(data)});
 let body;try{body=await r.json();}catch{body=null;}
 return {status:r.status,body};
}
async function file(user,key){return fetch(BASE+"/api/uploads/"+key,{headers:{cookie:users[user]}});}
async function upload(name,user="exec"){
 const r=await fetch(BASE+"/api/uploads?pid="+PID,{
  method:"POST",headers:{cookie:users[user],"content-type":"application/pdf",
    "x-file-name":encodeURIComponent(name)},body:PDF});
 const body=await r.json();assert.equal(r.status,200,JSON.stringify(body));
 return body;
}
async function material(name,kind="其他资料"){
 const up=await upload(name);
 const r=await req("exec","POST","/api/projects/"+PID+"/materials",{
  kind,name,version:"v2",file_key:up.key,file_name:up.name,file_mime:up.mime,file_size:up.size});
 assert.equal(r.status,200,JSON.stringify(r.body));
 const detail=await req("admin","GET","/api/projects/"+PID);
 const m=detail.body.materials.find(x=>x.file_key===up.key);
 assert.ok(m,"新材料必须在项目详情出现");
 return {m,up};
}
async function list(q=""){
 const r=await req("admin","GET","/api/recycle-bin/materials?page=1&size=20"+(q?"&q="+encodeURIComponent(q):""));
 assert.equal(r.status,200,JSON.stringify(r.body));
 return r.body;
}
function sql(fn){
 const db=new DatabaseSync(DB);try{return fn(db);}finally{db.close();}
}
before(async()=>{
 server=spawn(process.execPath,["--experimental-sqlite","server/index.js"],{
  cwd:root,env:{...process.env,ERP_DEMO_MODE:"1",ERP_PORT:String(PORT),ERP_DB:DB,ERP_UPLOAD_DIR:UP},
  stdio:["ignore","pipe","pipe"]});
 server.stderr.on("data",d=>{const s=String(d);if(!s.includes("ExperimentalWarning"))process.stderr.write(s);});
 await ready();
 for(const u of ["admin","assoc","exec","finance","guest"])await login(u);
});
after(()=>{server?.kill("SIGTERM");fs.rmSync(dir,{recursive:true,force:true});});

test("废件箱查询与恢复均只允许总管理员，普通用户无法通过原附件 key 查看删除文件",async()=>{
 const {m,up}=await material("会场设计照片归档.pdf");
 assert.equal((await file("exec",up.key)).status,200,"删除前仍可按原权限查看材料");
 const removed=await req("exec","DELETE","/api/materials/"+m.id);
 assert.equal(removed.status,200,JSON.stringify(removed.body));
 for(const user of ["assoc","exec","finance","guest"]){
  const forbiddenList=await req(user,"GET","/api/recycle-bin/materials");
  assert.equal(forbiddenList.status,403,user+" 不得读取废件箱");
  const forbiddenRestore=await req(user,"POST","/api/recycle-bin/materials/"+m.id+"/restore",{});
  assert.equal(forbiddenRestore.status,403,user+" 不得恢复材料");
  const deniedFile=await file(user,up.key);
  assert.equal(deniedFile.status,403,user+" 不能直接下载废件箱原文件");
 }
 const box=await list("会场设计照片");
 const saved=box.rows.find(r=>r.id===m.id);
 assert.ok(saved,"已删除材料应进入废件箱");
 assert.equal(saved.pid,PID);
 assert.equal(saved.kind,"其他资料");
 assert.equal(saved.name,m.name);
 assert.equal(saved.file_key,up.key);
 assert.ok(saved.deleted_at);
 assert.ok(saved.deleted_by);
 assert.equal((await file("admin",up.key)).status,200,"总管理员仍可查看原始材料");
 const restored=await req("admin","POST","/api/recycle-bin/materials/"+m.id+"/restore",{});
 assert.equal(restored.status,200,JSON.stringify(restored.body));
 assert.equal(restored.body.id,m.id);
 assert.equal(restored.body.kind,m.kind);
 const detail=await req("admin","GET","/api/projects/"+PID);
 const original=detail.body.materials.find(x=>x.id===m.id);
 assert.ok(original);
 for(const k of ["pid","kind","name","version","file_key","file_name","created_at"]){
  assert.equal(original[k],m[k],"恢复后保留原字段 "+k);
 }
 assert.equal(original.deleted_at,null);
 assert.equal((await file("exec",up.key)).status,200,"恢复后按项目原有授权查看附件");
 assert.ok(!(await list()).rows.some(r=>r.id===m.id),"恢复后不再显示在废件箱");
 const again=await req("admin","POST","/api/recycle-bin/materials/"+m.id+"/restore",{});
 assert.equal(again.status,404,"重复恢复必须拒绝");
 const audit=await req("admin","GET","/api/audit?q="+encodeURIComponent("材料#"+m.id));
 assert.ok(audit.body.rows.some(a=>a.module==="废件箱"&&a.action==="恢复材料"),"恢复要记录审计");
});

test("未签署合同删除后可与原件联动恢复，但只能恢复草稿，不能复活已撤销审批",async()=>{
 const up=await upload("废弃的待签署合同.pdf");
 const newC=await req("exec","POST","/api/contracts",{
  pid:PID,name:"废件箱待签署合同",vendor:"合同测试供应商",amount:1245,
  category:"会务需求",status:"草稿",file_key:up.key,file_name:up.name,
  file_size:up.size,file_mime:up.mime});
 assert.equal(newC.status,200,JSON.stringify(newC.body));const id=newC.body.contract.id;
 const submitted=await req("exec","POST","/api/contracts/"+id+"/transition",{action:"submit"});
 assert.equal(submitted.status,200);
 const detail=await req("admin","GET","/api/projects/"+PID);
 const mat=detail.body.materials.find(m=>m.file_key===up.key);
 assert.ok(mat);
 const deleted=await req("exec","DELETE","/api/materials/"+mat.id);
 assert.equal(deleted.status,200,JSON.stringify(deleted.body));
 assert.ok(!(await req("admin","GET","/api/contracts?pid="+PID)).body.rows.some(c=>c.id===id));
 const restored=await req("admin","POST","/api/recycle-bin/materials/"+mat.id+"/restore",{});
 assert.equal(restored.status,200,JSON.stringify(restored.body));
 assert.equal(restored.body.linkedContract,id);
 const r=(await req("admin","GET","/api/contracts?pid="+PID)).body.rows.find(c=>c.id===id);
 assert.ok(r);
 assert.equal(r.status,"草稿");
 const approvs=await req("admin","GET","/api/approvals?type="+encodeURIComponent("合同审批"));
 assert.ok(!approvs.body.rows.some(a=>a.ref_id===id&&a.status==="待审批"),"旧审批不可自动复活");
 assert.equal((await file("exec",up.key)).status,200);
});

test("项目结算或归档后拒绝原路恢复，避免绕开冻结；原件仍可由管理员查看",async()=>{
 const {m,up}=await material("已冻结的删除资料.pdf");
 assert.equal((await req("exec","DELETE","/api/materials/"+m.id)).status,200);
 sql(db=>db.prepare("UPDATE projects SET status='已归档' WHERE id=?").run(PID));
 const locked=await req("admin","POST","/api/recycle-bin/materials/"+m.id+"/restore",{});
 assert.equal(locked.status,409,JSON.stringify(locked.body));
 assert.equal(locked.body.error.code,"RECYCLE_PROJECT_FROZEN");
 assert.ok((await list()).rows.some(x=>x.id===m.id));
 assert.equal((await file("admin",up.key)).status,200);
 sql(db=>db.prepare("UPDATE projects SET status='筹备中' WHERE id=?").run(PID));
});

test("合同更正的历史原件不进入废件箱，不能擅自恢复；缺失字节不能伪恢复",async()=>{
 const {m}=await material("历史版本由更正流程保留.pdf");
 sql(db=>db.prepare("UPDATE materials SET kind='合同',deleted_at='2026-11-24 12:00',deleted_by='合同更正版本归档' WHERE id=?").run(m.id));
 assert.ok(!(await list("历史版本由更正流程保留")).rows.some(x=>x.id===m.id));
 const deny=await req("admin","POST","/api/recycle-bin/materials/"+m.id+"/restore",{});
 assert.equal(deny.status,404);
 const {m:lost,up}=await material("文件字节丢失不能复原.pdf");
 assert.equal((await req("exec","DELETE","/api/materials/"+lost.id)).status,200);
 // 模拟后端物理对象丢失，而不是简单丢掉业务记录。
 const filePath=path.join(UP,up.key.slice(0,2),up.key);
 fs.rmSync(filePath,{force:true});
 const denied=await req("admin","POST","/api/recycle-bin/materials/"+lost.id+"/restore",{});
 assert.equal(denied.status,409,JSON.stringify(denied.body));
 assert.equal(denied.body.error.code,"RECYCLE_FILE_MISSING");
 assert.ok((await list()).rows.some(x=>x.id===lost.id));
});
