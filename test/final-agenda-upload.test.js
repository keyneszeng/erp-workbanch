"use strict";
/** 终版议程：只需登记类别并上传一份原件，自动确认为终版，不生成讲者/课题待办。 */
const {test,before,after}=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs"),path=require("node:path");
const {spawn}=require("node:child_process");
const PORT=8984,BASE="http://127.0.0.1:"+PORT,PID="MP-2026-001";
const DB=path.join(__dirname,"..","data","test-final-agenda.db");
const DIR=path.join(__dirname,"..","data","test-final-agenda-uploads");
let proc,cookie;
async function waitReady(){
  for(let i=0;i<160;i++){
    try{if((await fetch(BASE+"/api/health")).ok)return;}catch{}
    await new Promise(r=>setTimeout(r,140));
  }
  throw Error("final agenda test ERP did not start");
}
async function api(method,route,data){
  const r=await fetch(BASE+route,{method,headers:{cookie,"content-type":"application/json"},
    body:data===undefined?undefined:JSON.stringify(data)});
  return {status:r.status,data:await r.json()};
}
async function upload(name,variant){
  const bytes=Buffer.from("%PDF-1.4\n1 0 obj\n<< /Type /Catalog /Subject ("+variant+") >>\nendobj\n%%EOF\n");
  const r=await fetch(BASE+"/api/uploads?pid="+PID,{method:"POST",
    headers:{cookie,"content-type":"application/pdf","x-file-name":encodeURIComponent(name)},body:bytes});
  return {status:r.status,data:await r.json(),bytes};
}
before(async()=>{
  for(const suffix of ["","-wal","-shm"])fs.rmSync(DB+suffix,{force:true});
  fs.rmSync(DIR,{force:true,recursive:true});
  proc=spawn(process.execPath,["--experimental-sqlite","server/index.js"],{
    cwd:path.join(__dirname,".."),
    env:{...process.env,ERP_DEMO_MODE:"1",ERP_DB:DB,ERP_PORT:String(PORT),ERP_UPLOAD_DIR:DIR},
    stdio:["ignore","pipe","pipe"]
  });
  proc.stderr.on("data",b=>{if(!String(b).includes("ExperimentalWarning"))process.stderr.write(String(b))});
  await waitReady();
  const r=await fetch(BASE+"/api/auth/login",{method:"POST",headers:{"content-type":"application/json"},
    body:JSON.stringify({username:"admin",password:"123456"})});
  assert.equal(r.status,200);
  cookie=r.headers.get("set-cookie").split(";")[0];
});
after(()=>{
  proc?.kill("SIGTERM");
  fs.rmSync(DIR,{force:true,recursive:true});
});
test("归档材料旧终版议程模块已移除，登记表单保留一键确认入口",()=>{
  const source=fs.readFileSync(path.join(__dirname,"..","web","assets","js","pages","materials.js"),"utf8");
  const app=fs.readFileSync(path.join(__dirname,"..","web","assets","js","app.js"),"utf8");
  assert.ok(source.includes('"终版议程"'),"终版议程应存在于登记材料类别列表");
  assert.ok(source.includes('确定终版议程'),"选择类别后按钮应改为明确确认");
  assert.ok(source.includes("picker.multiple=!final"),"终版议程每次仅允许一份附件");
  assert.ok(!fs.existsSync(path.join(__dirname,"..","web","assets","js","lib","material-workbench.js")),
    "旧的终版议程材料模块及待办板块应从前端移除");
  assert.ok(!app.includes("归档必备 8 类材料"),"路由不能再出现旧强制文案");
});

test("终版议程必须上传原件；不能仅用文字假确认",async()=>{
  const invalid=await api("POST","/api/projects/"+PID+"/materials",
    {kind:"终版议程",name:"没有附件的终版议程",version:"终版"});
  assert.equal(invalid.status,400,JSON.stringify(invalid.data));
  assert.match(invalid.data.error.message,/必须上传/);
  const r=await api("GET","/api/materials");
  assert.equal(r.status,200);
  assert.ok(r.data.kinds.includes("终版议程"),"终版议程必须是登记材料的内置类别");
});

test("只上传终版议程，自动命名并标记终版，不需要人工讲者、课题、待办生成",async()=>{
  const original=await upload("2026年会议最终议程.pdf","final-v1");
  assert.equal(original.status,200,JSON.stringify(original.data));
  const before=await api("GET","/api/projects/"+PID+"/material-workbench");
  assert.equal(before.status,200);
  const created=await api("POST","/api/projects/"+PID+"/materials",{
    kind:"终版议程",file_key:original.data.key,file_name:original.data.name,
    file_size:original.data.size,file_mime:original.data.mime
  });
  assert.equal(created.status,200,JSON.stringify(created.data));
  assert.equal(created.data.finalAgendaConfirmed,true);
  assert.match(created.data.message,/已上传并确认/);
  const d=await api("GET","/api/projects/"+PID);
  assert.equal(d.status,200);
  const row=d.data.materials.find(m=>m.kind==="终版议程"&&m.file_key===original.data.key);
  assert.ok(row,"终版议程需归档到普通材料列表");
  assert.equal(row.version,"终版");
  assert.equal(row.name,"2026年会议最终议程.pdf");
  const after=await api("GET","/api/projects/"+PID+"/material-workbench");
  assert.equal(after.status,200);
  assert.deepEqual(after.data.tasks,before.data.tasks,"不应因为上传议程自动生成课件或其他待办");
  const downloaded=await fetch(BASE+"/api/uploads/"+original.data.key,{headers:{cookie}});
  assert.equal(downloaded.status,200);
  assert.deepEqual(Buffer.from(await downloaded.arrayBuffer()),original.bytes);
});

test("重新上传新终版后旧版自动降为历史，原件不丢失，旧流程不重新触发",async()=>{
  const next=await upload("新修订终版议程.pdf","final-v2");
  assert.equal(next.status,200);
  const updated=await api("POST","/api/projects/"+PID+"/materials",{
    kind:"终版议程",name:"客户端可随意传递的名称",version:"v1",
    file_key:next.data.key,file_name:next.data.name,file_size:next.data.size,file_mime:next.data.mime
  });
  assert.equal(updated.status,200,JSON.stringify(updated.data));
  assert.equal(updated.data.finalAgendaConfirmed,true);
  const d=await api("GET","/api/projects/"+PID);
  const rows=d.data.materials.filter(m=>m.kind==="终版议程"&&!m.deleted_at);
  assert.equal(rows.length,2);
  const latest=rows.find(m=>m.file_key===next.data.key),old=rows.find(m=>m.file_key!==next.data.key);
  assert.equal(latest.version,"终版");
  assert.equal(latest.name,"新修订终版议程.pdf");
  assert.equal(old.version,"历史版");
  assert.equal(rows.filter(x=>x.version==="终版").length,1);
  const original=await fetch(BASE+"/api/uploads/"+old.file_key,{headers:{cookie}});
  assert.equal(original.status,200,"旧版议程作为审计历史仍可下载");
});

test("其他类别材料仍遵循原来的必填名称规则，不被终版简化影响",async()=>{
  const invalid=await api("POST","/api/projects/"+PID+"/materials",{kind:"签到表"});
  assert.equal(invalid.status,400);
  const ordinary=await api("POST","/api/projects/"+PID+"/materials",
    {kind:"现场照片",name:"现场旧档案"});
  assert.equal(ordinary.status,200);
  assert.equal(ordinary.data.finalAgendaConfirmed,false);
});
