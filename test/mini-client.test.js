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
 const seen={chooseCount:0,mediaCount:0,toast:0,modalCount:0,confirmDelete:true,lastModal:null};
 const wx={
  chooseMessageFile:opts=>{seen.chooseCount=opts.count;opts.success({tempFiles:files});},
  chooseMedia:opts=>{seen.mediaCount=opts.count;opts.success({tempFiles:files});},
  getFileSystemManager:()=>({readFile:opts=>opts.success({data:new Uint8Array([1,2,3])})}),
  showToast:()=>{seen.toast++;},
  showModal:opts=>{seen.modalCount++;seen.lastModal=opts;
   opts.success({confirm:seen.confirmDelete,cancel:!seen.confirmDelete});},
 };
 // Upload-only fixtures omit the post-save project read; emulate the normal scoped
 // project response for those specific tests without overriding explicit fixtures.
 const app={globalData:{perms:["material:write","material:file:replace"]},api:async(url,method,body,headers)=>{
  try{return await api(url,method,body,headers);}
  catch(err){
   if(url==="/projects/MP-2026-001"&&/^Unexpected API:/i.test(err.message))
    return {project:{id:"MP-2026-001",status:"筹备中"},sectionAccess:{materials:true},materialsStatus:{categoryCatalog:{active:[page.data.kind||"课件"],history:[],disabled:[]}},materials:[]};
   throw err;
  }
 }};
 vm.runInNewContext(fs.readFileSync(path.join(__dirname,"../miniprogram/pages/materials/index.js"),"utf8"),
  {getApp:()=>app,Page:obj=>page=obj,wx,Promise,Number,String,Map,Date,encodeURIComponent});
 page.setData=function(changes){this.data={...this.data,...changes};};
 page.data.pid="MP-2026-001";
 page.data.locked=false;page.data.canMaterialWrite=true;page.data.canMaterialRead=true;
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
  if(url==="/projects/"+encodeURIComponent(projectId)){
   listRequests++;
   return {project:{id:projectId,status:"筹备中"},sectionAccess:{materials:true},materialsStatus:{categoryCatalog:{active:["课件","签到表","权益照片","会务发票"],disabled:[],history:[]}},materials:rows.map(x=>({...x,file_name:x.filename,file_key:"a".repeat(32)+".pdf"}))};
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
test("小程序退役劳务收集表：旧服务端类别与历史文件统一归入劳务表",async()=>{
 const pid="HISTORY-LABOR";
 const rows=[
  {id:72,kind:"劳务收集表",filename:"旧劳务收集表.xlsx",version:"v1"},
  {id:73,kind:"劳务表",filename:"新劳务表.xlsx",version:"v1"}
 ];
 const {page}=mockMaterialsPage([],async(url)=>{
  if(url==="/projects?page=1&size=100")
    return {rows:[{id:pid,name:"测试劳务会议",status:"筹备中"}]};
  if(url==="/projects/"+pid)
    return {project:{id:pid,status:"筹备中"},sectionAccess:{materials:true},materialsStatus:{categoryCatalog:{active:["劳务收集表","劳务表","课件"],disabled:[],history:[]}},materials:rows.map(x=>({...x,file_name:x.filename,file_key:"a".repeat(32)+".xlsx"}))};
  throw Error("unexpected API "+url);
 });
 page.data.pid=pid;
 await page.onShow();
 assert.ok(page.data.activeKinds.includes("劳务表"));
 assert.ok(!page.data.activeKinds.includes("劳务收集表"));
 assert.ok(!page.data.historyKinds.includes("劳务收集表"));
 page.chooseKind({currentTarget:{dataset:{kind:"劳务表"}}});
 assert.deepEqual(Array.from(page.data.visibleFiles.map(x=>x.filename)),
  ["旧劳务收集表.xlsx","新劳务表.xlsx"],"两种历史存储类别都能在劳务表页面查看");
});
test("小程序材料误传：已归档文件可逐份确认删除，调用服务端软删并立即刷新列表",async()=>{
 const pid="MP-2026-001";
 const files=[
  {id:71,kind:"课件",filename:"误上传的课件.pptx",version:"v1"},
  {id:72,kind:"课件",filename:"正确课件.pptx",version:"v1"},
  {id:73,kind:"签到表",filename:"签到.pdf",version:"v1"}
 ];
 const deleted=[];
 const {page,seen}=mockMaterialsPage([],async(url,method)=>{
  if(url==="/projects?page=1&size=100")
   return {rows:[{id:pid,name:"会议材料",status:"筹备中"}]};
  if(url==="/projects/"+pid)
   return {project:{id:pid,status:"筹备中"},sectionAccess:{materials:true},materialsStatus:{categoryCatalog:{active:["课件","签到表"],disabled:[],history:[]}},materials:files.map(x=>({...x,file_name:x.filename,file_key:"a".repeat(32)+".pdf"}))};
  if(url==="/materials/71"&&method==="DELETE"){
   deleted.push(71);
   files.splice(files.findIndex(x=>x.id===71),1);
   return {message:"已软删并保留历史记录"};
  }
  if(url==="/materials/72"&&method==="DELETE"){
   deleted.push(72);
   throw new Error("合同已锁定或材料已冻结，不可删除");
  }
  throw Error("Unexpected API "+method+" "+url);
 });
 await page.onShow();
 assert.deepEqual(Array.from(page.data.visibleFiles.map(x=>x.filename)),
  ["误上传的课件.pptx","正确课件.pptx"]);
 await page.removeUploaded({currentTarget:{dataset:{id:71}}});
 assert.deepEqual(deleted,[71],"只能删除点击的那一条真实已归档材料");
 assert.equal(seen.modalCount,1);
 assert.match(seen.lastModal.content,/误上传的课件/);
 assert.match(seen.lastModal.content,/废件箱/);
 assert.equal(seen.lastModal.confirmText,"删除");
 assert.deepEqual(Array.from(page.data.visibleFiles.map(x=>x.filename)),["正确课件.pptx"]);
 assert.match(page.data.uploaded,/已删除/);
 assert.equal(page.data.busy,false);
 assert.equal(page.data.deletingId,0);
 assert.equal(seen.toast,1);
 page.chooseKind({currentTarget:{dataset:{kind:"签到表"}}});
 assert.deepEqual(Array.from(page.data.visibleFiles.map(x=>x.filename)),["签到.pdf"],
  "删除当前课件不得影响其他材料类别");
 page.chooseKind({currentTarget:{dataset:{kind:"课件"}}});
 seen.confirmDelete=false;
 await page.removeUploaded({currentTarget:{dataset:{id:72}}});
 assert.deepEqual(deleted,[71],"用户取消删除后不得发送 DELETE");
 assert.equal(page.data.busy,false);
 assert.equal(page.data.deletingId,0);
 assert.equal(page.data.visibleFiles.length,1);
 seen.confirmDelete=true;
 await page.removeUploaded({currentTarget:{dataset:{id:72}}});
 assert.deepEqual(deleted,[71,72]);
 assert.match(page.data.error,/删除失败.*冻结/);
 assert.equal(page.data.visibleFiles.length,1,"后端拒绝删除时必须保留文件");
 assert.equal(page.data.deletingId,0);
 page.setData({locked:true});
 await page.removeUploaded({currentTarget:{dataset:{id:72}}});
 assert.equal(deleted.length,2,"结算或归档锁定时前端不应请求删除");
 page.setData({locked:false,busy:true});
 await page.removeUploaded({currentTarget:{dataset:{id:72}}});
 assert.equal(deleted.length,2,"上传进行中不得删除并发修改材料");
});

test("小程序已录入材料必须有逐项删除按钮，锁定时隐藏并提供人工确认",()=>{
 const xml=fs.readFileSync(path.join(__dirname,"../miniprogram/pages/materials/index.wxml"),"utf8");
 const js=fs.readFileSync(path.join(__dirname,"../miniprogram/pages/materials/index.js"),"utf8");
 assert.match(xml,/catchtap="removeUploaded"/);
 assert.match(xml,/data-id="{{item.id}}"/);
 assert.match(xml,/wx:if="{{canMaterialWrite&&!materialMutationLocked}}"/);
 assert.match(xml,/disabled="{{busy}}"/);
 assert.match(js,/showModal\(/);
 assert.match(js,/app\.api\("\/materials\/"\+id,"DELETE"\)/);
 assert.match(js,/await this\.loadKinds\(pid,\{preserveError:true\}\)/);
});

test("小程序材料工作台同一个表单显示类别、上传与已录入文件名，后台只回已保存附件",()=>{
 const xml=fs.readFileSync(path.join(__dirname,"../miniprogram/pages/materials/index.wxml"),"utf8");
 const js=fs.readFileSync(path.join(__dirname,"../miniprogram/pages/materials/index.js"),"utf8");
 const backend=fs.readFileSync(path.join(__dirname,"../server/api/material-workbench.js"),"utf8");
 assert.equal((xml.match(/class="form-section"/g)||[]).length,1,"不应再拆成选类别和填材料两块表单");
 assert.match(xml,/按类别查看及录入材料/);
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
 assert.match(web,/当前类别/,"Web 与小程序都显示当前材料类别");
 assert.match(web,/current\.map\(\(m\)/,"Web 材料附件仅显示当前类别的已录入文件");

});

test("手机号快捷登录前置页面使用产品品牌，不出现平台官方身份混淆文案",()=>{
 const view=fs.readFileSync(path.join(__dirname,"../miniprogram/pages/bind/index.wxml"),"utf8");
 const logic=fs.readFileSync(path.join(__dirname,"../miniprogram/pages/bind/index.js"),"utf8");
 const title=JSON.parse(fs.readFileSync(path.join(__dirname,"../miniprogram/pages/bind/index.json"),"utf8"));
 const account=fs.readFileSync(path.join(__dirname,"../miniprogram/pages/account/index.wxml"),"utf8");
 assert.equal(title.navigationBarTitleText,"手机号快捷登录");
 assert.match(view,/<button[^>]+open-type="getPhoneNumber"[^>]*>\s*手机号快捷登录\s*<\/button>/);
 assert.match(view,/bindgetphonenumber="getPhoneNumber"/);
 assert.match(view,/会规智云品牌标识/);
 assert.match(view,/disabled="{{busy\|\|!consent}}"/);
 assert.match(logic,/\/mini\/auth\/phone-bind/);
 for(const source of [view,logic,account,JSON.stringify(title)])assert.doesNotMatch(source,/微信|腾讯|wechat-logo|weixin-logo/i);
});

test("材料收集合同类目使用正式合同目录，保留权限与原件保护",async()=>{
 const pid="MP-CONTRACT";
 const key="a".repeat(32)+".pdf";
 let allowed=true,opened="";
 const source=fs.readFileSync(path.join(__dirname,"../miniprogram/pages/materials/index.js"),"utf8");
 let page;
 const app={api:async url=>{
  if(url==="/projects/"+pid)return {sectionAccess:{contracts:allowed},contracts:[
   {id:"C-1",name:"会务合同",vendor:"会务公司",category:"会务需求",status:"已签署",file_key:key},
   {id:"C-2",name:"已删除合同",deleted_at:"2026-11-25"}]};
  throw Error("unexpected "+url);
 },openOriginal:async file=>{opened=file;}};
 vm.runInNewContext(source,{getApp:()=>app,Page:x=>{page=x;},wx:{showToast:()=>{}}});
 page.setData=patch=>Object.assign(page.data,patch);
 page.data.pid=pid;
 await page.chooseContracts();
 assert.equal(page.data.contractMode,true);
 assert.equal(page.data.contractRows.length,1);
 assert.equal(page.data.contractRows[0].category,"会务协议");
 await page.openContractOriginal({currentTarget:{dataset:{id:"C-1"}}});
 assert.equal(opened,key);
 allowed=false;
 await page.chooseContracts();
 assert.equal(page.data.contractRows.length,0);
 assert.match(page.data.contractError,/无合同目录查看权限/);
 page.chooseKind({currentTarget:{dataset:{kind:"课件"}}});
 assert.equal(page.data.contractMode,false);
 const xml=fs.readFileSync(path.join(__dirname,"../miniprogram/pages/materials/index.wxml"),"utf8");
 assert.match(xml,/bindtap="chooseContracts"[^>]*>合同<\/view>/);
 assert.match(xml,/bindtap="openContractOriginal"/);
});

test("小程序合同上传复用正式台账、OCR与签署流程，不重复登记普通材料",async()=>{
 const pid="MP-CONTRACT-UPLOAD",key="b".repeat(32)+".pdf";
 const source=fs.readFileSync(path.join(__dirname,"../miniprogram/pages/materials/index.js"),"utf8");
 let page,allow=true,failOCR=false,stored=[],calls=[];
 const app={globalData:{perms:["contract:write"]},api:async(url,method,body,headers)=>{
  calls.push({url,method,body,headers});
  if(url==="/projects/"+pid)return {project:{id:pid,status:"筹备中"},sectionAccess:{contracts:allow},contracts:stored};
  if(url==="/uploads?pid="+pid)return {key,name:"合同.pdf",size:8,mime:"application/pdf"};
  if(url==="/contracts/scan"){
   if(failOCR)throw Error("OCR 暂不可用");
   return {fields:{vendor:"签约公司",amount:1234.56},note:"识别完成"};
  }
  if(url==="/contracts"){
   stored.push({id:"HT-"+stored.length,name:body.name,vendor:body.vendor,category:body.category,status:body.status,file_key:body.file_key,file_name:body.file_name});
   return {message:"合同已保存"};
  }
  throw Error("unexpected "+url);
 }};
 const wx={chooseMessageFile:o=>o.success({tempFiles:[{name:"合同.pdf",path:"/tmp/contract.pdf",size:8}]}),
  getFileSystemManager:()=>({readFile:o=>o.success({data:new ArrayBuffer(8)})}),showToast:()=>{}};
 vm.runInNewContext(source,{getApp:()=>app,Page:x=>{page=x;},wx,ArrayBuffer});
 page.setData=patch=>Object.assign(page.data,patch);
 page.data.pid=pid;
 await page.chooseContracts();
 assert.equal(page.data.canUploadContract,true);
 for(let i=0;i<3;i++){
  page.contractCategoryChange({detail:{value:String(i)}});
  failOCR=i===2;
  await page.pickContractFile({currentTarget:{dataset:{source:"file"}}});
  assert.equal(page.data.contractDraft.file.key,key);
  if(failOCR){
   assert.match(page.data.contractDraft.scanNote,/OCR 未完成/);
   page.contractDraftInput({currentTarget:{dataset:{key:"vendor"}},detail:{value:"赞助企业"}});
   page.contractDraftInput({currentTarget:{dataset:{key:"amount"}},detail:{value:"2000"}});
  }else{
   assert.equal(page.data.contractDraft.vendor,"签约公司");
   assert.equal(page.data.contractDraft.amount,"1234.56");
  }
  page.contractStatusChange({detail:{value:"1"}});
  await page.saveContract();
  assert.equal(page.data.contractRows.length,i+1);
 }
 const saved=calls.filter(x=>x.url==="/contracts");
 assert.deepEqual(saved.map(x=>x.body.category),["会务需求","劳务专家","企业赞助"]);
 assert.ok(saved.every(x=>x.body.pid===pid&&x.body.status==="待签署"&&x.body.file_key===key));
 assert.ok(!calls.some(x=>x.url.endsWith("/materials")&&x.method==="POST"));
 app.globalData.perms=[];
 await page.chooseContracts();
 assert.equal(page.data.canUploadContract,false);
 const n=calls.length;
 await page.pickContractFile({currentTarget:{dataset:{source:"file"}}});
 assert.equal(calls.length,n);
 const xml=fs.readFileSync(path.join(__dirname,"../miniprogram/pages/materials/index.wxml"),"utf8");
 assert.match(xml,/bindtap="pickContractFile"/);
 assert.match(xml,/bindtap="saveContract"/);
});

test("已归档会议的普通材料仍可查看原件，删除与上传保持冻结",async()=>{
 const pid="MP-ARCHIVE",key="a".repeat(32)+".pdf";
 let opened=[],requests=[],allowed=true,deleted=false,page,errors=[];
 const app={api:async(url,method)=>{
  requests.push({url,method});
  if(url==="/projects/"+pid)return {project:{id:pid,status:"已归档"},sectionAccess:{materials:allowed},materialsStatus:{categoryCatalog:{active:["课件"],history:["工作总结"],disabled:[]}},
   materials:[{id:7,kind:"课件",file_key:key,file_name:"课件.pdf",deleted_at:deleted?"2026-11-26":null}]};
  throw Error("Unexpected "+url);
 },openOriginal:async k=>opened.push(k)};
 vm.runInNewContext(fs.readFileSync(path.join(__dirname,"../miniprogram/pages/materials/index.js"),"utf8"),
  {getApp:()=>app,Page:x=>page=x,wx:{showToast:o=>errors.push(o.title)}});
 page.setData=p=>Object.assign(page.data,p);
 page.setData({pid,locked:true,kind:"课件"});
 await page.loadKinds(pid);
 const event={currentTarget:{dataset:{id:7}}};
 await page.openMaterialOriginal(event);
 assert.deepEqual(opened,[key]);
 await page.removeUploaded(event);
 await page.addFile();
 assert.equal(requests.length,1,"归档后不得上传或删除");
 allowed=false;
 await page.loadKinds(pid);
 await page.openMaterialOriginal(event);
 assert.equal(opened.length,1);
 assert.equal(page.data.canMaterialRead,false);
 allowed=true;deleted=true;
 await page.loadKinds(pid);
 await page.openMaterialOriginal(event);
 assert.equal(opened.length,1);
 assert.equal(page.data.visibleFiles.length,0);
 await page.openMaterialOriginal({currentTarget:{dataset:{id:99}}});
 assert.equal(requests.length,3,"不查阅不属于当前材料列表的记录");
});
test("已归档会议详情保留授权材料入口，图片原件使用原生预览",async()=>{
 const page=miniPage("miniprogram/pages/project/index.js",{
  globalData:{perms:[]},
  api:async()=>({project:{id:"ARCHIVED",status:"已归档",name:"会议"},sectionAccess:{materials:true}})
 });
 page.data.id="ARCHIVED";await page.load();
 assert.equal(page.data.canMaterials,true);
 const {app,wx}=client("https://erp-prod.example.org/api",()=>{});
 app.setSession({accessToken:"session-test",user:{id:1},perms:[]});
 wx.downloadFile=o=>o.success({statusCode:200,tempFilePath:"/tmp/photo.jpg"});
 let imagePath="";
 wx.previewImage=o=>{imagePath=o.current;o.success();};
 await app.openOriginal("b".repeat(32)+".jpg");
 assert.equal(imagePath,"/tmp/photo.jpg");
});

test("合同与材料同源：归档只读、签署合同管理员删除及材料替换权限",async()=>{
 const pid="PARITY",key="a".repeat(32)+".pdf",photo="b".repeat(32)+".jpg";
 let phase="已归档",calls=[],page;
 const app={globalData:{perms:["material:write","material:file:replace","contract:write","contract:approve"]},
  api:async(url,method,body)=>{
   calls.push({url,method,body});
   if(url==="/projects/"+pid)return {project:{id:pid,status:phase},sectionAccess:{materials:true,contracts:true},materialsStatus:{categoryCatalog:{active:["课件"],history:["现场照片"],disabled:["现场照片"]}},
    materials:[{id:1,kind:"课件",file_key:key,file_name:"课件.pdf"},{id:2,kind:"现场照片",file_key:photo,file_name:"照片.jpg"},{id:3,kind:"合同",file_key:key,file_name:"合同.pdf"},{id:4,kind:"课件",file_key:key,deleted_at:"2026-11-26"}],
    contracts:[{id:"C-1",name:"合同",category:"会务需求",status:"已签署",amount:123,file_key:key}]};
   if(url==="/contracts/C-1"&&method==="DELETE")return {message:"已删除"};
   throw Error("unexpected "+url);
  },openOriginal:async k=>calls.push({key:k})};
 vm.runInNewContext(fs.readFileSync(path.join(__dirname,"../miniprogram/pages/materials/index.js"),"utf8"),
  {getApp:()=>app,Page:x=>page=x,wx:{showToast(){},showModal:o=>o.success({confirm:true})}});
 page.setData=p=>Object.assign(page.data,p);
 page.setData({pid,kind:"课件"});await page.loadKinds(pid);
 assert.equal(page.data.visibleFiles.length,1);
 assert.equal(page.data.materialMutationLocked,true);
 page.chooseKind({currentTarget:{dataset:{kind:"现场照片"}}});
 assert.equal(page.data.categoryDisabled,true);
 await page.openMaterialOriginal({currentTarget:{dataset:{id:2}}});
 assert.equal(calls.at(-1).key,photo);
 await page.chooseContracts();assert.equal(page.data.contractRows[0].canDelete,false);
 phase="筹备中";await page.loadKinds(pid);await page.loadContracts(pid);
 assert.equal(page.data.contractRows[0].canDelete,true);
 assert.equal(page.data.contractRows[0].canReplace,true);
 assert.equal(page.data.contractRows[0].amount,"123.00");
 await page.contractAction({currentTarget:{dataset:{id:"C-1",action:"delete"}}});
 assert.ok(calls.some(x=>x.url==="/contracts/C-1"&&x.method==="DELETE"));
});
