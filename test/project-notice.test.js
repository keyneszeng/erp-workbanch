"use strict";
/** 立项函、协会模板、审批时快照、待盖章 Word 下载与权限回归 */
const {test,before,after}=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs"),path=require("node:path");
const {spawn}=require("node:child_process");
const PizZip=require("pizzip");
const PORT=8962,BASE="http://127.0.0.1:"+PORT;
const DB=path.join(__dirname,"..","data","project-notice-test.db");
const UPLOAD=path.join(__dirname,"..","data","project-notice-uploads");
let server;
const users={};
async function ready() {
  for(let i=0;i<160;i++){
    try{if((await fetch(BASE+"/api/health")).ok)return;}catch{}
    await new Promise(r=>setTimeout(r,150));
  }
  throw Error("Word notice API did not start");
}
async function login(username){
  const r=await fetch(BASE+"/api/auth/login",{method:"POST",headers:{"Content-Type":"application/json"},
    body:JSON.stringify({username,password:"123456"})});
  assert.equal(r.status,200,"login "+username);
  return r.headers.get("set-cookie").split(";")[0];
}
async function request(username,method,url,data){
  const headers={cookie:users[username]||""};
  if(data!==undefined)headers["content-type"]="application/json";
  const response=await fetch(BASE+url,{method,headers,body:data===undefined?undefined:JSON.stringify(data)});
  const type=response.headers.get("content-type")||"";
  if(type.includes("wordprocessingml.document"))
    return {status:response.status,buf:Buffer.from(await response.arrayBuffer()),headers:response.headers};
  return {status:response.status,data:await response.json(),headers:response.headers};
}
function makeTemplate(label,{required=true}={}){
  const {defaultWordTemplate}=require("../server/lib/project-notice");
  const zip=new PizZip(defaultWordTemplate());
  const xml=zip.file("word/document.xml").asText();
  zip.file("word/document.xml",xml.replace("{{通知函标题}}",label+" {{通知函标题}}")
    .replace(required?"{{立项函正文}}":"{{会议名称}}",required?"{{立项函正文}}":"没有正文占位符"));
  return zip.generate({type:"nodebuffer"});
}
async function upload(username,pid,buf,name="协会固定模板.docx"){
  const response=await fetch(BASE+"/api/uploads?pid="+encodeURIComponent(pid),{
    method:"POST",headers:{cookie:users[username]||"",
      "content-type":"application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "x-file-name":encodeURIComponent(name)},body:buf
  });
  return {status:response.status,data:await response.json()};
}
function textOfDocx(buf){return new PizZip(buf).file("word/document.xml").asText();}
before(async()=>{
  for(const suffix of ["","-wal","-shm"])try{fs.rmSync(DB+suffix,{force:true})}catch{}
  fs.rmSync(UPLOAD,{force:true,recursive:true});
  server=spawn(process.execPath,["--experimental-sqlite","server/index.js"],{
    cwd:path.join(__dirname,".."),
    env:{...process.env,ERP_DB:DB,ERP_UPLOAD_DIR:UPLOAD,ERP_PORT:String(PORT)},
    stdio:["ignore","pipe","pipe"]
  });
  server.stderr.on("data",d=>{const s=String(d);if(!s.includes("ExperimentalWarning"))process.stderr.write(s);});
  await ready();
  for(const user of ["admin","assoc","exec","finance","guest","sunqian"])users[user]=await login(user);
});
after(()=>{server?.kill("SIGTERM");});
const pid="MP-2026-005",url="/api/projects/"+pid;

test("立项函编辑：仅本协会管理员与总管理员可以修改，普通角色只读",async()=>{
  const initial=await request("assoc","GET",url+"/initiation-letter");
  assert.equal(initial.status,200);
  assert.equal(initial.data.canEdit,true);
  assert.ok(initial.data.initiationLetter.title.length>0);
  const body="关于《华东医学会全科医学大会》的立项申请。\n请按照审批后的项目预算和议程开展筹备。";
  for(const role of ["exec","finance","guest","sunqian"]){
    assert.equal((await request(role,"PATCH",url+"/initiation-letter",{title:"越权",body})).status,403);
  }
  const saved=await request("assoc","PATCH",url+"/initiation-letter",{title:"全科医学大会立项申请函",body});
  assert.equal(saved.status,200,JSON.stringify(saved.data));
  assert.equal(saved.data.letter.body,body);
  assert.equal((await request("admin","PATCH",url+"/initiation-letter",
    {title:"批准支持全科医学大会立项",body})).status,200);
  assert.equal((await request("assoc","PATCH",url+"/initiation-letter",{title:"",body})).status,400);
});

test("模板仅允许本协会设置：拒绝伪造键和缺少动态内容的 DOCX",async()=>{
  const bytes=makeTemplate("自定义模板v1");
  const uploaded=await upload("assoc",pid,bytes,"全科分会通知函.docx");
  assert.equal(uploaded.status,200,JSON.stringify(uploaded.data));
  assert.equal((await request("exec","POST",url+"/notice-template",
    {file_key:uploaded.data.key,file_name:"越权.docx"})).status,403);
  assert.equal((await request("sunqian","POST",url+"/notice-template",
    {file_key:uploaded.data.key,file_name:"跨协会.docx"})).status,403);
  const invalid=await upload("assoc",pid,makeTemplate("失败",{required:false}),"不完整模板.docx");
  assert.equal(invalid.status,200);
  assert.equal((await request("assoc","POST",url+"/notice-template",
    {file_key:invalid.data.key,file_name:"不完整模板.docx"})).status,400);
  assert.equal((await request("assoc","POST",url+"/notice-template",
    {file_key:"a".repeat(32)+".pdf",file_name:"冒充模板.pdf"})).status,400);
  const set=await request("assoc","POST",url+"/notice-template",
    {file_key:uploaded.data.key,file_name:"全科分会通知函.docx"});
  assert.equal(set.status,200,JSON.stringify(set.data));
  assert.equal(set.data.template.version,1);
  const preview=await request("assoc","GET",url+"/notice/preview.docx");
  assert.equal(preview.status,200,JSON.stringify(preview.data));
  assert.match(textOfDocx(preview.buf),/自定义模板v1/);
  assert.match(preview.headers.get("content-disposition"),/attachment/);
});

test("审批前拒绝正式通知函；审批通过自动锁定内容与模板版本",async()=>{
  assert.equal((await request("admin","GET",url+"/notice.docx")).status,409);
  const pending=await request("assoc","GET","/api/approvals?status=待审批");
  assert.equal(pending.status,200);
  const ap=pending.data.rows.find(a=>a.pid===pid && a.type==="立项审批");
  assert.ok(ap,"需要已有立项审批记录");
  const approved=await request("assoc","POST","/api/approvals/"+ap.id+"/decide",
    {approve:true,comment:"准予立项，请打印后盖章"});
  assert.equal(approved.status,200,JSON.stringify(approved.data));
  const detail=await request("assoc","GET",url);
  assert.equal(detail.status,200);
  assert.equal(detail.data.project.status,"已立项");
  assert.equal(detail.data.projectNotice.ready,true);
  assert.equal(detail.data.projectNotice.templateVersion,1);
  assert.equal((await request("assoc","PATCH",url+"/initiation-letter",
    {title:"事后篡改",body:"恶意替换"})).status,409);
  const doc=await request("assoc","GET",url+"/notice.docx");
  assert.equal(doc.status,200,JSON.stringify(doc.data));
  assert.equal(doc.headers.get("cache-control"),"no-store");
  assert.match(doc.headers.get("content-disposition"),/attachment/);
  const xml=textOfDocx(doc.buf);
  assert.match(xml,/自定义模板v1/);
  assert.match(xml,/批准支持全科医学大会立项/);
  assert.match(xml,/按照审批后的项目预算和议程开展筹备/);
  assert.equal((await request("guest","GET",url+"/notice.docx")).status,403);
  assert.equal((await request("sunqian","GET",url+"/notice.docx")).status,403);
});

test("更换协会模板后历史项目仍使用审批时的版本",async()=>{
  const bytes=makeTemplate("新模板v2");
  const uploaded=await upload("admin",pid,bytes,"通知函v2.docx");
  assert.equal(uploaded.status,200);
  const set=await request("admin","POST",url+"/notice-template",
    {file_key:uploaded.data.key,file_name:"通知函v2.docx"});
  assert.equal(set.status,200,JSON.stringify(set.data));
  assert.equal(set.data.template.version,2);
  const same=await request("admin","GET",url+"/notice.docx");
  assert.equal(same.status,200);
  const xml=textOfDocx(same.buf);
  assert.match(xml,/自定义模板v1/);
  assert.doesNotMatch(xml,/新模板v2/);
  const preview=await request("assoc","GET",url+"/notice/preview.docx");
  assert.match(textOfDocx(preview.buf),/新模板v2/);
  const state=await request("assoc","GET",url);
  assert.equal(state.data.projectNotice.templateVersion,1);
  assert.equal(state.data.noticeTemplate.version,2);
});

test("历史已立项项目补发明确留痕且不重复发文",async()=>{
  const old="/api/projects/MP-2026-001";
  assert.equal((await request("assoc","GET",old+"/notice.docx")).status,409);
  assert.equal((await request("exec","POST",old+"/notice/backfill",{})).status,403);
  const backfill=await request("assoc","POST",old+"/notice/backfill",{});
  assert.equal(backfill.status,200,JSON.stringify(backfill.data));
  assert.equal(backfill.data.notice.backfilled,true);
  assert.equal((await request("assoc","POST",old+"/notice/backfill",{})).status,409);
  const doc=await request("assoc","GET",old+"/notice.docx");
  assert.equal(doc.status,200);
  assert.match(textOfDocx(doc.buf),/历史项目补发/);
  assert.equal((await request("exec","GET",old+"/notice.docx")).status,200,"可访问项目的执行人员可下载待盖章 Word");
});

test("审计中包含函件修改、模板设定及正式下载记录",async()=>{
  const r=await request("admin","GET","/api/audit");
  assert.equal(r.status,200);
  const acts=r.data.rows.map(a=>a.action);
  for(const action of ["编辑立项函","设置项目通知函 Word 模板","下载项目通知函 Word","历史项目通知函补发"])
    assert.ok(acts.includes(action),"缺少审计："+action);
});
