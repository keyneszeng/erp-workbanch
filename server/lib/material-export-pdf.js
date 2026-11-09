"use strict";
/**
 * 按用户勾选的材料库类目生成 PDF：单页封面仅含活动名称、所属协会；随后为所选原件。
 * - Office OOXML 文件必须先转换为可见 PDF 页面，转换不可用时明确失败；原文件仍作为附件。\n * - 原始 PDF / JPEG / PNG 转成可见页；其他格式原文件作为 PDF 附件，并生成说明页。
 * - 所有页面包括封面、PDF 原件、图片/说明页均添加同一份可选文字水印。
 * - 所有原件来源由服务端按项目/类目查询，不接受请求体指定文件key。
 */
const {PDFDocument,degrees}=require("pdf-lib");
const {HttpError}=require("./util");
const {compressOriginal}=require("./file-compress");
const VISIBLE_OFFICE_EXT=new Set(["pptx","xlsx","docx"]);
const extOfFile=name=>String(name||"").split(".").pop().toLowerCase();
const PAGE_W=595.28,PAGE_H=841.89;
const MAX_FILES=120,MAX_FILE_BYTES=20*1024*1024,MAX_TOTAL_BYTES=120*1024*1024,MAX_PAGES=300;
function sanitize(s){return String(s??"").replace(/[\u0000-\u001f\u007f]/g," ").trim();}
function hexCjk(s){
 const le=Buffer.from(sanitize(s),"utf16le"),be=Buffer.alloc(le.length);
 for(let i=0;i<le.length;i+=2){be[i]=le[i+1];be[i+1]=le[i];}
 return be.toString("hex").toUpperCase();
}
function textOp(str,x,y,size=15,rgb="0.16 0.25 0.36"){
 return rgb+" rg BT /F1 "+size+" Tf 1 0 0 1 "+x.toFixed(2)+" "+y.toFixed(2)+" Tm <"+hexCjk(str)+"> Tj ET\n";
}
/**
 * 单页透明中文 Type0 PDF,不依赖系统中文字库，可用于封面和透明水印 XObject。
 * 采用和已有 archive-pdf.js 相同的 STSong-Light / UniGB-UCS2-H 字形编码。
 */
function createCjkPage(ops,{width=PAGE_W,height=PAGE_H}={}){
 const content=ops.join("");
 const objects=[
  "<< /Type /Catalog /Pages 2 0 R >>",
  "<< /Type /Pages /Count 1 /Kids [6 0 R] >>",
  "<< /Type /Font /Subtype /Type0 /BaseFont /STSong-Light /Encoding /UniGB-UCS2-H /DescendantFonts [4 0 R] >>",
  "<< /Type /Font /Subtype /CIDFontType0 /BaseFont /STSong-Light /CIDSystemInfo << /Registry (Adobe) /Ordering (GB1) /Supplement 4 >> /DW 1000 >>",
  "<< /Length "+Buffer.byteLength(content,"ascii")+" >>\nstream\n"+content+"endstream",
  "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 "+width+" "+height+"] /Contents 5 0 R /Resources << /Font << /F1 3 0 R >> >> >>"
 ];
 const chunks=[Buffer.from("%PDF-1.4\n%\xE2\xE3\xCF\xD3\n","latin1")],offsets=[0];
 let bytePos=chunks[0].length;
 for(let i=0;i<objects.length;i++){
  offsets.push(bytePos);
  const b=Buffer.from((i+1)+" 0 obj\n"+objects[i]+"\nendobj\n","ascii");
  chunks.push(b);bytePos+=b.length;
 }
 const start=bytePos;
 let xref="xref\n0 "+(objects.length+1)+"\n0000000000 65535 f \n";
 for(let i=1;i<offsets.length;i++)xref+=String(offsets[i]).padStart(10,"0")+" 00000 n \n";
 chunks.push(Buffer.from(xref+"trailer\n<< /Size "+(objects.length+1)+
    " /Root 1 0 R >>\nstartxref\n"+start+"\n%%EOF\n","ascii"));
 return Buffer.concat(chunks);
}
function wrapChinese(value,max=19){
 const s=sanitize(value),lines=[];
 for(let i=0;i<s.length;i+=max)lines.push(s.slice(i,i+max));
 return lines.length?lines:["未命名活动"];
}
function cover(project){
 const ops=[],name=wrapChinese(project.name,18),assoc=wrapChinese(project.assoc,25);
 name.slice(0,5).forEach((line,i)=>ops.push(textOp(line,70,540-i*40,23,"0.10 0.23 0.38")));
 assoc.slice(0,3).forEach((line,i)=>ops.push(textOp(line,70,390-i*29,16,"0.28 0.32 0.39")));
 return createCjkPage(ops);
}
function notePage(material,reason){
 const ops=[textOp("材料类别："+sanitize(material.kind),48,740,15),
 textOp("材料名称："+sanitize(material.name),48,699,13),
 textOp("原件文件："+sanitize(material.file_name||material.file_key),48,660,11),
 textOp(reason,48,600,11)];
 return createCjkPage(ops);
}
function watermarkOverlay(text){
 const chunks=wrapChinese(text,28).slice(0,3);
 const ops=chunks.map((line,i)=>textOp(line,8,75-i*30,18,"0.28 0.31 0.38"));
 return createCjkPage(ops,{width:550,height:112});
}
function mime(bytes,fallback){
 if(bytes.toString("ascii",0,4)==="%PDF")return "application/pdf";
 if(bytes.subarray(0,8).equals(Buffer.from("89504e470d0a1a0a","hex")))return "image/png";
 if(bytes.subarray(0,3).equals(Buffer.from("ffd8ff","hex")))return "image/jpeg";
 return fallback||"application/octet-stream";
}
function safeAttachmentName(name,index){
 return String(index+1).padStart(3,"0")+"_"+sanitize(name||"原件").replace(/[\\/:*?"<>|]/g,"_").slice(0,90);
}
const mb=n=>(n/1048576).toFixed(1)+"MB";
/**
 * @param {object} opts
 * @param {Function} [opts.compressor] 测试可注入；默认按格式调用外部工具压缩。
 */
async function buildSelectedMaterialsPdf({project,materials,watermark,compressor=compressOriginal},store){
 if(!project||!Array.isArray(materials)||!materials.length)
  throw new HttpError(400,"MATERIALS_EMPTY","至少选择一个已上传的材料类别");
 if(materials.length>MAX_FILES)
  throw new HttpError(413,"MATERIAL_EXPORT_COUNT","文件超过120份，请减少勾选类别分批生成");
 const dest=await PDFDocument.load(cover(project),{updateMetadata:false});
 let byteTotal=0,pageCount=dest.getPageCount(),originalCount=0;
 const seenKeys=new Set();
 for(const [index,m] of materials.entries()){
  if(!m.file_key||seenKeys.has(m.file_key))continue;
  seenKeys.add(m.file_key);
  let object;
  try{object=await store.get(m.file_key);}
  catch(err){
   throw new HttpError(503,"MATERIAL_STORAGE_UNAVAILABLE","读取原始材料失败："+sanitize(m.file_name||m.name));
  }
  if(!object?.buffer)
   throw new HttpError(409,"MATERIAL_FILE_MISSING","材料库原件不存在："+sanitize(m.file_name||m.name));
  const original=Buffer.from(object.buffer);
  const originalFileName=m.file_name||m.name||m.file_key;
  const needsOfficePages=VISIBLE_OFFICE_EXT.has(extOfFile(originalFileName));
  let bytes=original,type=mime(original,m.file_mime),compressNote="";
  /**
   * 超过单份上限时先尝试自动压缩，而不是直接让整份导出失败。
   * 压缩策略见 file-compress.js：图片缩放、PDF 用 gs 重采样、Office 转 PDF。
   */
  if(needsOfficePages){
   // Office must render regardless of size. A compressed PDF can be larger than the
   // source XLSX/PPTX; comparing byte lengths would incorrectly discard the PDF.
   try{
    const converted=await compressor(original,{type,fileName:originalFileName});
    if(!converted?.bytes || converted.type!=="application/pdf" ||
       !Buffer.from(converted.bytes).subarray(0,4).equals(Buffer.from("%PDF")))
      throw new Error("Office 转换未返回有效 PDF");
    bytes=Buffer.from(converted.bytes);
    type="application/pdf";
   }catch(err){
    throw new HttpError(503,"MATERIAL_OFFICE_CONVERSION_FAILED",
      "无法将 Office 原件转换为可见 PDF 页面："+sanitize(originalFileName)+
      "。请检查服务器 LibreOffice 组件，转换失败不会生成只有提示页的归档文件。");
   }
  }else if(original.length>MAX_FILE_BYTES){
   try{
    const squeezed=await compressor(original,{type,fileName:originalFileName});
    if(squeezed?.bytes&&squeezed.bytes.length<original.length){
     bytes=squeezed.bytes;type=squeezed.type||type;
     compressNote=(squeezed.note||"原件已自动压缩")+"（"+mb(original.length)+" → "+mb(bytes.length)+"）";
    }
   }catch(err){
    compressNote="自动压缩失败："+sanitize(err.message||"未知错误")+"（原件 "+mb(original.length)+"）";
   }
  }
  const addNote=async reason=>{
   if(pageCount+1>MAX_PAGES)throw new HttpError(413,"MATERIAL_EXPORT_PAGES","生成PDF超过300页，请减少勾选类别");
   const explanation=await PDFDocument.load(notePage(m,reason));
   const [p]=await dest.copyPages(explanation,[0]);
   dest.addPage(p);pageCount++;
  };
  // 压缩后仍然超限：只留说明页，跳过附件，保证其余材料照常导出。
  if(needsOfficePages&&bytes.length>MAX_FILE_BYTES)
   throw new HttpError(413,"MATERIAL_OFFICE_PDF_TOO_LARGE","Office 转换后 PDF 超过20MB，请拆分材料导出："+sanitize(originalFileName));
  if(bytes.length>MAX_FILE_BYTES){
   await addNote((compressNote||"原件超过20MB")+"；压缩后仍超过单份限制，未随 PDF 附带，请在材料库单独下载。");
   originalCount++;
   continue;
  }
  byteTotal+=bytes.length;
  if(byteTotal>MAX_TOTAL_BYTES)
   throw new HttpError(413,"MATERIAL_EXPORT_TOTAL_LARGE","所选原件超过120MB，请分批处理");
  if(compressNote)await addNote(compressNote+"；原文件可在材料库单独下载。");
  const fileName=(()=>{
   const base=safeAttachmentName(m.file_name||m.name||m.file_key,index);
   return type==="application/pdf"&&!/\.pdf$/i.test(base)?base.replace(/\.[^.]+$/,"")+".pdf":base;
  })();
  let pagesAdded=0;
  try{
   if(type==="application/pdf"){
    const originalPdf=await PDFDocument.load(bytes,{updateMetadata:false});
    if(pageCount+originalPdf.getPageCount()>MAX_PAGES)
      throw new HttpError(413,"MATERIAL_EXPORT_PAGES","生成PDF超过300页，请减少勾选类别");
    const pages=await dest.copyPages(originalPdf,originalPdf.getPageIndices());
    pages.forEach(page=>dest.addPage(page));
    pagesAdded=pages.length;
   }else if(type==="image/png"||type==="image/jpeg"){
    const img=type==="image/png"?await dest.embedPng(bytes):await dest.embedJpg(bytes);
    const page=dest.addPage([PAGE_W,PAGE_H]);
    const scale=Math.min((PAGE_W-70)/img.width,(PAGE_H-100)/img.height);
    const w=img.width*scale,h=img.height*scale;
    page.drawImage(img,{x:(PAGE_W-w)/2,y:(PAGE_H-h)/2,width:w,height:h});
    pagesAdded=1;
   }
  }catch(err){
   if(err instanceof HttpError)throw err;
   if(needsOfficePages)throw new HttpError(503,"MATERIAL_OFFICE_PDF_INVALID","Office 文件已转换，但生成的 PDF 无法读取："+sanitize(originalFileName));
   // 破损/受保护的PDF不能作为可见页；依然嵌入原件并明确标明。
   pagesAdded=0;
  }
  if(!pagesAdded){
   if(needsOfficePages)throw new HttpError(503,"MATERIAL_OFFICE_PDF_EMPTY","Office 转换结果没有可显示页面："+sanitize(originalFileName));
   if(pageCount+1>MAX_PAGES)throw new HttpError(413,"MATERIAL_EXPORT_PAGES","生成PDF超过300页，请减少勾选类别");
   const explanation=await PDFDocument.load(notePage(m,"原件已随PDF附件保存；此文件格式暂不能转换为可见页面。"));
   const [p]=await dest.copyPages(explanation,[0]);
   dest.addPage(p);
   pagesAdded=1;
  }
  pageCount+=pagesAdded;
  originalCount++;
  // Always attach the original editable Office document, never the converted PDF instead.
  const attachmentBytes=needsOfficePages?original:bytes;
  const attachmentName=needsOfficePages?safeAttachmentName(originalFileName,index):fileName;
  await dest.attach(attachmentBytes,attachmentName,{
   mimeType:needsOfficePages?m.file_mime||"application/octet-stream":type,
   description:sanitize(m.kind)+" · "+sanitize(m.name)+(compressNote?"（"+compressNote+"）":""),
   creationDate:new Date()
  });
 }
 if(!originalCount)throw new HttpError(400,"MATERIALS_EMPTY","没有可生成PDF的有效原件");
 if(watermark?.mode!=="none"){
  const overlay=await dest.embedPdf(watermarkOverlay(watermark?.text||""),[0]);
  const pageStamp=overlay[0];
  for(const page of dest.getPages()){
   const {width,height}=page.getSize(),w=Math.min(width*0.73,530);
   page.drawPage(pageStamp,{
     x:width*0.1,y:height*0.58,
     width:w,height:w*112/550,opacity:0.25,rotate:degrees(-22)
   });
  }
 }
 dest.setTitle(sanitize(project.name)+" - 会议材料");
 dest.setSubject("自选材料库类别 PDF 合集");
 dest.setCreator("Association ERP");
 dest.setKeywords(["materials-export","watermark:"+(watermark?.mode||"default"),"source-count:"+originalCount]);
 return Buffer.from(await dest.save({useObjectStreams:false}));
}
module.exports={buildSelectedMaterialsPdf,createCjkPage,watermarkOverlay};
