"use strict";
/** Superadmin corrections: sealed projects, contracts, settlements, revisions, privacy and permissions. */
const {test,before,after}=require("node:test");
const assert=require("node:assert/strict");
const {spawn}=require("node:child_process");
const fs=require("node:fs"),os=require("node:os"),path=require("node:path");
const dir=fs.mkdtempSync(path.join(os.tmpdir(),"erp-admin-content-"));
const port=8997,BASE="http://127.0.0.1:"+port;
let server,adminCookie="",execCookie="";
async function login(username){
 const r=await fetch(BASE+"/api/auth/login",{method:"POST",
  headers:{"Content-Type":"application/json"},body:JSON.stringify({username,password:"123456"})});
 assert.equal(r.status,200,username+" login");
 return String(r.headers.get("set-cookie")||"").split(";")[0];
}
async function call(method,url,body,cookie=adminCookie){
 const r=await fetch(BASE+url,{method,headers:{cookie,...(body?{"Content-Type":"application/json"}:{})},
  body:body?JSON.stringify(body):undefined});
 return {status:r.status,data:await r.json()};
}
before(async()=>{
 server=spawn(process.execPath,["--experimental-sqlite","server/index.js"],{
  cwd:path.join(__dirname,".."),env:{...process.env,ERP_DEMO_MODE:"1",ERP_PORT:String(port),
   ERP_DB:path.join(dir,"db.sqlite"),ERP_UPLOAD_DIR:path.join(dir,"uploads")},
  stdio:["ignore","pipe","pipe"]});
 server.stderr.on("data",x=>{if(!String(x).includes("ExperimentalWarning"))process.stderr.write(x);});
 let ok=false;
 for(let i=0;i<300;i++){
  try{if((await fetch(BASE+"/api/health")).ok){ok=true;break;}}catch{}
  await new Promise(r=>setTimeout(r,130));
 }
 assert.ok(ok,"ERP booted");
 adminCookie=await login("admin");execCookie=await login("exec");
});
after(()=>{server?.kill("SIGTERM");fs.rmSync(dir,{recursive:true,force:true});});
test("仅总管理员可以读取类别、目录、明细、修订历史及更正",async()=>{
 for(const endpoint of ["/api/admin/content/types","/api/admin/content/projects",
   "/api/admin/content/MP-2026-015/materials",
   "/api/admin/content/MP-2026-015/materials/1/history"]){
  assert.equal((await call("GET",endpoint,null,execCookie)).status,403,endpoint);
  assert.equal((await call("GET",endpoint,null,"")).status,401,endpoint);
 }
 assert.equal((await call("PATCH","/api/admin/content/MP-2026-015/project/MP-2026-015",{
  reason:"普通人员不得修订",changes:{name:"非法修改"},expected:{name:"原名称"}
 },execCookie)).status,403);
 const types=await call("GET","/api/admin/content/types");
 assert.equal(types.status,200);
 assert.ok(types.data.types.length>=18,"覆盖所有主要业务内容模块");
 const list=await call("GET","/api/admin/content/projects");
 assert.equal(list.status,200);
 assert.ok(list.data.rows.some(p=>p.status==="已归档"));
});
test("已归档项目随时更正名称并保留版本；并发覆盖与非法字段均被拒绝",async()=>{
 const pid="MP-2026-015";
 const before=await call("GET","/api/admin/content/"+pid+"/project");
 assert.equal(before.status,200,JSON.stringify(before.data));
 const original=before.data.rows[0].name;
 assert.equal(before.data.project.status,"已归档");
 const target=original+"（管理员纠错）";
 const path="/api/admin/content/"+pid+"/project/"+pid;
 const update=await call("PATCH",path,{reason:"依据会议正式材料更正会议名称",
  changes:{name:target},expected:{name:original}});
 assert.equal(update.status,200,JSON.stringify(update.data));
 assert.equal(update.data.row.name,target);
 assert.equal(update.data.row.status,"已归档");
 assert.equal((await call("GET","/api/projects/"+pid)).data.project.name,target);
 const history=await call("GET",path+"/history");
 assert.equal(history.status,200);
 assert.ok(history.data.rows.length>0);
 assert.equal(JSON.parse(history.data.rows[0].before_json).name,original);
 assert.equal(JSON.parse(history.data.rows[0].after_json).name,target);
 const stale=await call("PATCH",path,{reason:"测试并发场景旧值必须被拒绝",
  changes:{name:"非法覆盖"},expected:{name:original}});
 assert.equal(stale.status,409);
 assert.equal(stale.data.error.code,"CONTENT_CHANGED");
 assert.equal((await call("PATCH",path,{reason:"测试非法系统字段不可被篡改",
  changes:{id:"MP-INVALID"},expected:{id:pid}})).status,400);
 assert.equal((await call("PATCH",path,{reason:"短",changes:{name:"x"},expected:{name:target}})).status,400);
});
test("已结算和已归档的财务结余可更正并按收入减支出重算",async()=>{
 const pid="MP-2026-015";
 const list=await call("GET","/api/admin/content/"+pid+"/settlements");
 assert.equal(list.status,200);
 assert.ok(list.data.rows.length>=1,"测试数据须有结算记录");
 const row=list.data.rows[0];
 const next=Number((row.income+8.25).toFixed(2));
 const updated=await call("PATCH","/api/admin/content/"+pid+"/settlements/"+row.id,{
  reason:"结算复核后修正收入及对应结余",
  changes:{income:next},expected:{income:row.income}
 });
 assert.equal(updated.status,200,JSON.stringify(updated.data));
 assert.equal(updated.data.row.profit,Number((next-row.expense).toFixed(2)));
 assert.equal((await call("GET","/api/admin/content/"+pid+"/settlements")).data.rows[0].profit,updated.data.row.profit);
});
test("封存合同、材料和付款单都允许总管理员更正，身份、文件归属不可改",async()=>{
 const pid="MP-2026-015";
 for(const [kind,key,suffix] of [["contracts","remark","（合同修订）"],["materials","name","（材料修订）"],
   ["payments","remark","（付款修订）"]]){
  const list=await call("GET","/api/admin/content/"+pid+"/"+kind);
  assert.equal(list.status,200,kind+" "+JSON.stringify(list.data));
  assert.ok(list.data.rows.length,kind+" should be seeded");
  const item=list.data.rows[0],original=item[key]??null;
  const target=(original||"")+" "+suffix;
  const base="/api/admin/content/"+pid+"/"+kind+"/"+item.id;
  const result=await call("PATCH",base,{reason:"总管理员复核历史凭证后修订内容",
   changes:{[key]:target},expected:{[key]:original}});
  assert.equal(result.status,200,kind+" "+JSON.stringify(result.data));
  assert.equal(result.data.row[key],target.trim());
  assert.equal((await call("GET",base+"/history")).data.rows.length,1);
  assert.equal((await call("PATCH",base,{reason:"非法覆盖原始文件归属测试",
   changes:{file_key:"00000000000000000000000000000000.pdf"},
   expected:{file_key:""}})).status,400);
 }
});
test("重要系统字段不出现在列表；银行账号修改的常规审计只显示脱敏文本",async()=>{
 const pid="MP-2026-015";
 const list=await call("GET","/api/admin/content/"+pid+"/invitations");
 assert.equal(list.status,200);
 assert.ok(list.data.rows.every(r=>!("token_hash" in r)),"不能暴露邀请令牌");
 const materials=await call("GET","/api/admin/content/"+pid+"/materials");
 assert.ok(materials.data.rows.every(r=>!("file_key" in r)),"附件标识须走专门文件更正");
 const payments=await call("GET","/api/admin/content/"+pid+"/payments");
 const row=payments.data.rows[0];
 if(row){
  const next="测试银行-审计保密";
  const u=await call("PATCH","/api/admin/content/"+pid+"/payments/"+row.id,{
   reason:"核对账户所属银行名称避免误付",
   changes:{payee_bank:next},expected:{payee_bank:row.payee_bank}
  });
  assert.equal(u.status,200,JSON.stringify(u.data));
  const audit=await call("GET","/api/audit");
  if(audit.status===200){
   const texts=JSON.stringify(audit.data);
   assert.ok(!texts.includes(row.payee_bank+"→"+next));
  }
 }
});
