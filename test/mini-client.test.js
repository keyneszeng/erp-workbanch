"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const source = fs.readFileSync(path.join(__dirname, "../miniprogram/app.js"), "utf8");

function client(apiBase, responder) {
  let app;
  const storage = new Map();
  const wx = {
    getStorageSync: k => storage.get(k),
    setStorageSync: (k, v) => storage.set(k, v),
    removeStorageSync: k => storage.delete(k),
    request: opts => responder(opts),
    login: opts => opts.success({ code: "test_code" })
  };
  const ctx = { App: x => { app = x; }, require: x => {
    assert.equal(x, "./config");
    return { apiBase };
  }, wx, Promise, Error };
  vm.runInNewContext(source, ctx, { filename: "miniprogram/app.js" });
  app.onLaunch();
  return { app, wx, storage };
}
test("mini production client refuses demo and placeholder origins", async () => {
  for (const url of ["https://erp.aibuild.work/api", "https://production.example.com/api", "http://prod.example.org/api"]) {
    let calls = 0;
    const { app } = client(url, () => { calls++; });
    await assert.rejects(app.api("/projects"), /阿里云 HTTPS 正式 API 域名/);
    assert.equal(calls, 0, "unsafe requests must not be issued");
  }
});
test("mini public invitations never include employee Bearer token", async () => {
  const headers = [];
  const { app } = client("https://erp-prod.example.org/api", opts => {
    headers.push({ path: opts.url, auth: opts.header.Authorization });
    opts.success({ statusCode: 200, data: { ok: true } });
  });
  app.setSession({ accessToken: "secret-token", user: { id: 7 }, perms: [] });
  await app.api("/public/prep-invitation?token=example");
  await app.api("/projects");
  assert.equal(headers[0].auth, undefined);
  assert.equal(headers[1].auth, "Bearer secret-token");
});
test("mini revoked session is cleared on 401, not on other errors", async () => {
  let status = 403;
  const { app, storage } = client("https://erp-prod.example.org/api", opts =>
    opts.success({ statusCode: status, data: { error: { message: "Denied" } } }));
  app.setSession({ accessToken: "secret-token", user: { id: 7 }, perms: [] });
  await assert.rejects(app.api("/projects"), /Denied/);
  assert.equal(app.globalData.token, "secret-token");
  status = 401;
  await assert.rejects(app.api("/projects"), /Denied/);
  assert.equal(app.globalData.token, "");
  assert.equal(storage.has("erp_mini_token"), false);
});

test("private original preview requires a valid session, allowed file key and Bearer header",async()=>{
 const downloads=[];
 let opened=0;
 const {app,wx}=client("https://erp-prod.example.org/api",()=>{});
 wx.downloadFile=opts=>{downloads.push(opts);opts.success({statusCode:200,tempFilePath:"/tmp/original.pdf"});};
 wx.openDocument=opts=>{opened++;opts.success();};
 await assert.rejects(app.openOriginal("../another-project.pdf"),/无效/);
 await assert.rejects(app.openOriginal("a".repeat(32)+".pdf"),/请先登录/);
 app.setSession({accessToken:"session-test",user:{id:1},perms:[]});
 await app.openOriginal("a".repeat(32)+".pdf");
 assert.equal(downloads.length,1);
 assert.equal(opened,1);
 assert.equal(downloads[0].header.Authorization,"Bearer session-test");
 assert.match(downloads[0].url,/\/api\/uploads\/a{32}\.pdf$/);
});
function miniPage(sourceFile,app){
 let page;
 const wx={navigateTo(){},stopPullDownRefresh(){}};
 vm.runInNewContext(fs.readFileSync(path.join(__dirname,"..",sourceFile),"utf8"),
  {getApp:()=>app,Page:obj=>{page=obj;},wx,Promise,Error,Set,Map,Number,String,encodeURIComponent});
 page.setData=function(obj){this.data={...this.data,...obj};};
 return page;
}
test("project page shows finance and verification only when project response grants section access",async()=>{
 let response={project:{id:"MP-A",status:"执行中",name:"测试会议"},visibility:"participant"};
 const app={globalData:{perms:[]},api:async()=>response};
 const p=miniPage("miniprogram/pages/project/index.js",app);
 p.data.id="MP-A";
 await p.load();
 assert.equal(p.data.canVerify,false);
 assert.equal(p.data.canFinance,false);
 assert.equal(p.data.settlementSummary,null);
 response={project:{id:"MP-A",status:"已结算",name:"测试会议"},
  sectionAccess:{verify:true,finance:true},
  verification:{passed:4,total:4,complete:true},
  settlementBreakdown:{summary:{budget:1000,available_budget:900,paid:400,balance:500},
   groups:[{key:"labor",label:"劳务",amount:400,count:1,items:[{id:"PY-1",amount:400,type:"专家费",payee:"讲师",paid_at:"2026-11-09"}]}]}};
 await p.load();
 assert.equal(p.data.canVerify,true);
 assert.equal(p.data.settlementSummary.balance,"500.00");
 assert.equal(p.data.settlementGroups[0].items[0].amount,"400.00");
});
test("mini verification associates current agenda, host, and stamped letter, never a historical agenda",async()=>{
 const materials=[
  {id:1,kind:"终版议程",version:"历史版",file_key:"a".repeat(32)+".pdf"},
  {id:2,kind:"终版议程",version:"终版",file_key:"b".repeat(32)+".pdf"},
  {id:3,kind:"串场",file_key:"c".repeat(32)+".pptx"},
  {id:4,kind:"会议通知",file_key:"d".repeat(32)+".pdf"}
 ];
 const app={api:async()=>({project:{name:"测试会议"},sectionAccess:{verify:true,materials:true},
  verification:{passed:0,total:7,steps:[{no:1,name:"盖章函件与串场核验",result:"待判定"}]},
  materials,contracts:[],sponsorRights:{}}),openOriginal:async()=>true};
 const p=miniPage("miniprogram/pages/verification/index.js",app);
 p.data.pid="MP-A";
 await p.load();
 assert.deepEqual(Array.from(p.data.files.map(x=>x.id)),[2,3,4]);
 assert.equal(p.data.selected.no,1);
});

test("anonymous public event proposals do not require login or forward employee tokens",async()=>{
 const calls=[];
 const responder=opts=>{calls.push(opts);opts.success({statusCode:200,data:{reference:"PP-demo",status:"已接收"}});};
 const anonymous=client("https://erp-prod.example.org/api",responder);
 await anonymous.app.api("/public/event-proposals","POST",{topic:"活动"});
 assert.equal(calls.length,1);
 assert.equal(calls[0].header.Authorization,undefined);
 const staff=client("https://erp-prod.example.org/api",responder);
 staff.app.setSession({accessToken:"private-session",user:{id:2},perms:[]});
 await staff.app.api("/public/event-proposals","POST",{topic:"活动"});
 assert.equal(calls[1].header.Authorization,undefined);
 assert.equal(staff.app.globalData.token,"private-session");
});

test("first phone binding uses public endpoint without sending old employee bearer",async()=>{
 const seen=[];
 const {app}=client("https://erp-prod.example.org/api",opts=>{
   seen.push(opts);
   opts.success({statusCode:200,data:{accessToken:"new-session",user:{role:"user"},perms:[]}});
 });
 app.setSession({accessToken:"previous-session",user:{id:99},perms:["project:approve"]});
 const result=await app.api("/mini/auth/phone-bind","POST",{code:"test_identity",phoneCode:"phone_test_13800138000"});
 assert.equal(result.accessToken,"new-session");
 assert.equal(seen[0].header.Authorization,undefined);
});
test("WeChat silent login sends no old employee token and resumes the linked role",async()=>{
 const seen=[];
 const {app}=client("https://erp-prod.example.org/api",opts=>{
   seen.push(opts);
   opts.success({statusCode:200,data:{accessToken:"bound-session",
     user:{role:"user",mustChangePassword:false},role:{modules:[]},perms:[]}});
 });
 const resumed=await app.resume();
 assert.equal(resumed.user.role,"user");
 assert.equal(app.globalData.token,"bound-session");
 assert.equal(seen.length,1);
 assert.equal(seen[0].header.Authorization,undefined);
 assert.match(seen[0].url,/\/mini\/auth\/login$/);
});

function mockMaterialsPage(files,api){
 let page;
 const seen={chooseCount:0,mediaCount:0,toast:0};
 const wx={
  chooseMessageFile:opts=>{seen.chooseCount=opts.count;opts.success({tempFiles:files});},
  chooseMedia:opts=>{seen.mediaCount=opts.count;opts.success({tempFiles:files});},
  getFileSystemManager:()=>({readFile:opts=>opts.success({data:new Uint8Array([1,2,3])})}),
  showToast:()=>{seen.toast++;},
 };
 const app={api};
 vm.runInNewContext(fs.readFileSync(path.join(__dirname,"../miniprogram/pages/materials/index.js"),"utf8"),
  {getApp:()=>app,Page:obj=>page=obj,wx,Promise,Number,String,Map,Date,encodeURIComponent});
 page.setData=function(changes){this.data={...this.data,...changes};};
 page.data.pid="MP-2026-001";
 page.data.locked=false;
 return {page,seen};
}
test("微信小程序的讲者照片允许10文件多选并按原文件名逐份关联",async()=>{
 const uploaded=[],registered=[];
 let seq=0;
 const files=["张三.jpg","李四照片.png"].map(name=>({name,path:"/tmp/"+name,size:128}));
 const {page,seen}=mockMaterialsPage(files,async(path,method,body)=>{
  if(path.startsWith("/uploads?")){
   const file=files[seq++];
   uploaded.push(file.name);
   return {key:"a".repeat(31)+(seq%10)+".png",name:file.name,size:128,mime:"image/png"};
  }
  if(path.endsWith("/materials")){
   registered.push(body);
   return {speakerFromFilename:body.name.replace(/\.(jpg|png)$/,"").replace(/照片$/,"")};
  }
  throw Error("Unexpected API: "+path);
 });
 page.data.kind="讲者照片";
 await page.addFile();
 assert.equal(seen.chooseCount,10);
 assert.equal(uploaded.length,2);
 assert.equal(registered.length,2);
 assert.deepEqual(registered.map(x=>x.name),["张三.jpg","李四照片.png"]);
 assert.deepEqual(registered.map(x=>x.file_name),["张三.jpg","李四照片.png"]);
 assert.equal(page.data.error,"");
 assert.equal(page.data.uploaded,"已归档2份材料");
 await page.addPhoto();
 // 相册图片没有原始文件名，进入逐张命名阶段而不是直接拒绝
 assert.equal(page.data.error,"");
 assert.equal(seen.mediaCount,10);
 assert.equal(page.data.speakerFiles.length,2);
});
test("微信小程序讲者照片可从相册选图，填姓名后按姓名归档",async()=>{
 const files=[{path:"/tmp/tmp_a.jpg",size:256},{path:"/tmp/tmp_b.png",size:256}];
 const registered=[];
 const {page,seen}=mockMaterialsPage(files,async(path,method,body)=>{
  if(path.startsWith("/uploads?")){
   return {key:"c".repeat(31)+registered.length+".jpg",name:"x",size:256,mime:"image/jpeg"};
  }
  if(path.endsWith("/materials")){registered.push(body);return {};}
  throw Error("Unexpected API: "+path);
 });
 page.data.kind="讲者照片";
 await page.addPhoto();
 assert.equal(seen.mediaCount,10);
 assert.equal(page.data.speakerFiles.length,2);
 assert.equal(page.data.error,"");
 // 姓名未填时不允许上传
 await page.uploadSpeakers();
 assert.match(page.data.error,/讲者姓名/);
 assert.equal(registered.length,0);
 // 填好姓名后按「姓名.扩展名」归档，扩展名沿用原图
 page.data.speakerFiles[0].name="张三";
 page.data.speakerFiles[1].name="李四";
 await page.uploadSpeakers();
 assert.equal(registered.length,2);
 assert.deepEqual(registered.map(x=>x.name),["张三.jpg","李四.png"]);
 assert.deepEqual(registered.map(x=>x.kind),["讲者照片","讲者照片"]);
 assert.equal(page.data.speakerFiles.length,0);
});
test("微信小程序全部类别10文件上限，终版议程按原选择顺序串行写入",async()=>{
 const names=["第一次议程.pdf","第二次议程.pdf","最终版议程.pdf"];
 const files=names.map(name=>({name,path:"/tmp/"+name,size:128}));
 const attached=[];
 let next=0;
 const {page,seen}=mockMaterialsPage(files,async(path,method,body)=>{
  if(path.startsWith("/uploads?")){
   const name=files[next++].name;
   return {key:"b".repeat(31)+next+".pdf",name,size:128,mime:"application/pdf"};
  }
  if(path.endsWith("/materials")){attached.push(body);return {};}
  throw Error("Unexpected API: "+path);
 });
 page.data.kind="终版议程";
 await page.addFile();
 assert.equal(seen.chooseCount,10);
 assert.deepEqual(attached.map(x=>x.name),names);
 assert.ok(attached.every(x=>x.version==="终版"));
 assert.match(page.data.uploaded,/最后一份为当前终版/);
 const excessive=Array.from({length:11},(_,i)=>({name:"文件"+i+".pdf",path:"/tmp/"+i,size:100}));
 const over=mockMaterialsPage(excessive,async()=>{throw Error("over-limit files must never upload")});
 await over.page.addFile();
 assert.match(over.page.data.error,/10/);
});


test("小程序材料类别与录入合并：切换类别显示历史文件名并在上传后立即刷新",async()=>{
 const projectId="HDYX-2027-01";
 const rows=[
  {id:13,kind:"课件",filename:"心脏专题课件.pptx",version:"v1"},
  {id:12,kind:"签到表",filename:"第一天签到.pdf",version:"v1"},
  {id:11,kind:"工作总结",filename:"总结材料.docx",version:"v1"}
 ];
 const files=[{name:"第二天签到.pdf",path:"/tmp/signin.pdf",size:120}];
 let listRequests=0,uploads=0;
 const {page}=mockMaterialsPage(files,async(url,method,body)=>{
  if(url==="/projects?page=1&size=100"){
   return {rows:[{id:projectId,name:"2027年专题会议",status:"筹备中"}]};
  }
  if(url==="/projects/"+encodeURIComponent(projectId)+"/material-workbench"){
   listRequests++;
   return {kinds:["课件","签到表","权益照片","会务发票"],modules:[],materials:rows.map(x=>({...x}))};
  }
  if(url.startsWith("/uploads?pid=")){
   uploads++;
   return {key:"a".repeat(32)+".pdf",name:files[0].name,size:120,mime:"application/pdf"};
  }
  if(url.endsWith("/materials")&&method==="POST"){
   rows.unshift({id:20,kind:body.kind,filename:body.file_name,version:"v1"});
   return {message:"已登记"};
  }
  throw Error("Unexpected API "+url);
 });
 page.data.pid=projectId;
 await page.onShow();
 assert.equal(page.data.pid,projectId);
 assert.deepEqual(Array.from(page.data.visibleFiles.map(r=>r.filename)),["心脏专题课件.pptx"]);
 assert.deepEqual(Array.from(page.data.activeKinds),["课件","签到表","权益照片","会务发票"],"小程序使用服务端共享推荐类别");
 assert.deepEqual(Array.from(page.data.historyKinds),["工作总结"]);
 page.chooseKind({currentTarget:{dataset:{kind:"签到表"}}});
 assert.deepEqual(Array.from(page.data.visibleFiles.map(r=>r.filename)),["第一天签到.pdf"]);
 await page.addFile();
 assert.equal(uploads,1);
 assert.ok(listRequests>=2,"材料保存后应重新读取服务器上的已录入清单");
 assert.deepEqual(Array.from(page.data.visibleFiles.map(r=>r.filename)),
  ["第二天签到.pdf","第一天签到.pdf"],"成功上传后显示已录文件名");
 page.chooseKind({currentTarget:{dataset:{kind:"课件"}}});
 assert.deepEqual(Array.from(page.data.visibleFiles.map(r=>r.filename)),["心脏专题课件.pptx"]);
 page.chooseKind({currentTarget:{dataset:{kind:"工作总结"}}});
 assert.deepEqual(Array.from(page.data.visibleFiles.map(r=>r.filename)),["总结材料.docx"]);
 page.chooseCustom();
 page.input({currentTarget:{dataset:{key:"customKind"}},detail:{value:"工作总结"}});
 assert.deepEqual(Array.from(page.data.visibleFiles.map(r=>r.filename)),["总结材料.docx"]);
 await page.onShow();
 assert.equal(page.data.pid,projectId);
 assert.deepEqual(Array.from(page.data.visibleFiles.map(r=>r.filename)),["总结材料.docx"],
  "重新进入小程序材料页仍从服务端读取该类别历史文件名");
});
test("小程序材料工作台同一个表单显示类别、上传与已录入文件名，后台只回已保存附件",()=>{
 const xml=fs.readFileSync(path.join(__dirname,"../miniprogram/pages/materials/index.wxml"),"utf8");
 const js=fs.readFileSync(path.join(__dirname,"../miniprogram/pages/materials/index.js"),"utf8");
 const backend=fs.readFileSync(path.join(__dirname,"../server/api/material-workbench.js"),"utf8");
 assert.equal((xml.match(/class="form-section"/g)||[]).length,1,"不应再拆成选类别和填材料两块表单");
 assert.match(xml,/按类别直接录入材料/);
 assert.doesNotMatch(xml,/填写材料信息/);
 assert.match(xml,/已录入文件/);
 assert.match(xml,/visibleFiles/);
 assert.match(js,/await this\.loadKinds\(pid,\{preserveError:true\}\)/,"批量上传成功或部分成功后要刷新文件名");
 assert.match(backend,/deleted_at IS NULL AND file_key IS NOT NULL/,"不能显示已删除或未上传的材料");
 assert.match(backend,/COALESCE\(NULLIF\(file_name,''\),name\) AS filename/);
 assert.match(backend,/kinds:MATERIAL_KINDS/,"小程序与 Web 共用后端类别目录");
 const web=fs.readFileSync(path.join(__dirname,"../web/assets/js/pages/project.js"),"utf8");
 assert.match(web,/material-kind-chip/,"Web 项目材料面板应能按类别选择");
 assert.match(web,/data-material-custom-apply/,"Web 材料类别也应允许自定义");
 assert.match(web,/当前录入/,"Web 与小程序都显示当前录入类别");
 assert.match(web,/current\.map\(\(m\)/,"Web 材料附件仅显示当前类别的已录入文件");

});
