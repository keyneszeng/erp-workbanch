"use strict";
/** Archive auto-index + PPTX verification against a real demo DB and HTTP API. */
const {test,before,after}=require("node:test"),assert=require("node:assert/strict");
const {spawn}=require("node:child_process"),{DatabaseSync}=require("node:sqlite");
const fs=require("node:fs"),os=require("node:os"),path=require("node:path");
const PizZip=require("pizzip"),{PDFDocument}=require("pdf-lib");
const root=path.resolve(__dirname,".."),dir=fs.mkdtempSync(path.join(os.tmpdir(),"erp-archive-auto-"));
const dbFile=path.join(dir,"db.sqlite"),uploadDir=path.join(dir,"uploads");
const port=16813,origin="http://127.0.0.1:"+port,pid="MP-2026-015",other="MP-2026-007";
let server,db,admin,assoc,execUser;
const projectUrl="/api/projects/"+pid;
async function auth(user){
 const res=await fetch(origin+"/api/auth/login",{method:"POST",headers:{"content-type":"application/json"},
  body:JSON.stringify({username:user,password:"123456"})});
 assert.equal(res.status,200,user+" login");
 return res.headers.get("set-cookie").split(";")[0];
}
async function req(cookie,method,url,body){
 const res=await fetch(origin+url,{method,headers:{cookie,...(body===undefined?{}:{"content-type":"application/json"})},
  body:body===undefined?undefined:JSON.stringify(body)});
 const ct=res.headers.get("content-type")||"";
 return {status:res.status,res,data:ct.includes("json")?await res.json():null};
}
async function pdf(i=0){
 const pdf=await PDFDocument.create();pdf.addPage([240+i*11,300+i*13]);
 pdf.setTitle("测试业务原件 "+i);return Buffer.from(await pdf.save());
}
function put(key,bytes){
 const folder=path.join(uploadDir,key.slice(0,2));
 fs.mkdirSync(folder,{recursive:true});fs.writeFileSync(path.join(folder,key),bytes);
}
before(async()=>{
 server=spawn(process.execPath,["--experimental-sqlite","server/index.js"],{
  cwd:root,env:{...process.env,ERP_DEMO_MODE:"1",ERP_PORT:String(port),
   ERP_DB:dbFile,ERP_UPLOAD_DIR:uploadDir},stdio:["ignore","pipe","pipe"]});
 let stderr="";server.stderr.on("data",b=>stderr+=String(b));
 let ready=false;
 for(let i=0;i<300;i++){
  try{if((await fetch(origin+"/api/health")).ok){ready=true;break;}}catch{}
  if(server.exitCode!==null)throw Error("server exited: "+stderr);
  await new Promise(r=>setTimeout(r,110));
 }
 assert.ok(ready,"server started");
 [admin,assoc,execUser]=await Promise.all(["admin","assoc","exec"].map(auth));
 db=new DatabaseSync(dbFile);db.exec("PRAGMA busy_timeout=5000");
 const keys=[
  "11111111111111111111111111111111.pdf",
  "22222222222222222222222222222222.pdf",
  "33333333333333333333333333333333.pdf",
  "44444444444444444444444444444444.pdf",
  "55555555555555555555555555555555.pdf"
 ];
 const contents=await Promise.all(keys.map((_,i)=>pdf(i)));
 keys.forEach((key,i)=>put(key,contents[i]));
 const content=contents[0];
 db.prepare("INSERT INTO meeting_sponsor_contracts (id,pid,enterprise,contract_no,amount,status,file_key,file_name,created_at) VALUES (?,?,?,?,?,?,?,?,?)")
   .run("SC-AUTO-001",pid,"甲赞助企业","ZZ-1001",20000,"已签署",keys[0],"赞助合同.pdf","2026-10-01");
 db.prepare("INSERT INTO meeting_sponsor_receipts (id,pid,sponsor_id,amount,payment_ref,received_date,file_key,file_name,created_at) VALUES (?,?,?,?,?,?,?,?,?)")
   .run("SR-AUTO-001",pid,"SC-AUTO-001",20000,"BANK-1001","2026-10-02",keys[1],"进款凭证.pdf","2026-10-02");
 db.prepare("INSERT INTO meeting_sponsor_invoices (id,pid,sponsor_id,amount,invoice_no,issued_date,file_key,file_name,created_at) VALUES (?,?,?,?,?,?,?,?,?)")
   .run("SI-AUTO-001",pid,"SC-AUTO-001",20000,"INV-AUTO-001","2026-10-03",keys[2],"赞助发票.pdf","2026-10-03");
 db.prepare("INSERT INTO materials (pid,kind,name,version,uploader,created_at,file_key,file_name,file_size,file_mime) VALUES (?,?,?,?,?,?,?,?,?,?)")
   .run(pid,"合同","被赞助库镜像的合同","v1","测试","2026-10-04",keys[0],"重复原件.pdf",content.length,"application/pdf");
 db.prepare("INSERT INTO materials (pid,kind,name,version,uploader,created_at,file_key,file_name,file_size,file_mime) VALUES (?,?,?,?,?,?,?,?,?,?)")
   .run(pid,"现场照片","现场照片原件","v1","测试","2026-10-04",keys[3],"现场照片.pdf",contents[3].length,"application/pdf");
 db.prepare("INSERT INTO materials (pid,kind,name,version,uploader,created_at,file_key,file_name,file_size,file_mime,deleted_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
   .run(pid,"课件","废件课件","v1","测试","2026-10-04",keys[4],"已删除.pdf",contents[4].length,"application/pdf","2026-10-05");
 // Real payable records already exist in the seeded meeting. Test the archive
 // never changes any paid amount or status while exporting.
});
after(()=>{db?.close();server?.kill("SIGTERM");fs.rmSync(dir,{recursive:true,force:true});});
test("默认15类目录顺序严格一致；跨业务表自动关联并对同一原件去重",async()=>{
 const {status,data}=await req(admin,"GET",projectUrl+"/archive-pdf/options");
 assert.equal(status,200,JSON.stringify(data));
 const expected=["立项通知","会议说明书","招商函","赞助企业合同","进款凭证",
  "赞助企业合同关联发票","会议照片(现场照片和权益照片)","签到表",
  "劳务收集表","专家劳务协议","串场文件","课件","会务协议","会务需求单","会务合同关联发票"];
 assert.deepEqual(data.groups.slice(0,15).map(x=>x.kind),expected);
 const rows=data.sources;
 const ranks=new Map(data.groups.map((g,i)=>[g.kind,i]));
 assert.deepEqual(rows.map(x=>ranks.get(x.kind)),rows.map(x=>ranks.get(x.kind)).sort((a,b)=>a-b));
 for(const key of ["sponsor-contract:SC-AUTO-001","sponsor-receipt:SR-AUTO-001","sponsor-invoice:SI-AUTO-001"])
  assert.ok(rows.some(s=>s.source_id===key),key);
 assert.ok(rows.some(s=>s.kind==="会议照片(现场照片和权益照片)"&&s.source_type==="材料收集"));
 assert.equal(rows.filter(s=>s.source_id==="sponsor-contract:SC-AUTO-001").length,1);
 assert.ok(!rows.some(s=>s.name.includes("被赞助库镜像")), "duplicate original should be removed");
 assert.ok(!rows.some(s=>s.name.includes("废件课件")), "deleted originals should not be exported");
 assert.ok(rows.some(s=>s.kind==="立项通知"&&s.generated));
 assert.ok(rows.some(s=>s.kind==="会议说明书"&&s.generated));
 assert.ok(rows.every(s=>!("file_key" in s)&&!("token_hash" in s)), "no internal file keys exposed");
 assert.equal(data.project.id,pid);
});
test("自动来源跨库PDF即使前端顺序错误也按固定15类合并，水印与旧接口兼容",async()=>{
 const opts=(await req(admin,"GET",projectUrl+"/archive-pdf/options")).data;
 const ids=["auto:notice","auto:description",
  "sponsor-contract:SC-AUTO-001","sponsor-receipt:SR-AUTO-001","sponsor-invoice:SI-AUTO-001"];
 assert.ok(ids.every(id=>opts.sources.some(s=>s.source_id===id)));
 const result=await req(admin,"POST",projectUrl+"/archive-pdf",{
  source_ids:ids,watermark_mode:"none"
 });
 assert.equal(result.status,200,JSON.stringify(result.data));
 assert.match(result.res.headers.get("content-type"),/application\/pdf/);
 const document=await PDFDocument.load(await result.res.arrayBuffer());
 assert.ok(document.getPageCount()>=6,"cover and five source pages");
 assert.match(document.getKeywords()||"",/source-count:5/);
 const body=await req(assoc,"POST",projectUrl+"/archive-pdf",{
  source_ids:["sponsor-contract:SC-AUTO-001"],watermark_mode:"default"
 });
 assert.equal(body.status,200,"association administrator with archive permission can download own project");
 const old=await req(admin,"POST",projectUrl+"/archive-pdf",{categories:["现场照片"]});
 assert.equal(old.status,200,"legacy category API remains compatible");
});
test("PDF严格执行15类固定优先级：即便source_ids反序，合并后的原件页面仍按赞助合同、进款回单、赞助发票排序",async()=>{
 const reverse=["sponsor-invoice:SI-AUTO-001","sponsor-receipt:SR-AUTO-001","sponsor-contract:SC-AUTO-001"];
 const result=await req(admin,"POST",projectUrl+"/archive-pdf",{source_ids:reverse,watermark_mode:"none"});
 assert.equal(result.status,200,JSON.stringify(result.data));
 const doc=await PDFDocument.load(await result.res.arrayBuffer());
 assert.equal(doc.getPageCount(),4,"封面 + 三份不同原件，各一页");
 assert.deepEqual(doc.getPages().slice(1).map(p=>[p.getWidth(),p.getHeight()]),
  [[240,300],[251,313],[262,326]],"绝不可按用户提交的跨类ID次序输出");
 assert.match(doc.getKeywords()||"",/source-count:3/);
});
test("PDF按真实原件内容SHA256去重，覆盖不同文件键及不同材料登记记录",async()=>{
 const duplicateKey="66666666666666666666666666666666.pdf";
 const original=fs.readFileSync(path.join(uploadDir,"11","11111111111111111111111111111111.pdf"));
 put(duplicateKey,original);
 db.prepare("INSERT INTO materials(pid,kind,name,version,uploader,created_at,file_key,file_name,file_size,file_mime) VALUES(?,?,?,?,?,?,?,?,?,?)")
  .run(pid,"赞助合同","第二次上传的同一赞助合同","v2","测试","2026-10-08",duplicateKey,"第二次上传.pdf",original.length,"application/pdf");
 const extra=db.prepare("SELECT id FROM materials WHERE pid=? AND file_key=?").get(pid,duplicateKey);
 assert.ok(extra?.id);
 const selected=["sponsor-contract:SC-AUTO-001","material:"+extra.id,
  "sponsor-receipt:SR-AUTO-001"];
 const result=await req(admin,"POST",projectUrl+"/archive-pdf",{source_ids:selected,watermark_mode:"none"});
 assert.equal(result.status,200,JSON.stringify(result.data));
 const doc=await PDFDocument.load(await result.res.arrayBuffer());
 assert.equal(doc.getPageCount(),3,"封面 + 合同一次 + 进款凭证一次，合同不重复拼页");
 assert.match(doc.getKeywords()||"",/source-count:2/);
 const embedded=doc.catalog.lookup(require("pdf-lib").PDFName.of("Names"))
  ?.lookup(require("pdf-lib").PDFName.of("EmbeddedFiles"));
 assert.ok(embedded,"合并结果保留原件附件，重复上传不会生成第二套可见页");
});
test("仅能选择本会议来源；重复、伪造源ID和跨会议均拒绝",async()=>{
 for(const badList of [[],["sponsor-contract:SC-AUTO-001","sponsor-contract:SC-AUTO-001"],
  ["material:999999"],["sponsor-contract:OUTSIDE"],["auto:demand","other"]]){
  const r=await req(admin,"POST",projectUrl+"/archive-pdf",{source_ids:badList});
  assert.equal(r.status,400,JSON.stringify({badList,data:r.data}));
 }
 assert.equal((await req(execUser,"GET",projectUrl+"/archive-pdf/options")).status,403);
 assert.equal((await req(execUser,"GET",projectUrl+"/archive-pptx")).status,403);
 assert.equal((await req(admin,"GET","/api/projects/MP-2026-008/archive-pptx")).status,409);
});
test("生成有效 PPTX，首页有会议名称时间协会，第二页为真实付款对照；不泄露完整银行账户",async()=>{
 const p=db.prepare("SELECT * FROM projects WHERE id=?").get(pid);
 const payments=db.prepare("SELECT id,payee,amount FROM payments WHERE pid=?").all(pid);
 const before=JSON.stringify(payments);
 const response=await req(admin,"GET",projectUrl+"/archive-pptx");
 assert.equal(response.status,200,JSON.stringify(response.data));
 assert.match(response.res.headers.get("content-type"),/presentationml\.presentation/);
 assert.match(response.res.headers.get("content-disposition")||"",/\.pptx/i);
 assert.equal(response.res.headers.get("cache-control"),"no-store");
 const bytes=Buffer.from(await response.res.arrayBuffer());
 assert.equal(bytes.toString("ascii",0,2),"PK");
 const zip=new PizZip(bytes);
 for(const name of ["[Content_Types].xml","ppt/presentation.xml","ppt/theme/theme1.xml",
   "ppt/slides/slide1.xml","ppt/slides/slide2.xml",
   "ppt/slideMasters/slideMaster1.xml","ppt/slideLayouts/slideLayout1.xml"])
  assert.ok(zip.file(name),name+" missing");
 const cover=zip.file("ppt/slides/slide1.xml").asText();
 assert.ok(cover.includes(p.name)&&cover.includes(p.date)&&cover.includes(p.assoc),
  "cover contains real project name, date and association");
 const slide2=zip.file("ppt/slides/slide2.xml").asText();
 assert.match(slide2,/付款明细对照表/);
 assert.match(slide2,/关联合同额/);
 assert.match(slide2,/已存档|未附回单/);
 if(payments.length)assert.ok(slide2.includes(payments[0].id),"payment id appears in comparison table");
 assert.ok(!slide2.includes("3210987654321098"),"full bank account must not appear");
 assert.equal(JSON.stringify(db.prepare("SELECT id,payee,amount FROM payments WHERE pid=?").all(pid)),before,
  "downloading PPT must never modify financial records");
});
test("付款明细只占第二页，后续按15类固定目录顺序，不允许跨类重排",async()=>{
 const selected=["sponsor-invoice:SI-AUTO-001","sponsor-contract:SC-AUTO-001",
  "auto:description","auto:notice","sponsor-receipt:SR-AUTO-001"];
 const response=await req(admin,"POST",projectUrl+"/archive-pptx",{source_ids:selected});
 assert.equal(response.status,200,JSON.stringify(response.data));
 const zip=new PizZip(Buffer.from(await response.res.arrayBuffer()));
 assert.match(zip.file("ppt/slides/slide2.xml").asText(),/付款明细对照表/);
 const material=Object.keys(zip.files).filter(k=>/^ppt\/slides\/slide\d+\.xml$/.test(k))
  .sort((a,b)=>Number(a.match(/slide(\d+)\.xml/)[1])-Number(b.match(/slide(\d+)\.xml/)[1]))
  .slice(2).map(n=>zip.file(n).asText());
 assert.equal(material.length,5,"each sample PDF has one page, virtual summaries render as slide text");
 const expected=["立项通知","会议说明书","赞助企业合同","进款凭证","赞助企业合同关联发票"];
 expected.forEach((label,i)=>assert.ok(material[i].includes(label),"material "+(i+3)+": "+label));
 for(const part of material)assert.ok(!part.includes("付款明细对照表"),
  "the payment table must not reappear on material pages");
 const files=Object.keys(zip.files).filter(k=>k.startsWith("ppt/embeddings/original-"));
 assert.equal(files.length,3,"original sponsor PDF, sponsor contract and incoming receipt are bundled");
});
test("大量付款压缩成同一张表；没有任何额外的付款表续页",()=>{
 const build=require("../server/lib/archive-payment-pptx").buildPaymentPptx;
 const p=db.prepare("SELECT * FROM projects WHERE id=?").get(pid);
 const many=Array.from({length:23},(_,i)=>({
  id:"PY-LONG-"+i,type:"学会公付",payee:"外部供应商"+i,amount:200+i,
  status:i%3===0?"已付款":"已审批"
 }));
 const zip=new PizZip(build(p,many,[],{slides:[],attachments:[]}));
 assert.ok(zip.file("ppt/slides/slide1.xml"));
 assert.match(zip.file("ppt/slides/slide2.xml").asText(),/付款明细对照表/);
 assert.match(zip.file("ppt/slides/slide2.xml").asText(),/按类目汇总/);
 assert.ok(!zip.file("ppt/slides/slide3.xml"),"only cover and one financial table");
});
test("图片原件成为可见PPT图像页，材料顺序及源文件一并保留",()=>{
 const build=require("../server/lib/archive-payment-pptx").buildPaymentPptx;
 const p=db.prepare("SELECT * FROM projects WHERE id=?").get(pid);
 const png=Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+i2ioAAAAASUVORK5CYII=","base64");
 const deck={slides:[
  {kind:"image",source_name:"现场照片",source_group:"会议照片(现场照片和权益照片)",image:png,mime:"image/png",page:1,total:1},
  {kind:"text",source_name:"会议说明书",source_group:"会议说明书",text:"真实项目会议时间："+p.date,page:1,total:1}
 ],attachments:[{bytes:png,filename:"现场照片.png",id:"material:900",kind:"现场照片"}]};
 const zip=new PizZip(build(p,[],[],deck));
 assert.ok(zip.file("ppt/slides/slide3.xml").asText().includes("会议照片"));
 assert.match(zip.file("ppt/slides/slide3.xml").asText(),/p:pic/);
 assert.ok(zip.file("ppt/media/material1.png"),"actual image asset included in PPT");
 assert.match(zip.file("ppt/slides/_rels/slide3.xml.rels").asText(),/media\/material1.png/);
 assert.ok(zip.file("ppt/slides/slide4.xml").asText().includes(p.date));
 const originals=Object.keys(zip.files).filter(x=>x.startsWith("ppt/embeddings/original-"));
 assert.equal(originals.length,1);
 assert.deepEqual(Buffer.from(zip.file(originals[0]).asUint8Array()),png);
});
test("PPT资料选择禁止跨会议、重复和伪造来源ID",async()=>{
 for(const invalid of [["sponsor-contract:SC-AUTO-001","sponsor-contract:SC-AUTO-001"],
  ["material:999999"],["sponsor-contract:OUTSIDE"],[100]]){
  const r=await req(admin,"POST",projectUrl+"/archive-pptx",{source_ids:invalid});
  assert.equal(r.status,400,JSON.stringify({invalid,data:r.data}));
 }
 assert.equal((await req(execUser,"POST",projectUrl+"/archive-pptx",
  {source_ids:["auto:notice"]})).status,403);
});
