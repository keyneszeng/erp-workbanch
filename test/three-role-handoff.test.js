"use strict";
/** Isolated three-role handoff regression: exec submits, admin approves, exec starts prep. */
const {test,before,after}=require("node:test");
const assert=require("node:assert/strict");
const {spawn}=require("node:child_process");
const fs=require("node:fs"),os=require("node:os"),path=require("node:path");
const dir=fs.mkdtempSync(path.join(os.tmpdir(),"erp-three-role-"));
const port=16100+(process.pid%800);
const BASE="http://127.0.0.1:"+port;
let child, admin, exec, finance;
async function request(method,url,body,cookie) {
  const res=await fetch(BASE+url,{
    method,headers:{"Content-Type":"application/json",...(cookie?{Cookie:cookie}:{})},
    body:body===undefined?undefined:JSON.stringify(body)
  });
  return {status:res.status,data:await res.json(),cookie:(res.headers.get("set-cookie")||"").split(";")[0]};
}
async function signIn(username) {
  const v=await request("POST","/api/auth/login",{username,password:"123456"});
  assert.equal(v.status,200,"无法登录演示角色 "+username);
  return v.cookie;
}
before(async()=>{
  child=spawn(process.execPath,["--experimental-sqlite","server/index.js"],{
    cwd:path.resolve(__dirname,".."),
    stdio:["ignore","pipe","pipe"],
    env:{...process.env,ERP_DEMO_MODE:"1",ERP_PORT:String(port),ERP_HOST:"127.0.0.1",
      ERP_DB:path.join(dir,"isolated.db"),ERP_UPLOAD_DIR:path.join(dir,"files")}
  });
  let err="";
  child.stderr.on("data",v=>err+=String(v));
  let ready=false;
  for(let i=0;i<600;i++){
    if(child.exitCode!==null)throw Error("QA server exited: "+err);
    try{const r=await request("GET","/api/health");if(r.status===200){ready=true;break;}}catch{}
    await new Promise(r=>setTimeout(r,100));
  }
  if(!ready)throw Error("QA server not ready: "+err);
  admin=await signIn("admin");
  exec=await signIn("exec");
  finance=await signIn("finance");
});
after(()=>{
  child?.kill("SIGTERM");
  fs.rmSync(dir,{recursive:true,force:true});
});
test("立项→总管理员审批→执行人待办→进入筹备，财务没有越权待办",async()=>{
  const execMe=await request("GET","/api/auth/me",undefined,exec);
  assert.equal(execMe.status,200);
  const name=execMe.data.user.name;
  const input={name:"QA三角色连贯性验证",assoc:"华东医学会",form:"线下",
    date:"2027-11-25",days:1,budget:10000,people:30,owner:name,agenda:"10:00 学术交流"};
  const created=await request("POST","/api/projects",input,exec);
  assert.equal(created.status,200,JSON.stringify(created.data));
  const pid=created.data.project.id;
  assert.equal(created.data.project.status,"草稿");
  const submitted=await request("POST","/api/projects/"+pid+"/transition",{action:"submit"},exec);
  assert.equal(submitted.status,200,JSON.stringify(submitted.data));
  assert.equal(submitted.data.project.status,"待审批");
  const pending=await request("GET","/api/dashboard",undefined,admin);
  assert.equal(pending.status,200);
  assert.ok(pending.data.todos.some(t=>t.kind==="审批"&&t.pid===pid),"总管理员必须收到立项审批");
  const approved=await request("POST","/api/projects/"+pid+"/transition",{action:"approve"},admin);
  assert.equal(approved.status,200,JSON.stringify(approved.data));
  assert.equal(approved.data.project.status,"已立项");
  const task=await request("GET","/api/dashboard",undefined,exec);
  assert.equal(task.status,200);
  const assigned=task.data.todos.filter(t=>t.kind==="筹备"&&t.pid===pid);
  assert.equal(assigned.length,1,"会务执行人应恰好看到一条该项目的筹备待办");
  assert.equal(assigned[0].go,"projects");
  const outsider=await request("GET","/api/dashboard",undefined,finance);
  assert.equal(outsider.status,200);
  assert.ok(!outsider.data.todos.some(t=>t.pid===pid&&t.kind==="筹备"),"财务不应收到执行人筹备待办");
  const prep=await request("POST","/api/projects/"+pid+"/transition",{action:"prep"},exec);
  assert.equal(prep.status,200,JSON.stringify(prep.data));
  assert.equal(prep.data.project.status,"筹备中");
  const next=await request("GET","/api/dashboard",undefined,exec);
  assert.ok(!next.data.todos.some(t=>t.kind==="筹备"&&t.pid===pid),"进入筹备后旧待办应立即消失");
  const detail=await request("GET","/api/projects/"+pid,undefined,admin);
  assert.equal(detail.data.project.status,"筹备中");
});
