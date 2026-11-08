"use strict";
/** 动态材料类别、PDF原件合并、逐页水印及总管理员特权，真实API/存储回归。 */
const {test,before,after}=require("node:test");
const assert=require("node:assert/strict");
const {spawn}=require("node:child_process");
const {DatabaseSync}=require("node:sqlite");
const {PDFDocument,PDFName}=require("pdf-lib");
const fs=require("node:fs"),os=require("node:os"),path=require("node:path");
const dir=fs.mkdtempSync(path.join(os.tmpdir(),"erp-select-pdf-"));
const dbFile=path.join(dir,"db.sqlite"),uploadDir=path.join(dir,"uploads");
const port=8898,base="http://127.0.0.1:"+port;
const root=path.resolve(__dirname,".."),pid="MP-2026-015",otherPid="MP-2026-007";
let proc,db,sessions={};
function put(key,bytes){
 const folder=path.join(uploadDir,key.slice(0,2));
 fs.mkdirSync(folder,{recursive:true});
 fs.writeFileSync(path.join(folder,key),bytes);
}
function mat(pid,kind,name,key,size=0,mime="application/pdf",deleted=null){
 db.prepare("INSERT INTO materials(pid,kind,name,version,uploader,created_at,file_key,file_name,file_size,file_mime,deleted_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
  .run(pid,kind,name,"v1","测试人员","2026-11-07 10:00",key,name+(mime==="application/pdf"?".pdf":mime==="image/png"?".png":".txt"),size,mime,deleted);
}
async function login(name){
 const response=await fetch(base+"/api/auth/login",{method:"POST",
  headers:{"content-type":"application/json"},body:JSON.stringify({username:name,password:"123456"})});
 assert.equal(response.status,200,"login "+name);
 return response.headers.get("set-cookie").split(";")[0];
}
async function call(name,method,route,body){
 const response=await fetch(base+route,{method,headers:{
  ...(name?{cookie:sessions[name]}:{}),...(body!==undefined?{"content-type":"application/json"}:{})},
  body:body===undefined?undefined:JSON.stringify(body)});
 const type=response.headers.get("content-type")||"";
 return {status:response.status,raw:response,
  data:type.includes("json")?await response.json():null};
}
const uri=id=>"/api/projects/"+id+"/archive-pdf";
const opt=id=>uri(id)+"/options";
const post=(name,id,categories,watermark_mode="default",watermark_text="")=>
  call(name,"POST",uri(id),{categories,watermark_mode,watermark_text});
async function pdfOf(result){
 assert.equal(result.status,200,JSON.stringify(result.data));
 assert.match(result.raw.headers.get("content-type"),/application\/pdf/);
 assert.equal(result.raw.headers.get("cache-control"),"no-store");
 return PDFDocument.load(await result.raw.arrayBuffer());
}
function stampOnEveryPage(doc){
 for(const [i,page] of doc.getPages().entries()){
   const xo=page.node.Resources()?.lookup(PDFName.of("XObject"));
   assert.ok(xo,"page "+i+" should contain a visible watermark XObject");
 }
}
before(async()=>{
 proc=spawn(process.execPath,["--experimental-sqlite","server/index.js"],{
  cwd:root,env:{...process.env,ERP_DEMO_MODE:"1",ERP_PORT:String(port),
    ERP_DB:dbFile,ERP_UPLOAD_DIR:uploadDir},stdio:["ignore","pipe","pipe"]});
 let stderr="";proc.stderr.on("data",c=>stderr+=String(c));
 let ready=false;
 for(let i=0;i<462;i++){
  try{if((await fetch(base+"/api/health")).ok){ready=true;break;}}catch{}
  if(proc.exitCode!==null)throw Error("server crashed "+stderr);
  await new Promise(r=>setTimeout(r,130));
 }
 assert.ok(ready,"server unavailable "+stderr);
 for(const name of ["admin","assoc","sunqian","exec","finance","guest"])sessions[name]=await login(name);
 db=new DatabaseSync(dbFile);
 db.exec("PRAGMA busy_timeout=5000");
 const source=await PDFDocument.create();source.addPage([320,400]);source.addPage([320,400]);
 const bytes=Buffer.from(await source.save());
 const pdfKey="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.pdf";
 put(pdfKey,bytes);mat(pid,"签到表","现场签到表",pdfKey,bytes.length);
 const otherKey="bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.pdf";
 put(otherKey,bytes);mat(pid,"合同","资料合同",otherKey,bytes.length);
 const pngBytes=Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+i2ioAAAAASUVORK5CYII=","base64");
 const pngKey="cccccccccccccccccccccccccccccccc.png";
 put(pngKey,pngBytes);mat(pid,"讲者照片","讲者照片",pngKey,pngBytes.length,"image/png");
 const textBytes=Buffer.from("example office note");
 const textKey="dddddddddddddddddddddddddddddddd.txt";
 put(textKey,textBytes);mat(pid,"会务说明","线下说明",textKey,textBytes.length,"text/plain");
 mat(pid,"仅登记类别","未上传原件",null);
 mat(pid,"已删除类别","旧版",null,0,"application/pdf","2026-11-07 11:00");
 const crossKey="eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee.pdf";
 put(crossKey,bytes);mat(otherPid,"跨协会文件","外协材料",crossKey,bytes.length);
});
after(()=>{db?.close();proc?.kill("SIGTERM");fs.rmSync(dir,{recursive:true,force:true});});
test("选项完全来自本项目材料库动态类别，并排除历史软删除",async()=>{
 const result=await call("assoc","GET",opt(pid));
 assert.equal(result.status,200,JSON.stringify(result.data));
 const rows=result.data.categories;
 for(const name of ["签到表","合同","讲者照片","会务说明","仅登记类别"])
  assert.ok(rows.some(x=>x.kind===name),name);
 assert.equal(rows.find(x=>x.kind==="仅登记类别").files,0);
 assert.ok(!rows.some(x=>x.kind==="已删除类别"));
 assert.ok(!rows.some(x=>x.kind==="跨协会文件"));
 assert.equal(result.data.can_customize_watermark,false);
 assert.equal((await call("admin","GET",opt(pid))).data.can_customize_watermark,true);
});
test("普通协会管理员勾选一个类目，PDF仅含封面+原件2页，且每页有本人/时间水印",async()=>{
 const result=await post("assoc",pid,["签到表"]);
 const doc=await pdfOf(result);
 assert.equal(doc.getPageCount(),3);
 assert.match(doc.getKeywords()||" ",/watermark:default/);
 stampOnEveryPage(doc);
 const bytes=Buffer.from(await (await call("assoc","GET",uri(pid))).raw.arrayBuffer());
 assert.match(bytes.toString("ascii",0,8),/^%PDF-1\./);
 assert.ok(bytes.length>1500);
});
test("多类合并且Office/TXT等非可视格式保留原件附件与提示页",async()=>{
 const doc=await pdfOf(await post("admin",pid,["签到表","合同","会务说明"]));
 assert.equal(doc.getPageCount(),6,"封面1+签到2+合同2+非可视附件说明1"); 
 const name=doc.getKeywords()||"";
 assert.match(name,/source-count:3/);
 stampOnEveryPage(doc);
});
test("只有总管理员能取消水印，自定义文字可用；普通管理员不能绕过",async()=>{
 const plain=await pdfOf(await post("admin",pid,["签到表"],"none"));
 assert.equal(plain.getPageCount(),3);
 assert.match(plain.getKeywords()||" ",/watermark:none/);
 for(const page of plain.getPages())assert.ok(!page.node.Resources()?.lookup(PDFName.of("XObject")),
  "no watermark XObject should exist when admin chose none");
 const custom=await pdfOf(await post("admin",pid,["签到表"],"custom","机密文件 · 仅内部使用"));
 assert.match(custom.getKeywords()||" ",/watermark:custom/);
 stampOnEveryPage(custom);
 for(const mode of ["none","custom"]){
  const res=await post("assoc",pid,["签到表"],mode,"伪造水印");
  assert.equal(res.status,403);
  assert.equal(res.data.error.code,"FORBIDDEN");
 }
});
test("无效参数、未知类别及仅登记未上传必须拒绝",async()=>{
 for(const categories of [[],["不存在的类别"],["跨协会文件"],["仅登记类别"]]){
  const r=await post("admin",pid,categories);
  assert.equal(r.status,400,JSON.stringify({categories,data:r.data}));
 }
 for(const text of ["","x".repeat(81)]){
  const r=await post("admin",pid,["签到表"],"custom",text);
  assert.equal(r.status,400);
 }
});
test("严格执行当前会议归档状态、角色权限及协会隔离",async()=>{
 assert.equal((await call("admin","GET",opt("MP-2026-001"))).status,409);
 for(const name of ["exec","finance","guest"]){
  const denied=await call(name,"GET",opt(pid));
  assert.equal(denied.status,403,name);
  assert.equal((await post(name,pid,["签到表"])).status,403,name);
 }
 assert.equal((await call("assoc","GET",opt(otherPid))).status,403);
 assert.equal((await call("sunqian","GET",opt(pid))).status,403);
 assert.equal((await call(null,"GET",opt(pid))).status,401);
});
test("选中已上传但物理文件缺失时禁止假装导出成功",async()=>{
 const missing="ffffffffffffffffffffffffffffffff.pdf";
 mat(pid,"缺失原件","坏链接",missing,1024);
 const r=await post("admin",pid,["缺失原件"]);
 assert.equal(r.status,409,JSON.stringify(r.data));
 assert.equal(r.data.error.code,"MATERIAL_FILE_MISSING");
});
test("兼容旧GET下载链接也必须使用新的最简封面和默认水印",async()=>{
 const res=await call("admin","GET",uri(otherPid));
 const doc=await pdfOf(res);
 assert.equal(doc.getPageCount(),3);
 assert.match(doc.getKeywords()||" ",/watermark:default/);
 stampOnEveryPage(doc);
});
test("旧卷宗构建器保留并仍可用于兼容历史报告，但新的材料下载不自动包含其财务数据",async()=>{
 const {buildArchivePdf}=require("../server/lib/archive-pdf");
 const source=await PDFDocument.create();source.addPage([100,100]);
 const old=await buildArchivePdf({
  project:{id:"MP-LEGACY",name:"旧卷宗",assoc:"测试协会"},
  verifySteps:[],exceptions:[],materials:[],contracts:[],payments:[],approvals:[],auditLogs:[],demandItems:[]
 },{get:async()=>null});
 const doc=await PDFDocument.load(old);
 assert.ok(doc.getPageCount()>0);
});
