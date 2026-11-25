"use strict";
/**
 * 材料导出 PDF：单个原件超过 20MB 时必须先尝试自动压缩，而不是整份失败。
 * 这里注入假压缩器，不依赖服务器上的 gs / LibreOffice / ImageMagick。
 */
const {test}=require("node:test");
const assert=require("node:assert/strict");
const {PDFDocument}=require("pdf-lib");
const {buildSelectedMaterialsPdf}=require("../server/lib/material-export-pdf");

const project={id:"MP-TEST-1",name:"压缩测试会议",assoc:"测试协会"};
const LIMIT=20*1024*1024;

async function tinyPdf(pages=1){
 const doc=await PDFDocument.create();
 for(let i=0;i<pages;i++)doc.addPage([200,300]);
 return Buffer.from(await doc.save());
}
const storeFor=buffer=>({get:async()=>({buffer})});
const material=name=>({kind:"课件",name,file_key:"k1.pdf",file_name:name,file_mime:"application/pdf"});

test("超过20MB的原件会自动压缩后合并，不报错",async()=>{
 const big=Buffer.alloc(LIMIT+1024,1);
 const compressed=await tinyPdf(2);
 let called=0;
 const out=await buildSelectedMaterialsPdf({
  project,materials:[material("大课件.pdf")],watermark:{mode:"none"},
  compressor:async()=>{called++;return {bytes:compressed,type:"application/pdf",note:"Office 原件已转换为 PDF 压缩版"};}
 },storeFor(big));
 assert.equal(called,1,"超限时必须调用压缩器");
 assert.ok(Buffer.isBuffer(out)&&out.length>0);
 assert.ok(out.length<LIMIT,"导出结果应远小于原始体积");
 const parsed=await PDFDocument.load(out);
 assert.ok(parsed.getPageCount()>=2,"压缩后的原件应生成可见页");
});

test("压缩后仍超过上限时只留说明页，其余材料照常导出",async()=>{
 const big=Buffer.alloc(LIMIT+1024,1);
 const stillBig=Buffer.alloc(LIMIT+2048,1);
 const out=await buildSelectedMaterialsPdf({
  project,
  materials:[material("超大原件.pdf"),{...material("正常原件.pdf"),file_key:"k2.pdf"}],
  watermark:{mode:"none"},
  compressor:async()=>({bytes:stillBig,type:"application/pdf",note:"压缩效果不足"})
 },{get:async key=>({buffer:key==="k2.pdf"?await tinyPdf(1):big})});
 const parsed=await PDFDocument.load(out);
 // 封面 + 说明页 + 正常原件的 1 页
 assert.ok(parsed.getPageCount()>=3,"应保留封面、说明页和正常原件");
});

test("压缩器报错时不让整份导出失败",async()=>{
 const big=Buffer.alloc(LIMIT+1024,1);
 const out=await buildSelectedMaterialsPdf({
  project,materials:[material("无法压缩.pdf")],watermark:{mode:"none"},
  compressor:async()=>{throw new Error("LibreOffice 未安装");}
 },storeFor(big));
 const parsed=await PDFDocument.load(out);
 assert.ok(parsed.getPageCount()>=2,"应有封面 + 说明页");
});

test("未超限的原件不调用压缩器",async()=>{
 let called=0;
 const small=await tinyPdf(1);
 const out=await buildSelectedMaterialsPdf({
  project,materials:[material("小文件.pdf")],watermark:{mode:"none"},
  compressor:async()=>{called++;return null;}
 },storeFor(small));
 assert.equal(called,0);
 assert.ok((await PDFDocument.load(out)).getPageCount()>=2);
});

test("小于20MB的 PPTX 与 XLSX 也必须转换为可见 PDF 页面，原始文件作为附件保存",async()=>{
 const originals=[Buffer.from("OOXML PPTX source bytes"),Buffer.from("OOXML XLSX source bytes")];
 const converted=await tinyPdf(2);
 const called=[];
 const names=["9.22东江痔道行.pptx","先进慈善26-4：劳务费发放汇总表（模板）.xlsx"];
 const materials=names.map((file_name,i)=>({
  kind:"课件",name:file_name,file_name,file_key:"office"+i+"."+(i?"xlsx":"pptx"),
  file_mime:i?"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet":
    "application/vnd.openxmlformats-officedocument.presentationml.presentation"
 }));
 const out=await buildSelectedMaterialsPdf({
  project,materials,watermark:{mode:"none"},
  compressor:async(bytes,info)=>{
   called.push(info.fileName);
   assert.deepEqual(bytes,originals[called.length-1]);
   return {bytes:converted,type:"application/pdf",note:"Office 已转换"};
  }
 },{get:async key=>({buffer:originals[key.includes("office1")?1:0]})});
 const doc=await PDFDocument.load(out);
 assert.deepEqual(called,names);
 assert.equal(doc.getPageCount(),5,"封面1页，两份Office分别转换成2页");
 assert.match(doc.getKeywords(),/source-count:2/);
 const namesObject=doc.catalog.lookup(require("pdf-lib").PDFName.of("Names"));
 assert.ok(namesObject,"原件必须保留为可下载附件");
});
test("同一PDF以不同文件键重复上传时只拼接一次页面并只附件一份",async()=>{
 const bytes=await tinyPdf(2);
 const materials=[material("同一原件-第一次.pdf"),{...material("同一原件-再次上传.pdf"),file_key:"k2.pdf"}];
 const doc=await PDFDocument.load(await buildSelectedMaterialsPdf({
  project,materials,watermark:{mode:"none"}
 },{get:async()=>({buffer:bytes})}));
 assert.equal(doc.getPageCount(),3,"封面1页+同一原件2页，不能变成5页");
 assert.match(doc.getKeywords()||"",/source-count:1/);
 const embedded=doc.catalog.lookup(require("pdf-lib").PDFName.of("Names"))
  ?.lookup(require("pdf-lib").PDFName.of("EmbeddedFiles"));
 assert.ok(embedded);
});
test("Office 转换工具缺失或转换失败时明确报错，不能产生仅含提示的假归档",async()=>{
 await assert.rejects(
  buildSelectedMaterialsPdf({
   project,materials:[{...material("讲座幻灯.pptx"),file_key:"pptx-file"}],
   watermark:{mode:"none"},
   compressor:async()=>{throw new Error("soffice 未安装");}
  },storeFor(Buffer.from("OOXML"))),
  err=>err.code==="MATERIAL_OFFICE_CONVERSION_FAILED"
 );
 await assert.rejects(
  buildSelectedMaterialsPdf({
   project,materials:[{...material("财务表.xlsx"),file_key:"xlsx-file"}],
   watermark:{mode:"none"},
   compressor:async()=>({bytes:Buffer.from("not-pdf"),type:"application/pdf"})
  },storeFor(Buffer.from("OOXML"))),
  err=>err.code==="MATERIAL_OFFICE_CONVERSION_FAILED"
 );
});
