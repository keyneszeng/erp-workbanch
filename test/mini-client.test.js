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
