"use strict";
const {test,before,after}=require("node:test");
const assert=require("node:assert/strict"),{spawn}=require("node:child_process");
const fs=require("node:fs"),os=require("node:os"),path=require("node:path");
const {DatabaseSync}=require("node:sqlite");
const PizZip=require("pizzip");
const {extract}=require("../server/lib/verify-office-text");
const folder=fs.mkdtempSync(path.join(os.tmpdir(),"erp-verify-ocr-"));
const port=8992,base="http://127.0.0.1:"+port,pid="MP-2026-003";
let server,db,cookies={};
const pathStep=no=>"/api/projects/"+pid+"/verify/steps/"+no;
async function call(who,method,url,body){
 const response=await fetch(base+url,{method,headers:{
  ...(cookies[who]?{cookie:cookies[who]}:{}),
  ...(body!==undefined?{"content-type":"application/json"}:{})
 },body:body===undefined?undefined:JSON.stringify(body)});
 const data=await response.json().catch(()=>null);
 return {status:response.status,data};
}
async function login(who){
 const res=await fetch(base+"/api/auth/login",{method:"POST",headers:{"content-type":"application/json"},
  body:JSON.stringify({username:who,password:"123456"})});
 assert.equal(res.status,200,who+" login");
 cookies[who]=(res.headers.get("set-cookie")||"").split(";")[0];
}
function addDoc(kind,name,raw,key,version="v1"){
 const result=db.prepare(
  "INSERT INTO materials(pid,kind,name,version,uploader,created_at,file_key,file_name,file_size,file_mime) VALUES (?,?,?,?,?,?,?,?,?,?)"
 ).run(pid,kind,name,version,"核销自动化测试","2026-11-07 11:00",key,name+".pdf",512,"application/pdf");
 const materialId=Number(result.lastInsertRowid);
 db.prepare("INSERT INTO material_ocr_results(material_id,pid,file_key,recognized_text,suggestions_json,engine,mode,pages,total_pages,truncated,updated_at,updated_by) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)")
  .run(materialId,pid,key,raw,"[]","Poppler pdftotext","pdf-text",1,1,0,"2026-11-07 11:00","测试操作员");
 return materialId;
}
before(async()=>{
 server=spawn(process.execPath,["--experimental-sqlite","server/index.js"],{
  cwd:path.resolve(__dirname,".."),
  env:{...process.env,ERP_DEMO_MODE:"1",ERP_PORT:String(port),
    ERP_DB:path.join(folder,"data.sqlite"),ERP_UPLOAD_DIR:path.join(folder,"uploads")},
  stdio:["ignore","pipe","pipe"]});
 let error="";server.stderr.on("data",x=>error+=String(x));
 let ok=false;
 for(let i=0;i<500;i++){
  try{if((await fetch(base+"/api/health")).ok){ok=true;break;}}catch{}
  if(server.exitCode!==null)throw Error(error);
  await new Promise(r=>setTimeout(r,120));
 }
 assert.ok(ok,"server unavailable "+error);
 db=new DatabaseSync(path.join(folder,"data.sqlite"));
 db.exec("PRAGMA busy_timeout=5000");
 for(const who of ["admin","exec","guest"])await login(who);
 addDoc("终版议程","终版议程OCR",
  "讲者：张三教授 课题：精准诊疗技术新进展\n日期：2026-11-03",
  "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.pdf","终版");
 addDoc("课件","张三课件",
  "课件主题：精准诊疗技术新进展",
  "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.pdf");
});
after(()=>{db?.close();server?.kill("SIGTERM");fs.rmSync(folder,{recursive:true,force:true});});
test("只核销授权账号可触发OCR扫描及查看比对，不能绕过权限",async()=>{
 assert.equal((await call(null,"POST",pathStep(4)+"/scan",{})).status,401);
 assert.equal((await call("guest","POST",pathStep(4)+"/scan",{})).status,403);
 assert.equal((await call("guest","POST",pathStep(4),{auto:true,result:"通过",scanToken:"fake"})).status,403);
});
test("自动扫描读取已有的真实OCR缓存，课件课题与终版议程文本比对一致",async()=>{
 const result=await call("admin","POST",pathStep(4)+"/scan",{});
 assert.equal(result.status,200,JSON.stringify(result.data));
 const r=result.data.report;
 assert.ok(r.scanned>=2,r.scanned);
 assert.ok(r.checks.some(x=>x.name.includes("课件")&&x.status==="一致"),JSON.stringify(r.checks));
 assert.ok(r.files.every(x=>!("text" in x)&&!("fileKey" in x)),"响应不应泄露完整OCR正文");
 assert.ok(r.evidence.sources.some(x=>x.kind==="终版议程"));
 assert.match(r.token,/^[a-f0-9]{64}$/);
});
test("没有三级字段输入：凭OCR比对凭证和人工通过按钮可直接记录结论",async()=>{
 const {data,status}=await call("admin","POST",pathStep(4)+"/scan",{});
 assert.equal(status,200);
 const result=await call("admin","POST",pathStep(4),{
  result:"通过",auto:true,scanToken:data.report.token
 });
 assert.equal(result.status,200,JSON.stringify(result.data));
 const step=result.data.verification.steps.find(x=>x.no===4);
 assert.equal(step.result,"通过");
 assert.equal(step.evidence.origin,"ocr-assisted-human-review");
 assert.equal(step.evidence.scanToken,data.report.token);
 const saved=db.prepare("SELECT evidence_json,checked_by,remark FROM verify_steps WHERE pid=? AND step_no=4").get(pid);
 assert.ok(saved.evidence_json.includes("ocr-assisted-human-review"));
 assert.match(saved.remark,/人工核验通过/);
});
test("替换或更新材料文件使既有OCR凭证失效，必须重新扫描",async()=>{
 const before=await call("admin","POST",pathStep(4)+"/scan",{});
 const token=before.data.report.token;
 const row=db.prepare("SELECT id FROM materials WHERE pid=? AND kind='课件' AND file_key=?").get(pid,"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.pdf");
 assert.ok(row);
 db.prepare("UPDATE materials SET file_key=? WHERE id=?").run("cccccccccccccccccccccccccccccccc.pdf",row.id);
 const response=await call("admin","POST",pathStep(4),{result:"通过",auto:true,scanToken:token});
 assert.equal(response.status,409,JSON.stringify(response.data));
 assert.equal(response.data.error.code,"OCR_REPORT_STALE");
 const verification=await call("admin","GET","/api/projects/"+pid+"/verify");
 assert.equal(verification.status,200);
 assert.equal(verification.data.verification.steps.find(x=>x.no===4).result,"待判定");
});
test("OCR自动失败可以不填理由直接生成人工不通过记录和待审批例外单",async()=>{
 const scan=await call("admin","POST",pathStep(1)+"/scan",{});
 assert.equal(scan.status,200,JSON.stringify(scan.data));
 const result=await call("admin","POST",pathStep(1),{
  result:"不通过",auto:true,scanToken:scan.data.report.token
 });
 assert.equal(result.status,200,JSON.stringify(result.data));
 assert.ok(result.data.message.includes("例外单"));
 const ex=db.prepare("SELECT reason,status FROM exceptions WHERE pid=? AND step_no=1 ORDER BY id DESC LIMIT 1").get(pid);
 assert.match(ex.reason,/OCR比对异常/);
 assert.equal(ex.status,"待审批");
});
test("现代Office可直接提取原生文字，旧式XLS不冒充OCR成功",()=>{
 const zip=(extra)=>{
  const z=new PizZip();
  z.file("[Content_Types].xml","<Types/>");
  z.file("_rels/.rels","<Relationships/>");
  for(const [name,content] of Object.entries(extra))z.file(name,content);
  return z.generate({type:"nodebuffer"});
 };
 const doc=zip({"word/document.xml":"<w:document><w:p><w:t>会议主题</w:t><w:t>精准诊疗</w:t></w:p></w:document>"});
 assert.match(extract(doc,"docx").text,/精准诊疗/);
 const ppt=zip({"ppt/presentation.xml":"<p:presentation/>",
  "ppt/slides/slide1.xml":"<p:sld><a:p><a:t>临床研究</a:t></a:p></p:sld>"});
 assert.match(extract(ppt,"pptx").text,/临床研究/);
 const xlsx=zip({"xl/workbook.xml":"<workbook/>","xl/sharedStrings.xml":"<sst><si><t>会务预算</t></si></sst>",
  "xl/worksheets/sheet1.xml":"<worksheet><row><c t='inlineStr'><is><t>1000</t></is></c></row></worksheet>"});
 assert.match(extract(xlsx,"xlsx").text,/会务预算/);
 assert.equal(extract(Buffer.from("dummy"),"xls"),null);
});
