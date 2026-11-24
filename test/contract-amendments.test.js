"use strict";
/** 已签合同更正：独立审批、版本原件保留、核销定向复核、双人隔离与财务冻结。 */
const {test,before,after}=require("node:test");
const assert=require("node:assert/strict");
const {spawn}=require("node:child_process");
const {DatabaseSync}=require("node:sqlite");
const fs=require("node:fs"),path=require("node:path"),os=require("node:os");
const root=path.join(__dirname,"..");
const dir=fs.mkdtempSync(path.join(os.tmpdir(),"erp-amendments-"));
const DB=path.join(dir,"erp.db"),UP=path.join(dir,"uploads");
const PORT=8995,BASE="http://127.0.0.1:"+PORT;
const PDF=Buffer.from("%PDF-1.4\n1 0 obj\n<< /Type /Catalog /Title (correction) >>\nendobj\n%%EOF\n");
let proc,cookies={},pid,cid,oldKey,firstKey;
async function ready(){
 for(let i=0;i<375;i++){try{if((await fetch(BASE+"/api/health")).ok)return;}catch{}
 await new Promise(r=>setTimeout(r,150));}
 throw Error("合同更正测试服务启动失败");
}
async function login(user){
 const r=await fetch(BASE+"/api/auth/login",{method:"POST",headers:{"content-type":"application/json"},
  body:JSON.stringify({username:user,password:"123456"})});
 assert.equal(r.status,200,user+" login");cookies[user]=r.headers.get("set-cookie").split(";")[0];
}
async function req(user,method,url,data){
 const r=await fetch(BASE+url,{method,headers:{cookie:cookies[user],"content-type":"application/json"},
  body:data===undefined?undefined:JSON.stringify(data)});
 return {status:r.status,body:await r.json()};
}
async function upload(user,name){
 const r=await fetch(BASE+"/api/uploads?pid="+encodeURIComponent(pid),{
  method:"POST",headers:{cookie:cookies[user],"content-type":"application/pdf","x-file-name":encodeURIComponent(name)},body:PDF});
 return {status:r.status,body:await r.json()};
}
async function row(){
 const list=await req("admin","GET","/api/contracts?pid="+encodeURIComponent(pid));
 assert.equal(list.status,200);
 return list.body.rows.find(c=>c.id===cid);
}
async function revisions(){
 const r=await req("admin","GET","/api/contracts/"+cid+"/amendments");
 assert.equal(r.status,200,JSON.stringify(r.body));
 return r.body.rows;
}
function sql(fn){const db=new DatabaseSync(DB);try{return fn(db);}finally{db.close();}}
before(async()=>{
 proc=spawn(process.execPath,["--experimental-sqlite","server/index.js"],{
  cwd:root,env:{...process.env,ERP_DEMO_MODE:"1",ERP_PORT:String(PORT),ERP_DB:DB,ERP_UPLOAD_DIR:UP},
  stdio:["ignore","pipe","pipe"]});
 proc.stderr.on("data",d=>{const s=String(d);if(!s.includes("ExperimentalWarning"))process.stderr.write(s);});
 await ready();
 for(const user of ["admin","exec","assoc","guest"])await login(user);
 const created=await req("exec","POST","/api/projects",{
  name:"合同更正受控测试会议",assoc:"华东医学会",form:"线下",date:"2027-07-01",
  budget:100000,people:80,owner:"陈静",agenda:"上午论坛与下午讨论议程安排"});
 assert.equal(created.status,200,JSON.stringify(created.body));pid=created.body.project.id;
 assert.equal((await req("exec","POST","/api/projects/"+pid+"/transition",{action:"submit"})).status,200);
 assert.equal((await req("assoc","POST","/api/projects/"+pid+"/transition",{action:"approve"})).status,200);
 const first=await upload("exec","原始盖章合同.pdf");
 assert.equal(first.status,200,JSON.stringify(first.body));oldKey=first.body.key;
 const contract=await req("exec","POST","/api/contracts",{
  pid,name:"会务执行协议",vendor:"某场地服务企业",amount:20000,status:"草稿",
  category:"会务需求",file_key:oldKey,file_name:first.body.name,
  file_size:first.body.size,file_mime:first.body.mime});
 assert.equal(contract.status,200,JSON.stringify(contract.body));cid=contract.body.contract.id;
 assert.equal((await req("exec","POST","/api/contracts/"+cid+"/transition",{action:"submit"})).status,200);
 assert.equal((await req("assoc","POST","/api/contracts/"+cid+"/transition",{action:"sign"})).status,200);
 // 模拟已核销且尚未请付款项目：核销前四项已有结论，但第6项针对这份合同需要重核。
 sql(db=>{
  db.prepare("UPDATE projects SET status='已核销' WHERE id=?").run(pid);
  db.prepare("INSERT OR REPLACE INTO verify_steps(pid,step_no,name,result,remark,checked_by,checked_at) VALUES (?,?,?,?,?,?,?)")
    .run(pid,5,"劳务与专家费核对","通过","旧材料已核对","复核员","2026-11-20");
  db.prepare("INSERT OR REPLACE INTO verify_steps(pid,step_no,name,result,remark,checked_by,checked_at) VALUES (?,?,?,?,?,?,?)")
    .run(pid,6,"会务合同与发票关联核对","通过","旧版金额核验","复核员","2026-11-20");
 });
});
after(()=>{proc?.kill("SIGTERM");fs.rmSync(dir,{recursive:true,force:true});});
test("合同更正申请必须持有权限和真实已上传原件；提交后合同、核销不提前改变",async()=>{
 const next=await upload("exec","纠错盖章合同.pdf");
 assert.equal(next.status,200,JSON.stringify(next.body));firstKey=next.body.key;
 const guest=await req("guest","POST","/api/contracts/"+cid+"/amendments",{kind:"file_correction",reason:"提交错误附件，应当替换",file_key:firstKey});
 assert.equal(guest.status,403);
 const bad=await req("exec","POST","/api/contracts/"+cid+"/amendments",{
  kind:"file_correction",reason:"替换已上传错误合同原件",file_key:"a".repeat(32)+".pdf"});
 assert.notEqual(bad.status,200);
 const result=await req("exec","POST","/api/contracts/"+cid+"/amendments",{
  kind:"file_correction",reason:"原附件误传旧版本盖章合同，需要更正为真实盖章件",
  file_key:firstKey,file_name:next.body.name});
 assert.equal(result.status,200,JSON.stringify(result.body));
 assert.ok(result.body.approvalId);
 const duplicate=await req("exec","POST","/api/contracts/"+cid+"/amendments",{
  kind:"file_correction",reason:"再次重复提交更正申请",file_key:firstKey});
 assert.equal(duplicate.status,409);
 assert.equal((await row()).file_key,oldKey,"审批前不得替换原合同");
 assert.equal(sql(db=>db.prepare("SELECT result FROM verify_steps WHERE pid=? AND step_no=6").get(pid).result),"通过");
 const approval=await req("assoc","GET","/api/approvals?status="+encodeURIComponent("待审批"));
 assert.ok(approval.body.rows.some(a=>a.id===result.body.approvalId&&a.type==="合同更正审批"));
 const denied=await req("exec","POST","/api/approvals/"+result.body.approvalId+"/decide",{approve:true});
 assert.equal(denied.status,403,"无合同审批权限人员禁止自批");
});
test("独立审批后旧版永久留存，合同更新；已核销项目只重置第6步",async()=>{
 const waiting=(await revisions()).find(r=>r.status==="待审批");
 const ok=await req("assoc","POST","/api/approvals/"+waiting.approval_id+"/decide",{approve:true,comment:"盖章件核对同意"});
 assert.equal(ok.status,200,JSON.stringify(ok.body));
 const saved=await row();
 assert.equal(saved.status,"已签署");
 assert.equal(saved.file_key,firstKey);
 assert.equal(saved.amount,20000);
 const project=await req("admin","GET","/api/projects/"+pid);
 assert.equal(project.body.project.status,"待核销");
 assert.ok(project.body.materials.some(m=>m.kind==="合同"&&m.file_key===firstKey));
 assert.ok(!project.body.materials.some(m=>m.kind==="合同"&&m.file_key===oldKey));
 assert.equal(sql(db=>db.prepare("SELECT result FROM verify_steps WHERE pid=? AND step_no=5").get(pid).result),"通过");
 assert.equal(sql(db=>db.prepare("SELECT result FROM verify_steps WHERE pid=? AND step_no=6").get(pid).result),"待判定");
 const version=(await revisions()).find(r=>r.id===waiting.id);
 assert.equal(version.status,"已生效");
 assert.equal(version.old_file_key,oldKey);
 const old=await req("admin","GET","/api/contracts/"+cid+"/amendments");
 assert.ok(old.body.rows.some(r=>r.old_file_key===oldKey));
 const oldEvidence=sql(db=>db.prepare("SELECT deleted_at FROM materials WHERE file_key=?").get(oldKey));
 assert.ok(oldEvidence.deleted_at,"历史合同原件记录应软归档，不得消失");
 const downloaded=await fetch(BASE+"/api/uploads/"+oldKey,{headers:{cookie:cookies.admin}});
 assert.equal(downloaded.status,200,"旧版文件仍能被授权人员查看");
});
test("补充协议金额变更须换文件且提交人与审批人分离",async()=>{
 const up=await upload("assoc","补充协议-调整合同金额.pdf");
 assert.equal(up.status,200);
 const started=await req("assoc","POST","/api/contracts/"+cid+"/amendments",{
  kind:"supplement",reason:"合同双方签署补充协议调整执行服务费用",
  file_key:up.body.key,file_name:up.body.name,new_amount:21500});
 assert.equal(started.status,200,JSON.stringify(started.body));
 const self=await req("assoc","POST","/api/approvals/"+started.body.approvalId+"/decide",{approve:true});
 assert.equal(self.status,409,JSON.stringify(self.body));
 assert.equal(self.body.error.code,"NEED_SECOND_PERSON");
 assert.equal((await row()).amount,20000);
 const applied=await req("admin","POST","/api/approvals/"+started.body.approvalId+"/decide",{approve:true});
 assert.equal(applied.status,200,JSON.stringify(applied.body));
 assert.equal((await row()).amount,21500);
 assert.equal((await row()).file_key,up.body.key);
});
test("合同解除保留原金额在历史中，移出已签署有效合同范围",async()=>{
 const up=await upload("exec","双方合同解除协议.pdf");
 assert.equal(up.status,200);
 const started=await req("exec","POST","/api/contracts/"+cid+"/amendments",{
  kind:"terminate",reason:"双方正式签署解除协议，并确认未产生付款",file_key:up.body.key,file_name:up.body.name});
 assert.equal(started.status,200,JSON.stringify(started.body));
 const approved=await req("assoc","POST","/api/approvals/"+started.body.approvalId+"/decide",{approve:true});
 assert.equal(approved.status,200,JSON.stringify(approved.body));
 assert.equal((await row()).status,"已终止");
 assert.equal((await row()).amount,21500,"保留历史合同金额供审计");
 const active=sql(db=>db.prepare("SELECT COUNT(*) AS n FROM contracts WHERE pid=? AND status='已签署'").get(pid).n);
 assert.equal(active,0);
 assert.equal((await revisions()).filter(r=>r.status==="已生效").length,3);
});
test("有付款或结算记录时拒绝合同更正，且没有新审批记录",async()=>{
 const otherFile=await upload("exec","追加合同.pdf");
 const other=await req("exec","POST","/api/contracts",{
  pid,name:"待财务更正合同",vendor:"供应商乙",amount:1000,status:"已签署",sign_date:"2026-11-20",
  file_key:otherFile.body.key,file_name:otherFile.body.name,file_size:otherFile.body.size,file_mime:otherFile.body.mime});
 assert.equal(other.status,200,JSON.stringify(other.body));
 const otherId=other.body.contract.id;
 sql(db=>db.prepare("INSERT INTO payments(id,pid,type,payee,amount,status,created_at) VALUES (?,?,?,?,?,'已付款',?)")
  .run("PY-AMEND-BLOCK",pid,"学会公付","供应商乙",1000,"2026-11-21"));
 const next=await upload("exec","不允许覆盖账目.pdf");
 const denied=await req("exec","POST","/api/contracts/"+otherId+"/amendments",{
  kind:"supplement",reason:"有历史付款的合同不得直接调整金额",file_key:next.body.key,new_amount:500});
 assert.equal(denied.status,409);
 assert.equal(denied.body.error.code,"PAYMENT_RECONCILIATION_REQUIRED");
 sql(db=>{db.prepare("DELETE FROM payments WHERE id=?").run("PY-AMEND-BLOCK");
  db.prepare("UPDATE projects SET status='已结算' WHERE id=?").run(pid);});
 const locked=await req("exec","POST","/api/contracts/"+otherId+"/amendments",{
  kind:"file_correction",reason:"已结算合同不得直接更正原件",file_key:next.body.key});
 assert.equal(locked.status,409);
 assert.equal(locked.body.error.code,"SETTLED_CONTRACT_LOCKED");
});
