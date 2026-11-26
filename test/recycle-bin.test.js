"use strict";
/** 废件箱集成测试：仅总管理员，下载隔离，原地恢复，合同回滚审批安全，冻结及旧版本拦截。 */
const {test,before,after}=require("node:test");
const assert=require("node:assert/strict");
const {spawn,spawnSync}=require("node:child_process");
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
 const denied=await req("guest","DELETE","/api/contracts/"+id);
 assert.equal(denied.status,403);
 const deleted=await req("exec","DELETE","/api/contracts/"+id);
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

test("已签署合同可由管理员软删，执行人员及归档项目仍受保护",async()=>{
 const up=await upload("已签署误录合同.pdf");
 const made=await req("exec","POST","/api/contracts",{
  pid:PID,name:"已签署误录合同",vendor:"测试供应商",amount:100,
  category:"会务需求",status:"草稿",file_key:up.key,file_name:up.name,file_size:up.size,file_mime:up.mime
 });
 assert.equal(made.status,200,JSON.stringify(made.body));
 const id=made.body.contract.id;
 const submitted=await req("exec","POST","/api/contracts/"+id+"/transition",{action:"submit"});
 assert.equal(submitted.status,200,JSON.stringify(submitted.body));
 const mat=(await req("admin","GET","/api/projects/"+PID)).body.materials.find(x=>x.file_key===up.key);
 assert.ok(mat);
 sql(db=>{
  db.prepare("UPDATE contracts SET status='已签署',sign_date='2026-11-26' WHERE id=?").run(id);
  db.prepare("UPDATE approvals SET status='已通过' WHERE ref_id=? AND type='合同审批'").run(id);
 });
 const denied=await req("exec","DELETE","/api/contracts/"+id);
 assert.equal(denied.status,403);
 sql(db=>db.prepare("UPDATE projects SET status='已归档' WHERE id=?").run(PID));
 try{
  assert.equal((await req("admin","DELETE","/api/contracts/"+id)).status,409);
 }finally{sql(db=>db.prepare("UPDATE projects SET status='筹备中' WHERE id=?").run(PID));}
 const result=await req("admin","DELETE","/api/contracts/"+id);
 assert.equal(result.status,200,JSON.stringify(result.body));
 const deleted=sql(db=>db.prepare("SELECT deleted_at,status FROM contracts WHERE id=?").get(id));
 assert.ok(deleted.deleted_at);
 assert.equal(deleted.status,"已签署","软删保留原签署状态");
 assert.ok(!(await req("admin","GET","/api/contracts?pid="+PID)).body.rows.some(c=>c.id===id));
 assert.ok((await list("已签署误录合同")).rows.some(x=>x.id===mat.id));
 assert.equal((await file("admin",up.key)).status,200);
 const restored=await req("admin","POST","/api/recycle-bin/materials/"+mat.id+"/restore",{});
 assert.equal(restored.status,200,JSON.stringify(restored.body));
 const restoredContract=sql(db=>db.prepare("SELECT status,sign_date,deleted_at FROM contracts WHERE id=?").get(id));
 assert.equal(restoredContract.status,"草稿");
 assert.equal(restoredContract.sign_date,"");
 assert.equal(restoredContract.deleted_at,null);
 const history=sql(db=>db.prepare("SELECT status FROM approvals WHERE ref_id=? AND type='合同审批'").all(id));
 assert.ok(history.some(x=>x.status==="已通过"),"已完成审批保留历史");
 assert.ok(!history.some(x=>x.status==="待审批"),"旧审批不可自动复活");
});
test("无附件草稿仍可直接软删除",async()=>{
 const made=await req("exec","POST","/api/contracts",{
  pid:PID,name:"无附件误录合同",vendor:"测试供应商",amount:100,
  category:"会务需求",status:"草稿"
 });
 assert.equal(made.status,200,JSON.stringify(made.body));
 const id=made.body.contract.id;
 const result=await req("exec","DELETE","/api/contracts/"+id);
 assert.equal(result.status,200,JSON.stringify(result.body));
 assert.ok(sql(db=>db.prepare("SELECT deleted_at FROM contracts WHERE id=?").get(id)).deleted_at);
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

test("删除普通材料后清除核销步骤、待办和例外证据，原件只在废件箱",async()=>{
 const {m,up}=await material("待解绑的会议通知.pdf","会议通知");
 const exId="EX-DELETE-"+m.id;
 sql(db=>{
  db.prepare("INSERT INTO verify_steps(pid,step_no,name,result,remark,evidence_json) "+
    "VALUES (?,1,'盖章函件与串场核验','通过','旧人工核验',?) "+
    "ON CONFLICT(pid,step_no) DO UPDATE SET result='通过',remark=excluded.remark,evidence_json=excluded.evidence_json")
    .run(PID,JSON.stringify({sources:[{materialId:m.id,fileKey:up.key}]}));
  db.prepare("INSERT INTO meeting_material_tasks(pid,kind,speaker,topic,status,material_id,updated_at,updated_by) "+
    "VALUES (?,?,?,?,'比对通过',?,?,?)")
    .run(PID,"课件","删除证据测试-"+m.id,"证据隔离",m.id,"2026-11-25","测试");
  db.prepare("INSERT INTO exceptions(id,pid,step_no,reason,status,created_by,created_at,evidence_material_id,resolution,resolved_at,resolved_by) "+
    "VALUES (?,?,1,'测试删除证据关联','待复核','测试','2026-11-25',?,'已提供原件','2026-11-25','测试')")
    .run(exId,PID,m.id);
 });
 const del=await req("exec","DELETE","/api/materials/"+m.id);
 assert.equal(del.status,200,JSON.stringify(del.body));
 assert.ok(del.body.resetSteps.includes(1),"原核销通过步骤失效");
 const detail=await req("admin","GET","/api/projects/"+PID);
 assert.ok(!detail.body.materials.some(x=>x.id===m.id),"项目材料清单立即移除已删记录");
 const catalog=await req("admin","GET","/api/materials?pid="+PID);
 assert.ok(!catalog.body.rows.some(x=>x.id===m.id),"材料目录不再呈现已删除附件");
 const verify=await req("admin","GET","/api/projects/"+PID+"/verify");
 assert.ok(!verify.body.materials.some(x=>x.id===m.id),"核销有效材料池不再包含已删除原件");
 const step=verify.body.verification.steps.find(x=>x.no===1);
 assert.equal(step.result,"待判定");
 sql(db=>{
  const saved=db.prepare("SELECT result,evidence_json FROM verify_steps WHERE pid=? AND step_no=1").get(PID);
  assert.equal(saved.result,"待判定");
  assert.equal(saved.evidence_json,null);
  const task=db.prepare("SELECT material_id,status FROM meeting_material_tasks WHERE pid=? AND speaker=?")
    .get(PID,"删除证据测试-"+m.id);
  assert.equal(task.material_id,null);
  assert.equal(task.status,"未提交");
  const exception=db.prepare("SELECT evidence_material_id,resolved_at FROM exceptions WHERE id=?").get(exId);
  assert.equal(exception.evidence_material_id,null);
  assert.equal(exception.resolved_at,null);
 });
 assert.ok((await list("待解绑的会议通知")).rows.some(x=>x.id===m.id),"原件只在废件箱管理");
});

test("删除未签署合同同步软删所有同原件合同材料并撤销第5/6步核销证据",async()=>{
 const up=await upload("已删除合同不应继续核销.pdf");
 const created=await req("exec","POST","/api/contracts",{
  pid:PID,name:"删除关联核销的会务合同",vendor:"供应商测试",amount:1500,
  category:"会务需求",status:"草稿",file_key:up.key,file_name:up.name,
  file_size:up.size,file_mime:up.mime
 });
 assert.equal(created.status,200,JSON.stringify(created.body));
 const cid=created.body.contract.id;
 const detail=await req("admin","GET","/api/projects/"+PID);
 const original=detail.body.materials.find(x=>x.file_key===up.key&&x.kind==="合同");
 assert.ok(original);
 const companion=sql(db=>{
  const extra=db.prepare("INSERT INTO materials(pid,kind,name,version,uploader,created_at,file_key,file_name) "+
    "VALUES (?,?,'同合同历史扫描件','v1','历史','2026-11-25',?,?)")
    .run(PID,"会务协议",up.key,up.name);
  for(const no of [5,6]){
   db.prepare("INSERT INTO verify_steps(pid,step_no,name,result,remark,evidence_json) VALUES (?,?,?,?,'旧原件已匹配',?) "+
     "ON CONFLICT(pid,step_no) DO UPDATE SET result=excluded.result,remark=excluded.remark,evidence_json=excluded.evidence_json")
    // 已通过第6步会锁定正式会务合同，不能借删除绕过更正流程。
    .run(PID,no,"历史核销-"+no,no===6?"不通过":"通过",
      JSON.stringify({sources:[{materialId:original.id,fileKey:up.key}]}));
  }
  return Number(extra.lastInsertRowid);
 });
 const deleted=await req("exec","DELETE","/api/materials/"+original.id);
 assert.equal(deleted.status,200,JSON.stringify(deleted.body));
 assert.equal(deleted.body.linkedContract,cid);
 assert.deepEqual(deleted.body.resetSteps.filter(x=>[5,6].includes(x)),[5,6]);
 assert.ok(deleted.body.removedMaterialIds.includes(companion));
 const contracts=await req("admin","GET","/api/contracts?pid="+PID);
 assert.ok(!contracts.body.rows.some(x=>x.id===cid),"合同台账不再出现已删除合同");
 for(const endpoint of ["/api/projects/"+PID,"/api/projects/"+PID+"/verify","/api/materials?pid="+PID]){
  const response=await req("admin","GET",endpoint);
  assert.equal(response.status,200,endpoint+" "+JSON.stringify(response.body));
  const materials=response.body.materials||response.body.rows||[];
  assert.ok(!materials.some(x=>x.file_key===up.key),"有效列表必须移除同文件合同附件："+endpoint);
 }
 const box=await list("已删除合同");
 assert.ok(box.rows.some(x=>x.id===original.id),"原合同材料在废件箱");
 assert.ok((await list("同合同历史扫描件")).rows.some(x=>x.id===companion),"关联历史扫描件同样进入废件箱");
 const verify=await req("admin","GET","/api/projects/"+PID+"/verify");
 for(const no of [5,6]){
  const row=sql(db=>db.prepare("SELECT result,evidence_json FROM verify_steps WHERE pid=? AND step_no=?").get(PID,no));
  assert.equal(row.result,"待判定","核销第"+no+"项不得沿用已删合同结论");
  assert.equal(row.evidence_json,null);
  assert.ok(!verify.body.verification.sourceMaterialIds?.laborContracts.includes(original.id));
  assert.ok(!verify.body.verification.sourceMaterialIds?.meetingAgreements.includes(companion));
 }
 // 总管理员从同批任意一份历史协议材料恢复，应恢复整组合同原件，
 // 但不会自动把旧核销结论从待判定恢复为通过。
 const restored=await req("admin","POST","/api/recycle-bin/materials/"+companion+"/restore",{});
 assert.equal(restored.status,200,JSON.stringify(restored.body));
 assert.equal(restored.body.linkedContract,cid);
 assert.ok(restored.body.restoredMaterialIds.includes(original.id));
 assert.ok(restored.body.restoredMaterialIds.includes(companion));
 const live=(await req("admin","GET","/api/projects/"+PID)).body;
 assert.ok(live.materials.some(x=>x.id===original.id));
 assert.ok(live.materials.some(x=>x.id===companion));
 const contract=(await req("admin","GET","/api/contracts?pid="+PID)).body.rows.find(x=>x.id===cid);
 assert.equal(contract?.status,"草稿","恢复的合同不能直接成为已签署状态");
 assert.ok(!(await list("同合同历史扫描件")).rows.some(x=>x.id===companion));
 const stale=sql(db=>db.prepare("SELECT result FROM verify_steps WHERE pid=? AND step_no=6").get(PID));
 assert.equal(stale.result,"待判定","恢复文件不应自动恢复旧核销结论");
});

test("历史删除合同残留的材料经迁移进入废件箱并失去旧核销引用",async()=>{
 const up=await upload("历史幽灵合同原件.pdf");
 const made=await req("exec","POST","/api/contracts",{
  pid:PID,name:"历史幽灵合同修复",vendor:"历史测试",amount:900,
  category:"会务需求",status:"草稿",file_key:up.key,file_name:up.name,
  file_size:up.size,file_mime:up.mime
 });
 assert.equal(made.status,200,JSON.stringify(made.body));
 const mat=(await req("admin","GET","/api/projects/"+PID)).body.materials.find(x=>x.file_key===up.key);
 assert.ok(mat);
 sql(db=>{
  db.prepare("UPDATE contracts SET deleted_at=?,deleted_by='历史删除' WHERE id=?")
    .run("2026-11-25 10:00",made.body.contract.id);
  db.prepare("INSERT INTO verify_steps(pid,step_no,name,result,evidence_json) VALUES (?,5,'专家劳务核销','通过',?) "+
    "ON CONFLICT(pid,step_no) DO UPDATE SET result='通过',evidence_json=excluded.evidence_json")
    .run(PID,JSON.stringify({sources:[{materialId:mat.id,fileKey:up.key}]}));
 });
 assert.ok((await req("admin","GET","/api/materials?pid="+PID)).body.rows.some(x=>x.id===mat.id),
   "模拟旧版问题：合同已删、材料仍未软删");
 const repair=spawnSync(process.execPath,["--experimental-sqlite","-e",
   "require('./server/lib/db').migrate();"],{
   cwd:root,env:{...process.env,ERP_DB:DB,ERP_DEMO_MODE:"1",ERP_UPLOAD_DIR:UP},
   timeout:20000,encoding:"utf8"
 });
 assert.equal(repair.status,0,repair.stderr||repair.stdout);
 assert.ok(!(await req("admin","GET","/api/materials?pid="+PID)).body.rows.some(x=>x.id===mat.id));
 assert.ok((await list("历史幽灵合同原件")).rows.some(x=>x.id===mat.id),
   "旧版遗留材料经过迁移后也应进废件箱");
 const raw=sql(db=>db.prepare("SELECT result,evidence_json FROM verify_steps WHERE pid=? AND step_no=5").get(PID));
 assert.equal(raw.result,"待判定");
 assert.equal(raw.evidence_json,null);
});
