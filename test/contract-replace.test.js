"use strict";
/** 合同签署复核窗口：上传新原件、删除旧文件、归档材料同步、权限和冻结回归。 */
const {test,before,after}=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs"),path=require("node:path");
const {spawn}=require("node:child_process");
const PORT=8979,BASE="http://127.0.0.1:"+PORT;
const DB=path.join(__dirname,"..","data","test-contract-replace.db");
const UP=path.join(__dirname,"..","data","test-contract-replace-uploads");
const PID="MP-2026-001";
const PDF1=Buffer.from("%PDF-1.4\n1 0 obj\n<< /Type /Catalog /Version (original) >>\nendobj\n%%EOF\n");
const PDF2=Buffer.from("%PDF-1.4\n1 0 obj\n<< /Type /Catalog /Version (replacement) >>\nendobj\n%%EOF\n");
let processServer,users={},cid,firstKey,secondKey;
async function waitReady(){
  for(let i=0;i<400;i++){
    try{if((await fetch(BASE+"/api/health")).ok)return;}catch{}
    await new Promise(resolve=>setTimeout(resolve,150));
  }
  throw Error("contract replacement test server unavailable");
}
async function login(username){
  const r=await fetch(BASE+"/api/auth/login",{method:"POST",
    headers:{"content-type":"application/json"},
    body:JSON.stringify({username,password:"123456"})});
  assert.equal(r.status,200,"login "+username);
  return r.headers.get("set-cookie").split(";")[0];
}
async function req(username,method,url,data){
  const r=await fetch(BASE+url,{method,
    headers:{cookie:users[username],"content-type":"application/json"},
    body:data===undefined?undefined:JSON.stringify(data)});
  return {status:r.status,data:await r.json()};
}
async function upload(username,buf,name,pid=PID,mime="application/pdf"){
  const r=await fetch(BASE+"/api/uploads?pid="+encodeURIComponent(pid),{
    method:"POST",headers:{cookie:users[username],"content-type":mime,
      "x-file-name":encodeURIComponent(name)},body:buf});
  return {status:r.status,data:await r.json()};
}
function filePath(key){return path.join(UP,key.slice(0,2),key);}
async function contract(){
  const r=await req("admin","GET","/api/contracts?pid="+PID);
  assert.equal(r.status,200);
  const found=r.data.rows.find(x=>x.id===cid);
  assert.ok(found);
  return found;
}
before(async()=>{
  for(const suffix of ["","-wal","-shm"])fs.rmSync(DB+suffix,{force:true});
  fs.rmSync(UP,{recursive:true,force:true});
  processServer=spawn(process.execPath,["--experimental-sqlite","server/index.js"],{
    cwd:path.join(__dirname,".."),
    env:{...process.env,ERP_PORT:String(PORT),ERP_DB:DB,ERP_UPLOAD_DIR:UP},
    stdio:["ignore","pipe","pipe"]
  });
  processServer.stderr.on("data",chunk=>{
    const line=String(chunk);
    if(!line.includes("ExperimentalWarning"))process.stderr.write(line);
  });
  await waitReady();
  for(const name of ["admin","assoc","exec","finance","guest"])users[name]=await login(name);
});
after(()=>{
  processServer?.kill("SIGTERM");
  fs.rmSync(UP,{recursive:true,force:true});
});

test("创建待签署合同，并自动在归档材料建立同一原件引用",async()=>{
  const first=await upload("exec",PDF1,"原合同.pdf");
  assert.equal(first.status,200,JSON.stringify(first.data));
  firstKey=first.data.key;
  const add=await req("exec","POST","/api/contracts",{
    pid:PID,name:"签署前替换测试",vendor:"广州会务公司",amount:1234.56,status:"草稿",
    file_key:firstKey,file_name:first.data.name,file_size:first.data.size,file_mime:first.data.mime
  });
  assert.equal(add.status,200,JSON.stringify(add.data));
  cid=add.data.contract.id;
  const pending=await req("exec","POST","/api/contracts/"+cid+"/transition",{action:"submit"});
  assert.equal(pending.status,200,JSON.stringify(pending.data));
  assert.equal(pending.data.contract.status,"待签署");
  const detail=await req("admin","GET","/api/projects/"+PID);
  assert.equal(detail.status,200);
  assert.ok(detail.data.materials.some(m=>m.kind==="合同" && m.file_key===firstKey));
  assert.ok(fs.existsSync(filePath(firstKey)));
});

test("更新接口必须由协会管理员审批，非法附件或其他项目附件不能覆盖原文件",async()=>{
  const replace=await upload("assoc",PDF2,"新合同.pdf");
  assert.equal(replace.status,200);
  secondKey=replace.data.key;
  for(const role of ["exec","finance","guest"]){
    const r=await req(role,"POST","/api/contracts/"+cid+"/replace-file",{file_key:secondKey,file_name:"越权.pdf"});
    assert.equal(r.status,403,JSON.stringify({role,data:r.data}));
  }
  const invalid=await req("assoc","POST","/api/contracts/"+cid+"/replace-file",
    {file_key:"../../etc/passwd",file_name:"evil"});
  assert.equal(invalid.status,400);
  const unrelated=await upload("admin",PDF2,"跨项目附件.pdf","MP-2026-003");
  assert.equal(unrelated.status,200);
  const cross=await req("admin","POST","/api/contracts/"+cid+"/replace-file",
    {file_key:unrelated.data.key,file_name:unrelated.data.name});
  assert.equal(cross.status,403);
  assert.equal((await contract()).file_key,firstKey);
  assert.ok(fs.existsSync(filePath(firstKey)),"拒绝更新不能误删旧合同");
});

test("替换更新两个关联记录并删除旧字节与登记，但仍待人工确认签署",async()=>{
  const result=await req("assoc","POST","/api/contracts/"+cid+"/replace-file",
    {file_key:secondKey,file_name:"新合同-盖章版.pdf"});
  assert.equal(result.status,200,JSON.stringify(result.data));
  assert.equal(result.data.replaced,true);
  assert.equal(result.data.oldDeleted,true);
  assert.equal(result.data.contract.status,"待签署","更新合同不能自动签署");
  assert.equal(result.data.contract.sign_date,"");
  assert.equal(result.data.contract.file_key,secondKey);
  assert.equal(result.data.contract.file_mime,"application/pdf");
  assert.equal(result.data.contract.file_size,PDF2.length);
  assert.equal(result.data.contract.file_name,"新合同-盖章版.pdf");
  assert.equal((await contract()).file_key,secondKey);
  const detail=await req("admin","GET","/api/projects/"+PID);
  const materials=detail.data.materials.filter(m=>m.kind==="合同" && m.name.includes(cid));
  assert.ok(materials.some(x=>x.file_key===secondKey && x.file_name==="新合同-盖章版.pdf"));
  assert.ok(!detail.data.materials.some(m=>m.file_key===firstKey),
    "旧版合同不应仍在归档材料里");
  assert.equal(fs.existsSync(filePath(firstKey)),false,"旧文件应从本地对象存储物理删除");
  assert.ok(fs.existsSync(filePath(secondKey)));
  const old=await req("admin","GET","/api/uploads/"+firstKey);
  assert.equal(old.status,404,"旧文件上传登记应删除，不可再下载");
  const file=await fetch(BASE+"/api/uploads/"+secondKey,{headers:{cookie:users.admin}});
  assert.equal(file.status,200);
  assert.deepEqual(Buffer.from(await file.arrayBuffer()),PDF2);
  const logs=await req("admin","GET","/api/audit?q="+encodeURIComponent(PID));
  assert.equal(logs.status,200);
  assert.ok(logs.data.rows.some(x=>x.action==="更新合同原件"&&x.detail.includes(cid)));
});

test("已替换原件不可被重复挂接，仍需独立确认签署后才成为已签署",async()=>{
  const repeat=await req("assoc","POST","/api/contracts/"+cid+"/replace-file",
    {file_key:secondKey,file_name:"重复使用.pdf"});
  assert.notEqual(repeat.status,200);
  const sign=await req("assoc","POST","/api/contracts/"+cid+"/transition",{action:"sign"});
  assert.equal(sign.status,200,JSON.stringify(sign.data));
  assert.equal(sign.data.contract.status,"已签署");
  assert.equal(sign.data.contract.file_key,secondKey);
  const next=await upload("assoc",PDF1,"签署后尝试更新.pdf");
  const forbidden=await req("assoc","POST","/api/contracts/"+cid+"/replace-file",
    {file_key:next.data.key,file_name:next.data.name});
  assert.equal(forbidden.status,409);
  assert.equal((await contract()).file_key,secondKey);
});

test("没有旧附件的待签署合同可补传并自动同步到归档材料",async()=>{
  const add=await req("exec","POST","/api/contracts",{
    pid:PID,name:"无原件补传测试",vendor:"测试供应商",amount:800,status:"草稿"
  });
  assert.equal(add.status,200);
  const id=add.data.contract.id;
  assert.equal((await req("exec","POST","/api/contracts/"+id+"/transition",{action:"submit"})).status,200);
  const {defaultWordTemplate}=require("../server/lib/project-notice");
  const document=defaultWordTemplate();
  const up=await upload("assoc",document,"正式合同.docx",PID,
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
  assert.equal(up.status,200,JSON.stringify(up.data));
  const replaced=await req("assoc","POST","/api/contracts/"+id+"/replace-file",
    {file_key:up.data.key,file_name:up.data.name});
  assert.equal(replaced.status,200,JSON.stringify(replaced.data));
  assert.equal(replaced.data.contract.file_mime,"application/vnd.openxmlformats-officedocument.wordprocessingml.document");
  assert.equal(replaced.data.contract.status,"待签署");
  const detail=await req("admin","GET","/api/projects/"+PID);
  assert.ok(detail.data.materials.some(m=>m.kind==="合同"&&m.file_key===up.data.key),
    "原来没有附件的合同应该补齐归档材料");
});

test("已结算项目一律禁止更新旧合同，不能删除或覆盖文件",async()=>{
  const up=await upload("admin",PDF1,"封存后不可替换.pdf","MP-2026-006");
  assert.equal(up.status,200);
  const list=await req("admin","GET","/api/contracts?pid=MP-2026-006");
  assert.equal(list.status,200);
  assert.ok(list.data.rows.length>0);
  const row=list.data.rows[0];
  const before=row.file_key;
  const r=await req("admin","POST","/api/contracts/"+row.id+"/replace-file",
    {file_key:up.data.key,file_name:up.data.name});
  assert.equal(r.status,409);
  const after=await req("admin","GET","/api/contracts?pid=MP-2026-006");
  assert.equal(after.data.rows[0].file_key,before);
});
