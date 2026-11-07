"use strict";
/** 合同材料逐条替换：真实上传、默认禁止、总管理员授权/撤销、台账重新签署、冻结与跨项目。 */
const {test,before,after}=require("node:test");
const assert=require("node:assert/strict");
const {spawn}=require("node:child_process");
const fs=require("node:fs"),path=require("node:path"),os=require("node:os");
const dir=fs.mkdtempSync(path.join(os.tmpdir(),"erp-contract-material-replace-"));
const DB=path.join(dir,"erp.db"),UP=path.join(dir,"uploads");
const PORT=8994,BASE="http://127.0.0.1:"+PORT,PID="MP-2026-001";
const A=Buffer.from("%PDF-1.4\n1 0 obj\n<< /Type /Catalog /Title (old) >>\nendobj\n%%EOF\n");
const B=Buffer.from("%PDF-1.4\n1 0 obj\n<< /Type /Catalog /Title (new) >>\nendobj\n%%EOF\n");
let proc,cookie={},original,id,execId;
async function ready(){
 for(let i=0;i<150;i++){try{if((await fetch(BASE+"/api/health")).ok)return;}catch{}
 await new Promise(r=>setTimeout(r,160));}
 throw Error("test ERP server not ready");
}
async function login(name){
 const r=await fetch(BASE+"/api/auth/login",{method:"POST",
   headers:{"content-type":"application/json"},
   body:JSON.stringify({username:name,password:"123456"})});
 assert.equal(r.status,200,name+" login");
 cookie[name]=r.headers.get("set-cookie").split(";")[0];
}
async function request(name,method,url,data){
 const r=await fetch(BASE+url,{method,
   headers:{cookie:cookie[name],"content-type":"application/json"},
   body:data===undefined?undefined:JSON.stringify(data)});
 const body=await r.json();return {status:r.status,body};
}
async function upload(name,buffer,filename,pid=PID){
 const r=await fetch(BASE+"/api/uploads?pid="+encodeURIComponent(pid),{method:"POST",
   headers:{cookie:cookie[name],"content-type":"application/octet-stream",
   "x-file-name":encodeURIComponent(filename)},body:buffer});
 return {status:r.status,body:await r.json()};
}
async function materialByKey(key){
 const res=await request("admin","GET","/api/materials");
 assert.equal(res.status,200);
 return res.body.rows.find(x=>x.file_key===key);
}
before(async()=>{
 proc=spawn(process.execPath,["--experimental-sqlite","server/index.js"],{
 cwd:path.join(__dirname,".."),env:{...process.env,ERP_DEMO_MODE:"1",
 ERP_PORT:String(PORT),ERP_DB:DB,ERP_UPLOAD_DIR:UP},stdio:["ignore","pipe","pipe"]});
 proc.stderr.on("data",chunk=>{if(!String(chunk).includes("ExperimentalWarning"))process.stderr.write(chunk)});
 await ready();
 for(const n of ["admin","assoc","exec","finance","guest"])await login(n);
 const users=await request("admin","GET","/api/users");
 assert.equal(users.status,200);
 execId=users.body.rows.find(x=>x.username==="exec").id;
 const u=await upload("admin",A,"旧合同材料.pdf");
 assert.equal(u.status,200,JSON.stringify(u.body));
 original=u.body.key;
 const added=await request("admin","POST","/api/projects/"+PID+"/materials",{
   kind:"合同",name:"独立合同原件",version:"v1",
   file_key:original,file_name:u.body.name,file_size:u.body.size,file_mime:u.body.mime});
 assert.equal(added.status,200,JSON.stringify(added.body));
 id=(await materialByKey(original)).id;
});
after(()=>{proc?.kill("SIGTERM");fs.rmSync(dir,{recursive:true,force:true});});
test("未获授权的执行人员不可修改，即使原本拥有材料登记权限",async()=>{
 const me=await request("exec","GET","/api/auth/me");
 assert.equal(me.status,200);
 assert.equal(me.body.perms.includes("material:write"),true);
 assert.equal(me.body.perms.includes("material:contract:replace"),false);
 const file=await upload("exec",B,"未授权修改.pdf");
 assert.equal(file.status,200,JSON.stringify(file.body));
 const denied=await request("exec","PATCH","/api/materials/"+id+"/file",{
   expected_file_key:original,file_key:file.body.key,file_name:file.body.name});
 assert.equal(denied.status,403,JSON.stringify(denied.body));
 assert.ok(await materialByKey(original));
});
test("总管理员可按账号授权；执行人员重新登录后才能替换原件",async()=>{
 const users=await request("admin","GET","/api/users");
 assert.equal(Number(users.body.rows.find(x=>x.id===execId).material_contract_replace),0);
 const grant=await request("admin","PATCH","/api/users/"+execId,{material_contract_replace:1});
 assert.equal(grant.status,200,JSON.stringify(grant.body));
 await login("exec");
 const me=await request("exec","GET","/api/auth/me");
 assert.equal(me.body.perms.includes("material:contract:replace"),true);
 const u=await upload("exec",B,"修订合同.pdf");
 assert.equal(u.status,200);
 const ok=await request("exec","PATCH","/api/materials/"+id+"/file",{
   expected_file_key:original,file_key:u.body.key,file_name:u.body.name});
 assert.equal(ok.status,200,JSON.stringify(ok.body));
 assert.equal(ok.body.replaced,true);
 assert.equal(ok.body.oldDeleted,true,"无引用的旧合同原件应删除");
 assert.equal((await materialByKey(u.body.key)).id,id);
 assert.equal(await materialByKey(original),undefined);
 const old=await request("admin","GET","/api/uploads/"+original);
 assert.equal(old.status,404,"旧文件不允许再通过下载接口访问");
 original=u.body.key;
});
test("拒绝过期文件版本、跨项目文件与非合同类型，原件保持不变",async()=>{
 const file=await upload("exec",B,"新候选.pdf");
 assert.equal(file.status,200);
 const stale=await request("exec","PATCH","/api/materials/"+id+"/file",{
   expected_file_key:"11111111111111111111111111111111.pdf",file_key:file.body.key});
 assert.equal(stale.status,409);
 const cross=await upload("admin",B,"其他项目合同.pdf","MP-2026-003");
 assert.equal(cross.status,200,JSON.stringify(cross.body));
 const crossRes=await request("admin","PATCH","/api/materials/"+id+"/file",{
   expected_file_key:original,file_key:cross.body.key});
 assert.equal(crossRes.status,403);
 const photo=await upload("admin",A,"测试普通材料.pdf");
 assert.equal(photo.status,200);
 const create=await request("admin","POST","/api/projects/"+PID+"/materials",{
   kind:"其他材料",name:"非合同",file_key:photo.body.key,file_name:photo.body.name,file_mime:photo.body.mime});
 assert.equal(create.status,200);
 const row=await materialByKey(photo.body.key);
 const badKind=await request("admin","PATCH","/api/materials/"+row.id+"/file",{
   expected_file_key:photo.body.key,file_key:file.body.key});
 assert.equal(badKind.status,409);
 assert.ok(await materialByKey(original));
});
test("台账合同关联材料的替换必须同步并撤销旧签署状态",async()=>{
 const u=await upload("exec",A,"台账合同原件.pdf");
 assert.equal(u.status,200);
 const create=await request("exec","POST","/api/contracts",{
  pid:PID,name:"受控签署原件测试",vendor:"甲方供货单位",amount:1735,status:"草稿",
  file_key:u.body.key,file_name:u.body.name,file_size:u.body.size,file_mime:u.body.mime});
 assert.equal(create.status,200,JSON.stringify(create.body));
 const cid=create.body.contract.id;
 const linked=await materialByKey(u.body.key);
 assert.ok(linked&&linked.kind==="合同");
 const pending=await request("exec","POST","/api/contracts/"+cid+"/transition",{action:"submit"});
 assert.equal(pending.status,200,JSON.stringify(pending.body));
 const update=await upload("exec",B,"台账更换盖章件.pdf");
 assert.equal(update.status,200);
 const replaced=await request("exec","PATCH","/api/materials/"+linked.id+"/file",{
  expected_file_key:u.body.key,file_key:update.body.key,file_name:update.body.name});
 assert.equal(replaced.status,200,JSON.stringify(replaced.body));
 assert.equal(replaced.body.linkedContract,cid);
 const list=await request("admin","GET","/api/contracts?pid="+PID);
 const contract=list.body.rows.find(x=>x.id===cid);
 assert.equal(contract.file_key,update.body.key);
 assert.equal(contract.status,"草稿","替换后禁止沿用旧签署审批");
 assert.ok(await materialByKey(update.body.key));
 const approvals=await request("admin","GET","/api/approvals?type="+encodeURIComponent("合同审批"));
 assert.equal(approvals.status,200);
 assert.ok(!approvals.body.rows.some(x=>x.ref_id===cid&&x.status==="待审批"));
});
test("总管理员撤销授权后账号不能继续替换；冻结项目强制拒绝",async()=>{
 const revoked=await request("admin","PATCH","/api/users/"+execId,{material_contract_replace:0});
 assert.equal(revoked.status,200);
 await login("exec");
 const me=await request("exec","GET","/api/auth/me");
 assert.equal(me.body.perms.includes("material:contract:replace"),false);
 const newFile=await upload("exec",B,"撤权后文件.pdf");
 assert.equal(newFile.status,200);
 const denied=await request("exec","PATCH","/api/materials/"+id+"/file",{
  expected_file_key:original,file_key:newFile.body.key});
 assert.equal(denied.status,403);
 const {DatabaseSync}=require("node:sqlite");
 const db=new DatabaseSync(DB);
 db.prepare("UPDATE projects SET status='已归档' WHERE id=?").run(PID);
 db.close();
 const frozen=await request("admin","PATCH","/api/materials/"+id+"/file",{
  expected_file_key:original,file_key:newFile.body.key});
 assert.equal(frozen.status,409,JSON.stringify(frozen.body));
});
