"use strict";
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { ASSOCS, MATERIAL_KINDS } = require("../server/lib/constants");
const dir = fs.mkdtempSync(path.join(os.tmpdir(),"erp-policy-"));
const port = 12500 + process.pid % 700;
const root = "http://127.0.0.1:" + port;
const phone = "13800138000";
let proc;
async function request(method, url, data, cookie="") {
  const res=await fetch(root+url,{method,headers:{"Content-Type":"application/json",...(cookie?{Cookie:cookie}:{})},
    body:data===undefined?undefined:JSON.stringify(data)});
  const body=await res.json();
  return { status:res.status,body,cookie:(res.headers.get("set-cookie")||"").split(";")[0] };
}
before(async () => {
  proc=spawn(process.execPath,["--experimental-sqlite","server/index.js"],{
    cwd:path.resolve(__dirname,".."), stdio:["ignore","pipe","pipe"],
    env:{...process.env,NODE_ENV:"test",ERP_DEMO_MODE:"0",ERP_DB_BACKEND:"",ERP_DB:path.join(dir,"test.db"),
      ERP_PORT:String(port),ERP_HOST:"127.0.0.1",ERP_BOOTSTRAP_ADMIN_PHONE:phone,
      ERP_SMS_PROVIDER:"test",ERP_SMS_TEST_MODE:"1",ERP_SESSION_FALLBACK:"0"}
  });
  let err="";proc.stderr.on("data",b=>err+=String(b));
  for(let i=0;i<180;i++){
    if(proc.exitCode!==null)throw Error("Server failed "+err);
    try{if((await request("GET","/api/health")).status===200)return;}catch{}
    await new Promise(r=>setTimeout(r,100));
  }
  throw Error("Server did not start "+err);
});
after(()=>{if(proc)proc.kill("SIGTERM");fs.rmSync(dir,{recursive:true,force:true});});
test("production: association member IDs, approved contract signing and pay-after-verify gate",async()=>{
  let r=await request("POST","/api/auth/login",{username:phone,password:"123456"});
  assert.equal(r.status,200,JSON.stringify(r.body));
  await request("POST","/api/auth/sms/send",{},r.cookie);
  r=await request("POST","/api/auth/password",{oldPassword:"123456",newPassword:"PolicyStrong2026",smsCode:"654321"},r.cookie);
  assert.equal(r.status,200,JSON.stringify(r.body));
  const cookie=r.cookie;
  const add=async (p,name,assoc)=>request("POST","/api/users",{phone:p,name,role:"assoc",assoc},cookie);
  const a=await add("13900139000","第一负责人",ASSOCS[0]);
  const b=await add("13700137000","其他协会负责人",ASSOCS[1]);
  assert.equal(a.status,200,JSON.stringify(a.body));
  assert.equal(b.status,200,JSON.stringify(b.body));
  const members=await request("GET","/api/users/assignable?assoc="+encodeURIComponent(ASSOCS[0]),undefined,cookie);
  assert.equal(members.status,200);
  assert.ok(members.body.rows.some(x=>x.id===a.body.user.id));
  assert.ok(!members.body.rows.some(x=>x.id===b.body.user.id));
  const base={name:"生产流程验证",assoc:ASSOCS[0],form:"线下",date:"2027-08-10",budget:20000,people:20,agenda:"09:00开幕；10:00专家分享"};
  const fake=await request("POST","/api/projects",{...base,owner:"任意伪造姓名"},cookie);
  assert.equal(fake.status,400);
  const foreign=await request("POST","/api/projects",{...base,owner_id:b.body.user.id},cookie);
  assert.equal(foreign.status,400);
  const created=await request("POST","/api/projects",{...base,owner_id:a.body.user.id},cookie);
  assert.equal(created.status,200,JSON.stringify(created.body));
  assert.equal(created.body.project.owner_id,a.body.user.id);
  const pid=created.body.project.id;
  const contract=await request("POST","/api/contracts",{pid,name:"会议服务合同",vendor:"服务供应商",amount:8000,status:"已签署"},cookie);
  assert.equal(contract.status,200,JSON.stringify(contract.body));
  assert.equal(contract.body.contract.status,"待签署","creation must not bypass signing approval");
  const pending=await request("GET","/api/approvals?type="+encodeURIComponent("合同审批"),undefined,cookie);
  assert.equal(pending.status,200);
  const ap=pending.body.rows.find(x=>x.ref_id===contract.body.contract.id&&x.status==="待审批");
  assert.ok(ap,"contract approval was created");
  const decided=await request("POST","/api/approvals/"+ap.id+"/decide",{approve:true,comment:"同意签署"},cookie);
  assert.equal(decided.status,200,JSON.stringify(decided.body));
  const signed=await request("GET","/api/contracts?pid="+pid,undefined,cookie);
  assert.equal(signed.body.rows.find(x=>x.id===contract.body.contract.id).status,"已签署");
  const premature=await request("POST","/api/payments",{pid,type:"学会公付",payee:"供应商",payee_bank:"中国银行",payee_account:"1234567890123456",amount:100,invoice_no:"INV-1"},cookie);
  assert.equal(premature.status,409,"payment cannot precede verification");

  for (const action of ["submit","approve","prep","exec"]) {
    const move=await request("POST","/api/projects/"+pid+"/transition",{action},cookie);
    assert.equal(move.status,200,"transition "+action+": "+JSON.stringify(move.body));
  }
  const invoiceData=Buffer.from("%PDF-1.4\\n1 0 obj\\n<<>>\\nendobj\\n%%EOF\\n");
  const uploaded=await fetch(root+"/api/uploads?pid="+pid,{
    method:"POST",headers:{Cookie:cookie,"Content-Type":"application/octet-stream","X-File-Name":"invoice.pdf"},
    body:invoiceData
  });
  const uploadBody=await uploaded.json();
  assert.equal(uploaded.status,200,JSON.stringify(uploadBody));
  // 生产需求：必须完整录入七项字段、文件须为本项目可访问的已上传原件。
  const demandBase={grp:"设计",item:"会场台卡",need:"需要",spec:"10张",owner_id:a.body.user.id,
    due:"2027-08-10",budget_owner:ASSOCS[0],budget:"200",status:"已交付"};
  const fakeAttach={...demandBase,attach:"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.pdf"};
  let demand=await request("PATCH","/api/demand/"+pid,{items:[fakeAttach]},cookie);
  assert.equal(demand.status,200,JSON.stringify(demand.body));
  let confirm=await request("POST","/api/demand/"+pid+"/confirm",{},cookie);
  assert.equal(confirm.status,200,"会务需求不再要求附件必填");
  await request("POST","/api/demand/"+pid+"/unarchive",{},cookie);
  demand=await request("PATCH","/api/demand/"+pid,{items:[{...demandBase,attach:uploadBody.key}]},cookie);
  assert.equal(demand.status,200,JSON.stringify(demand.body));
  confirm=await request("POST","/api/demand/"+pid+"/confirm",{},cookie);
  assert.equal(confirm.status,200,JSON.stringify(confirm.body));
  const revisions=await request("GET","/api/demand/"+pid+"/revisions",undefined,cookie);
  assert.equal(revisions.status,200);
  assert.ok(revisions.body.rows.length>=3,"需求保存与确认应有独立版本记录");
  const editBlocked=await request("PATCH","/api/demand/"+pid,{items:[demandBase]},cookie);
  assert.equal(editBlocked.status,409,"归档需求不可直接编辑");
  const unarchive=await request("POST","/api/demand/"+pid+"/unarchive",{},cookie);
  assert.equal(unarchive.status,200);
  const reset=await request("POST","/api/demand/"+pid+"/reset",{},cookie);
  assert.equal(reset.status,200);

  for (const kind of [...new Set([...MATERIAL_KINDS,"会议通知","劳务收集表","劳务协议","串场"])]) {
    const attachment = kind === "发票" ? uploadBody : await (async () => {
      const response = await fetch(root + "/api/uploads?pid=" + pid, {
        method:"POST",
        headers:{Cookie:cookie,"Content-Type":"application/octet-stream","X-File-Name":"support.pdf"},
        body:invoiceData
      });
      const data = await response.json();
      assert.equal(response.status,200,JSON.stringify(data));
      return data;
    })();
    const item=await request("POST","/api/projects/"+pid+"/materials",{
      kind,name:kind+"验收材料",version:"终版",file_key:attachment.key,
      file_name:"support.pdf",file_mime:"application/pdf"
    },cookie);
    assert.equal(item.status,200,"material "+kind+": "+JSON.stringify(item.body));
  }

  const allMaterials=await request("GET","/api/materials",undefined,cookie);
  assert.equal(allMaterials.status,200);
  const projectMaterials=allMaterials.body.rows.filter(x=>x.pid===pid);
  const agendaMaterial=projectMaterials.find(x=>x.kind==="议程");
  const courseMaterial=projectMaterials.find(x=>x.kind==="课件");
  assert.ok(agendaMaterial&&courseMaterial);
  let workbench=await request("POST","/api/projects/"+pid+"/material-workbench/agenda",
    {materialId:agendaMaterial.id,entries:[{speaker:"测试讲者",topic:"课题甲"}]},cookie);
  assert.equal(workbench.status,200,JSON.stringify(workbench.body));
  const courseTask=workbench.body.tasks.find(x=>x.kind==="课件");
  assert.ok(courseTask);
  let compared=await request("POST","/api/projects/"+pid+"/material-workbench/tasks/"+courseTask.id+"/compare",
    {materialId:courseMaterial.id},cookie);
  assert.equal(compared.status,200);
  assert.equal(compared.body.status,"不一致","不匹配的材料不得自动通过");
  let toggled=await request("POST","/api/projects/"+pid+"/material-workbench/modules",
    {kind:"课件",enabled:false},cookie);
  assert.equal(toggled.status,200);
  const disabledReview=await request("POST","/api/projects/"+pid+"/material-workbench/tasks/"+courseTask.id+"/review",
    {approved:true,reason:"复核材料确实正确"},cookie);
  assert.equal(disabledReview.status,409,"模块停用时不得绕过复核门禁");
  toggled=await request("POST","/api/projects/"+pid+"/material-workbench/modules",
    {kind:"课件",enabled:true},cookie);
  assert.equal(toggled.status,200);
  const manualReview=await request("POST","/api/projects/"+pid+"/material-workbench/tasks/"+courseTask.id+"/review",
    {approved:true,reason:"已通过线下逐页核验"},cookie);
  assert.equal(manualReview.status,200,JSON.stringify(manualReview.body));
  assert.equal(manualReview.body.task.status,"复核通过");
  let step=await request("POST","/api/projects/"+pid+"/transition",{action:"request_verify"},cookie);
  assert.equal(step.status,200,JSON.stringify(step.body));
  const record={name:"测试讲者",time:"2027-08-10",role:"讲者",amount:"1000",bankAccount:"TEST_ACCOUNT_REFERENCE"};
  const sop={
    1:{documentKind:"会议通知",meetingName:base.name,meetingDate:base.date,organizer:base.assoc,sponsor:"不适用",stamped:true,final:true},
    2:{agendaSpeakers:["测试讲者"],collectionSpeakers:["测试讲者"],agreementSpeakers:["测试讲者"],noOmissions:true},
    3:{signedAttendance:true},
    4:{agendaTopics:["课题甲"],courseTopics:["课题甲"],hostTitleMatches:true,hostNameLogoMatches:true,sponsorLogoPages:[]},
    5:{collectionRecords:[record],agreementRecords:[record]},
    6:{draftAmount:8000,meetingName:base.name,meetingDate:base.date}
  };
  // 真实例外单闭环：审批并不等于核销，必须登记整改和关联材料后再回原步骤。
  let failed=await request("POST","/api/projects/"+pid+"/verify/steps/1",
    {result:"不通过",remark:"盖章文件需要补充校核"},cookie);
  assert.equal(failed.status,200,JSON.stringify(failed.body));
  const exceptionId=failed.body.verification.exceptions.find(x=>x.step_no===1&&x.status==="待审批")?.id;
  assert.ok(exceptionId);
  const earlyPass=await request("POST","/api/projects/"+pid+"/verify/steps/1",
    {result:"通过",evidence:sop[1]},cookie);
  assert.equal(earlyPass.status,409,"未处理的例外不允许改判通过");
  let exception=await request("POST","/api/exceptions/"+exceptionId+"/decide",
    {approve:true,comment:"同意补正后再次复核"},cookie);
  assert.equal(exception.status,200,JSON.stringify(exception.body));
  const beforeRemediation=await request("POST","/api/projects/"+pid+"/verify/steps/1",
    {result:"通过",evidence:sop[1]},cookie);
  assert.equal(beforeRemediation.status,409,"只有例外审批没有整改证据，不得核销通过");
  exception=await request("POST","/api/exceptions/"+exceptionId+"/resolve",
    {resolution:"已补充原件并完成逐项确认",materialId:agendaMaterial.id},cookie);
  assert.equal(exception.status,200,JSON.stringify(exception.body));
  for(let no=1;no<=5;no++){
    step=await request("POST","/api/projects/"+pid+"/verify/steps/"+no,{result:"通过",evidence:sop[no]},cookie);
    assert.equal(step.status,200,"verification "+no+": "+JSON.stringify(step.body));
  }
  step=await request("POST","/api/projects/"+pid+"/verify/steps/6",{result:"通过",invoiceAmount:7999,evidence:sop[6]},cookie);
  assert.equal(step.status,409,"invoice total cannot differ from signed contracts");
  step=await request("POST","/api/projects/"+pid+"/verify/steps/6",{result:"通过",invoiceAmount:8000,evidence:sop[6]},cookie);
  assert.equal(step.status,200,JSON.stringify(step.body));
  assert.equal(step.body.verification.exceptions.find(x=>x.id===exceptionId).status,"已闭环",
    "整改必须在原步骤核销通过后才闭环");
  const freeze=await request("POST","/api/contracts",{pid,name:"Late Contract",vendor:"X",amount:1,status:"草稿"},cookie);
  assert.equal(freeze.status,409,"contracts must freeze after invoice verification");

  // 模拟升级前的历史核销结果：字段标记「通过」但缺结构化证据，不能解锁财务结算。
  const { DatabaseSync }=require("node:sqlite");
  const migrationDb=new DatabaseSync(path.join(dir,"test.db"));
  migrationDb.prepare("UPDATE verify_steps SET evidence_json=NULL WHERE pid=? AND step_no=1").run(pid);
  migrationDb.close();
  let status=await request("GET","/api/projects/"+pid+"/verify",undefined,cookie);
  assert.equal(status.body.verification.complete,false,"旧版未留证的通过结果不能满足生产核销门禁");
  let blocked=await request("POST","/api/projects/"+pid+"/transition",{action:"verify_pass"},cookie);
  assert.equal(blocked.status,409,"历史缺证据不得进入财务结算");
  // 重新确认前置步骤后，下游旧证据全部失效，必须顺序重新核验。
  step=await request("POST","/api/projects/"+pid+"/verify/steps/1",{result:"通过",evidence:sop[1]},cookie);
  assert.equal(step.status,200,JSON.stringify(step.body));
  status=await request("GET","/api/projects/"+pid+"/verify",undefined,cookie);
  assert.equal(status.body.verification.steps.find(s=>s.no===2).result,"待判定");
  assert.equal(status.body.verification.steps.find(s=>s.no===6).result,"待判定");
  for(let no=2;no<=5;no++){
    step=await request("POST","/api/projects/"+pid+"/verify/steps/"+no,{result:"通过",evidence:sop[no]},cookie);
    assert.equal(step.status,200,"repeat verification "+no+": "+JSON.stringify(step.body));
  }
  step=await request("POST","/api/projects/"+pid+"/verify/steps/6",
    {result:"通过",invoiceAmount:8000,evidence:sop[6]},cookie);
  assert.equal(step.status,200,JSON.stringify(step.body));
  step=await request("POST","/api/projects/"+pid+"/transition",{action:"verify_pass"},cookie);
  assert.equal(step.status,200,JSON.stringify(step.body));
  const settlementData={action:"settle",payee_bank:"中国银行北京分行",payee_account:"1234567890123456"};
  let settle=await request("POST","/api/projects/"+pid+"/transition",settlementData,cookie);
  assert.equal(settle.status,409,"no payment must block settlement");
  const paymentData={pid,type:"学会公付",payee:"服务供应商",payee_bank:"中国银行北京分行",
    payee_account:"1234567890123456",amount:8000,invoice_no:"INV-2027-001"};
  const payment=await request("POST","/api/payments",paymentData,cookie);
  assert.equal(payment.status,200,JSON.stringify(payment.body));
  settle=await request("POST","/api/projects/"+pid+"/transition",settlementData,cookie);
  assert.equal(settle.status,409,"pending payment blocks settlement");
  const approved=await request("POST","/api/payments/"+payment.body.payment.id+"/approve",{approve:true},cookie);
  assert.equal(approved.status,200,JSON.stringify(approved.body));
  settle=await request("POST","/api/projects/"+pid+"/transition",settlementData,cookie);
  assert.equal(settle.status,409,"approved but unpaid payment blocks settlement");
  const paid=await request("POST","/api/payments/"+payment.body.payment.id+"/pay",{},cookie);
  assert.equal(paid.status,200,JSON.stringify(paid.body));
  settle=await request("POST","/api/projects/"+pid+"/transition",settlementData,cookie);
  assert.equal(settle.status,200,JSON.stringify(settle.body));

});
