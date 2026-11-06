"use strict";
/** 2026-11 会务材料自由类目改造：废止固定八类，生产环境任何一份真实附件即可推进。 */
const {test,before,after}=require("node:test");
const assert=require("node:assert/strict");
const {spawn}=require("node:child_process");
const fs=require("node:fs"),path=require("node:path");
const PORT=8828,BASE="http://127.0.0.1:"+PORT;
const DB=path.join(__dirname,"..","data","test28.db");
const UP=path.join(__dirname,"..","data","test28-uploads");
const PDF=Buffer.from("%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF\n");
let proc,cookie,admin,pid,rightsId;
async function ready(){
  for(let i=0;i<180;i++){
    try{if((await fetch(BASE+"/api/health")).ok)return;}catch{}
    await new Promise(r=>setTimeout(r,160));
  }
  throw Error("material flexible server not ready");
}
async function api(method,route,body){
  const r=await fetch(BASE+route,{method,headers:{cookie,"content-type":"application/json"},
    body:body===undefined?undefined:JSON.stringify(body)});
  return {status:r.status,data:await r.json()};
}
async function upload(name){
  const r=await fetch(BASE+"/api/uploads?pid="+encodeURIComponent(pid),{
    method:"POST",headers:{cookie,"content-type":"application/pdf","x-file-name":encodeURIComponent(name)},body:PDF
  });
  return {status:r.status,data:await r.json()};
}
before(async()=>{
  for(const suffix of ["","-wal","-shm"])fs.rmSync(DB+suffix,{force:true});
  fs.rmSync(UP,{recursive:true,force:true});
  proc=spawn(process.execPath,["--experimental-sqlite","server/index.js"],{
    cwd:path.join(__dirname,".."),
    env:{...process.env,ERP_DEMO_MODE:"0",NODE_ENV:"test",ERP_SMS_PROVIDER:"test",ERP_SMS_TEST_MODE:"1",ERP_BOOTSTRAP_ADMIN_PHONE:"13800138000",ERP_PORT:String(PORT),ERP_DB:DB,ERP_UPLOAD_DIR:UP},
    stdio:["ignore","pipe","pipe"]
  });
  proc.stderr.on("data",b=>{if(!String(b).includes("ExperimentalWarning"))process.stderr.write(String(b));});
  await ready();
  const login=await fetch(BASE+"/api/auth/login",{method:"POST",
    headers:{"content-type":"application/json"},body:JSON.stringify({username:"admin",password:"123456"})});
  assert.equal(login.status,200);
  cookie=login.headers.get("set-cookie").split(";")[0];
  admin=api;
  const created=await admin("POST","/api/projects",{
    name:"灵活材料归档测试",assoc:"华东医学会",form:"线下",date:"2027-12-12",budget:30000,
    people:30,owner:"王敏",agenda:"09:00 开幕并进行专家交流"
  });
  assert.equal(created.status,200,JSON.stringify(created.data));
  pid=created.data.project.id;
  for(const action of ["submit","approve","prep","exec"]){
    const r=await admin("POST","/api/projects/"+pid+"/transition",{action});
    assert.equal(r.status,200,action+": "+JSON.stringify(r.data));
  }
});
after(()=>{proc?.kill("SIGTERM");fs.rmSync(UP,{recursive:true,force:true});});

test("新建项目没有材料时仍阻止推进，但不要求任何指定类别",async()=>{
  const d=await admin("GET","/api/projects/"+pid);
  assert.equal(d.status,200);
  assert.deepEqual(d.data.materialsStatus.required,[]);
  assert.equal(d.data.materialsStatus.uploadedCount,0);
  assert.equal(d.data.materialsStatus.ok,false);
  assert.ok(d.data.actions.find(x=>x.action==="request_verify"&&!x.enabled));
  const r=await admin("POST","/api/projects/"+pid+"/transition",{action:"request_verify"});
  assert.equal(r.status,409);
  assert.equal(r.data.error.code,"MATERIAL_GATE");
  assert.match(r.data.error.message,/至少一份/);
});

test("只登记文字不上传附件，不应冒充有效归档材料",async()=>{
  const r=await admin("POST","/api/projects/"+pid+"/materials",{kind:"自选项目材料",name:"只有名称没有原件"});
  assert.equal(r.status,200);
  const d=await admin("GET","/api/projects/"+pid);
  assert.equal(d.data.materialsStatus.count,1);
  assert.equal(d.data.materialsStatus.uploadedCount,0);
  assert.equal(d.data.materialsStatus.ok,false);
  assert.equal((await admin("POST","/api/projects/"+pid+"/transition",{action:"request_verify"})).status,409);
});

test("任意权益照片类目含上传原件后，即可推进核销，无需其他七类",async()=>{
  const up=await upload("权益照片-展示点位.pdf");
  assert.equal(up.status,200,JSON.stringify(up.data));
  const saved=await admin("POST","/api/projects/"+pid+"/materials",{
    kind:"权益照片",name:"展位权益照片",file_key:up.data.key,
    file_name:up.data.name,file_size:up.data.size,file_mime:up.data.mime
  });
  assert.equal(saved.status,200,JSON.stringify(saved.data));
  const d=await admin("GET","/api/projects/"+pid);
  rightsId=d.data.materials.find(x=>x.kind==="权益照片").id;
  assert.ok(rightsId);
  assert.deepEqual(d.data.materialsStatus.required,[]);
  assert.deepEqual(d.data.materialsStatus.missing,[]);
  assert.equal(d.data.materialsStatus.uploadedCount,1);
  assert.equal(d.data.materialsStatus.ok,true);
  assert.ok(d.data.actions.find(x=>x.action==="request_verify"&&x.enabled));
  const projects=await admin("GET","/api/materials");
  assert.ok(projects.data.kinds.includes("权益照片"),"材料中心应提供权益照片选项");
  assert.ok(projects.data.projects.find(x=>x.id===pid && x.ok && x.uploadedCount===1));
  const advance=await admin("POST","/api/projects/"+pid+"/transition",{action:"request_verify"});
  assert.equal(advance.status,200,JSON.stringify(advance.data));
  assert.equal(advance.data.project.status,"待核销");
  const verify=await admin("GET","/api/projects/"+pid+"/verify");
  assert.deepEqual(verify.data.materialsStatus,d.data.materialsStatus,"项目详情与核销状态同源");
});

test("如果唯一真实附件被删除，后续核销判定仍检查至少一份附件",async()=>{
  const deleted=await admin("DELETE","/api/materials/"+rightsId);
  assert.equal(deleted.status,200,JSON.stringify(deleted.data));
  const detail=await admin("GET","/api/projects/"+pid);
  assert.equal(detail.data.materialsStatus.ok,false);
  const bad=await admin("POST","/api/projects/"+pid+"/verify/steps/1",
    {result:"不通过",remark:"签到数据尚未确认"});
  assert.equal(bad.status,409);
  assert.equal(bad.data.error.code,"MATERIAL_GATE");
});

test("补传任意自定义类别（无需固定类目），六步流程仍按人工核销顺序判定",async()=>{
  const up=await upload("会场随手资料.pdf");
  assert.equal(up.status,200);
  const add=await admin("POST","/api/projects/"+pid+"/materials",{
    kind:"自定义摄影纪要",name:"自由类别照片资料",file_key:up.data.key,
    file_name:up.data.name,file_size:up.data.size,file_mime:up.data.mime});
  assert.equal(add.status,200,JSON.stringify(add.data));
  const detail=await admin("GET","/api/projects/"+pid);
  assert.equal(detail.data.materialsStatus.ok,true);
  assert.equal(detail.data.materialsStatus.uploadedCount,1);
  assert.deepEqual(detail.data.materialsStatus.required,[]);
  const judge=await admin("POST","/api/projects/"+pid+"/verify/steps/1",{
    result:"不通过",remark:"资料需要人工复核"});
  assert.equal(judge.status,200,JSON.stringify(judge.data));
  // 这里只解除固定八类材料门槛；合同、票据、核销六步独立规则不做越权放行。
  const premature=await admin("POST","/api/projects/"+pid+"/transition",{action:"verify_pass"});
  assert.equal(premature.status,409);
  assert.notEqual(premature.data.error.code,"MATERIAL_GATE");
});
