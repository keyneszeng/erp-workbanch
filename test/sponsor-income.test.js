"use strict";
const {test,before,after}=require("node:test"),assert=require("node:assert/strict");
const {spawn}=require("node:child_process"),fs=require("node:fs"),os=require("node:os"),path=require("node:path");
const dir=fs.mkdtempSync(path.join(os.tmpdir(),"erp-income-test-")),port=14900+(process.pid%700),base="http://127.0.0.1:"+port;
let child,admin,exec;
async function request(method,url,body,cookie){
 const r=await fetch(base+url,{method,headers:{"Content-Type":"application/json",...(cookie?{Cookie:cookie}:{})},body:body===undefined?undefined:JSON.stringify(body)});
 return {status:r.status,data:await r.json(),cookie:(r.headers.get("set-cookie")||"").split(";")[0]};
}
async function login(name){const x=await request("POST","/api/auth/login",{username:name,password:"123456"});assert.equal(x.status,200,JSON.stringify(x.data));return x.cookie;}
const pdf=Buffer.from("%PDF-1.4\n1 0 obj\n<<>>\nendobj\n%%EOF");
function docxBytes(){
 const PizZip=require("pizzip");
 const zip=new PizZip();
 zip.file("[Content_Types].xml",'<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>');
 zip.file("_rels/.rels",'<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>');
 const lines=["赞助企业名称：广州睿康医疗科技有限公司","合同总金额：人民币12000元","权益内容：",
   "1. 主会场背景板LOGO露出","2. 企业展位展示","付款约定：合同签署后支付"];
 zip.file("word/document.xml",
   '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>'+
   lines.map(x=>'<w:p><w:r><w:t>'+x+'</w:t></w:r></w:p>').join("")+'</w:body></w:document>');
 return zip.generate({type:"nodebuffer",compression:"DEFLATE"});
}
async function uploadDocx(cookie,pid){
 const r=await fetch(base+"/api/uploads?pid="+encodeURIComponent(pid),{
   method:"POST",headers:{Cookie:cookie,"Content-Type":"application/octet-stream","X-File-Name":"sponsor.docx"},
   body:docxBytes()
 });
 const data=await r.json();assert.equal(r.status,200,JSON.stringify(data));return data.key;
}
async function upload(cookie,pid){
 const r=await fetch(base+"/api/uploads?pid="+encodeURIComponent(pid),{method:"POST",headers:{Cookie:cookie,"Content-Type":"application/octet-stream","X-File-Name":"sponsor.pdf"},body:pdf});
 const v=await r.json();assert.equal(r.status,200,JSON.stringify(v));return v.key;
}
before(async()=>{
 child=spawn(process.execPath,["--experimental-sqlite","server/index.js"],{cwd:path.resolve(__dirname,".."),stdio:["ignore","pipe","pipe"],env:{...process.env,ERP_DEMO_MODE:"1",ERP_PORT:String(port),ERP_HOST:"127.0.0.1",ERP_DB:path.join(dir,"data.db"),ERP_UPLOAD_DIR:path.join(dir,"uploads")}});
 let err="";child.stderr.on("data",s=>err+=s);
 // 慢盘上 Node 冷启动（含 pdf-lib 加载）可能超过 15 秒，窗口放到 40 秒；
 // 循环耗尽必须显式报错，否则会退化成一句无信息的 "fetch failed"。
 let ready=false;
 for(let i=0;i<600;i++){if(child.exitCode!==null)throw Error("Server failed: "+err);try{if((await request("GET","/api/health")).status===200){ready=true;break;}}catch{}await new Promise(r=>setTimeout(r,100));}
 if(!ready)throw Error("Server did not start in 40s: "+err);
 admin=await login("admin");exec=await login("exec");
});
after(()=>{child?.kill("SIGTERM");fs.rmSync(dir,{recursive:true,force:true});});
test("赞助合同/到账凭证/开票逐笔登记、授权与预算差额",async()=>{
 const p=await request("POST","/api/projects",{name:"赞助收入测试项目",assoc:"华东医学会",form:"线下",date:"2027-10-20",budget:10000,people:60,owner:"陈静",agenda:"学术会议"},exec);
 assert.equal(p.status,200,JSON.stringify(p.data));const pid=p.data.project.id;
 const initial=await request("GET","/api/projects/"+pid+"/income",undefined,admin);assert.equal(initial.status,200);assert.equal(initial.data.summary.budget,10000);
 const forbidden=await request("GET","/api/projects/"+pid+"/income");assert.equal(forbidden.status,401);
 const docxKey=await uploadDocx(exec,pid);
 const preview=await request("POST","/api/projects/"+pid+"/income/contracts/scan",{file_key:docxKey},exec);
 assert.equal(preview.status,200,JSON.stringify(preview.data));
 assert.equal(preview.data.fields.enterprise,"广州睿康医疗科技有限公司");
 assert.equal(preview.data.fields.amount,12000);
 assert.deepEqual(preview.data.fields.rightsContent,["主会场背景板LOGO露出","企业展位展示"]);
 assert.equal((await request("GET","/api/projects/"+pid+"/income",undefined,admin)).data.contracts.length,0,
   "扫描只能预填，不得提前创建赞助合同");
 const badPreview=await request("POST","/api/projects/"+pid+"/income/contracts/scan",{file_key:"invalid.pdf"},exec);
 assert.equal(badPreview.status,400,"扫描接口必须验证已上传文件归属");
 const contractKey=await upload(exec,pid);
 const c=await request("POST","/api/projects/"+pid+"/income/contracts",{enterprise:"测试赞助企业",contractNo:"FORGED-NO",amount:10000,file_key:contractKey,file_name:"sponsor.pdf"},exec);
 assert.equal(c.status,200,JSON.stringify(c.data));
 assert.match(c.data.contractNo,/^SC-\d{4}-\d{3,}$/);
 assert.equal(c.data.contractNo,c.data.id,"合同编号由后端创建，并忽略客户端自行填写的编号");
 const contractDetails=await request("GET","/api/projects/"+pid+"/income",undefined,admin);
 assert.equal(contractDetails.data.contracts[0].contract_no,c.data.contractNo);
 assert.equal(c.data.summary.contracted,0);
 const over=await request("POST","/api/projects/"+pid+"/income/contracts/"+c.data.id+"/decide",{approve:true},exec);
 assert.equal(over.status,403,"execution role cannot approve sponsor contract");
 const approved=await request("POST","/api/projects/"+pid+"/income/contracts/"+c.data.id+"/decide",{approve:true},admin);
 assert.equal(approved.status,200,JSON.stringify(approved.data));
 assert.equal(approved.data.summary.contracted,10000);
 const rightsReview=await request("PATCH","/api/projects/"+pid+"/income/contracts/"+c.data.id+"/rights",
   {categories:["主会场背景板LOGO露出","会议手册企业鸣谢"]},exec);
 assert.equal(rightsReview.status,200,JSON.stringify(rightsReview.data));
 const rights=await request("GET","/api/projects/"+pid+"/sponsor-rights",undefined,exec);
 assert.equal(rights.status,200,JSON.stringify(rights.data));
 const matchedRights=rights.data.rights.filter(x=>x.sponsor_id===c.data.id);
 assert.equal(matchedRights.length,2);
 assert.ok(matchedRights.every(x=>x.confirmed===1));
 const rid=matchedRights[0].id;
 const photoBytes=Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLytAAAAABJRU5ErkJggg==","base64");
 const uploadPhoto=async targetPid=>{
   const raw=await fetch(base+"/api/uploads?pid="+encodeURIComponent(targetPid),{
     method:"POST",headers:{Cookie:exec,"Content-Type":"application/octet-stream","X-File-Name":"rights.png"},body:photoBytes
   });
   const d=await raw.json();assert.equal(raw.status,200,JSON.stringify(d));return d.key;
 };
 const photoKey=await uploadPhoto(pid);
 const withoutCategory=await request("POST","/api/projects/"+pid+"/materials",
   {kind:"权益照片",name:"背景板",file_key:photoKey,file_name:"rights.png"},exec);
 assert.equal(withoutCategory.status,400,"权益照片不允许无二级权益类目");
 const linkedPhoto=await request("POST","/api/projects/"+pid+"/materials",
   {kind:"权益照片",name:"背景板Logo交付照片",file_key:photoKey,file_name:"rights.png",sponsor_right_id:rid},exec);
 assert.equal(linkedPhoto.status,200,JSON.stringify(linkedPhoto.data));
 const overview=await request("GET","/api/projects/"+pid+"/sponsor-rights",undefined,exec);
 assert.ok(overview.data.photos.some(x=>x.sponsor_right_id===rid&&x.file_key===photoKey));
 const otherProject=await request("POST","/api/projects",
   {name:"跨项目权益附件检验",assoc:"华东医学会",form:"线上",date:"2027-11-11",
     budget:10000,owner:"陈静",agenda:"会议议程"},exec);
 assert.equal(otherProject.status,200,JSON.stringify(otherProject.data));
 const otherPid=otherProject.data.project.id,otherKey=await uploadPhoto(otherPid);
 const foreignLink=await request("POST","/api/projects/"+otherPid+"/materials",
   {kind:"权益照片",name:"跨项目冒用",file_key:otherKey,file_name:"rights.png",sponsor_right_id:rid},exec);
 assert.equal(foreignLink.status,409,"跨项目权益ID不可直接用于别的项目");
 const blockedDelete=await request("PATCH","/api/projects/"+pid+"/income/contracts/"+c.data.id+"/rights",
   {categories:["会议手册企业鸣谢"]},exec);
 assert.equal(blockedDelete.status,409,"有权益照片的二级类目不能被静默删除");
 const another=await request("POST","/api/projects/"+pid+"/income/contracts",{enterprise:"另一赞助企业",contractNo:"SP-2027-002",amount:500,file_key:await upload(exec,pid)},exec);
 assert.equal(another.status,200);
 const excess=await request("POST","/api/projects/"+pid+"/income/contracts/"+another.data.id+"/decide",{approve:true},admin);
 assert.equal(excess.status,409,"赞助累计已超过预算应拒绝");
 const receiptKey=await upload(admin,pid);
 for(const invalidDate of ["2027-13-01", "2027-02-30", "not-a-date"]) {
   const rejected=await request("POST","/api/projects/"+pid+"/income/receipts",
     {sponsorId:c.data.id,amount:10000,paymentRef:"BANK20270001",receivedDate:invalidDate,file_key:receiptKey},admin);
   assert.equal(rejected.status,400,"无效到账日期须返回 400（而非 RangeError 500）: "+invalidDate+" "+JSON.stringify(rejected.data));
 }
 const rec=await request("POST","/api/projects/"+pid+"/income/receipts",
   {sponsorId:c.data.id,amount:10000,paymentRef:"BANK20270001",receivedDate:"2027-10-21",file_key:receiptKey},admin);
 assert.equal(rec.status,200,JSON.stringify(rec.data));
 assert.equal(rec.data.summary.received,10000);
 const invoiceKey=await upload(admin,pid);
 for(const invalidDate of ["2027-00-12", "2027-02-30", "2027-13-01"]) {
   const rejected=await request("POST","/api/projects/"+pid+"/income/invoices",
     {sponsorId:c.data.id,amount:10000,invoiceNo:"INV20270001",issuedDate:invalidDate,file_key:invoiceKey},admin);
   assert.equal(rejected.status,400,"无效开票日期须返回 400（而非 RangeError 500）: "+invalidDate+" "+JSON.stringify(rejected.data));
 }
 const inv=await request("POST","/api/projects/"+pid+"/income/invoices",
   {sponsorId:c.data.id,amount:10000,invoiceNo:"INV20270001",issuedDate:"2027-10-21",file_key:invoiceKey},admin);
 assert.equal(inv.status,200,JSON.stringify(inv.data));assert.equal(inv.data.summary.invoiced,10000);
 const state=await request("GET","/api/projects/"+pid+"/income",undefined,admin);
 assert.equal(state.data.summary.contractGap,0);assert.equal(state.data.summary.receiptGap,0);
 assert.equal(state.data.contracts.length,2);assert.equal(state.data.receipts.length,1);assert.equal(state.data.invoices.length,1);
 const dup=await request("POST","/api/projects/"+pid+"/income/invoices",{sponsorId:c.data.id,amount:1,invoiceNo:"INV20270001",issuedDate:"2027-10-21",file_key:await upload(admin,pid)},admin);
 assert.equal(dup.status,409);
});
