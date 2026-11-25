"use strict";
/**
 * Read exactly the auto-indexed (and user-sorted) dossier originals and create
 * viewable PowerPoint material pages. On Node+Poppler, each PDF page becomes a
 * real PNG slide; on Node+LibreOffice, Office files are first converted to PDF.
 * No source is silently dropped: unrenderable formats get an explicit source
 * card with the genuine original kept as a PPTX package attachment.
 */
const {HttpError}=require("./util");
const {PDFDocument}=require("pdf-lib");
const {toPdfLines}=require("./archive-material-index");
const MAX_SOURCES=120,MAX_SLIDES=160,MAX_SOURCE_BYTES=25*1024*1024;
const MAX_TOTAL_BYTES=160*1024*1024;
const OFFICE_EXT=new Set(["pptx","ppt","doc","docx","xls","xlsx"]);
const IMAGE_EXT=new Set(["png","jpg","jpeg"]);
const extOf=s=>String(s||"").split(".").pop().toLowerCase();
const safeText=s=>String(s??"").replace(/[\u0000-\u001f\u007f]/g," ").trim();
const cleanName=s=>safeText(s).replace(/[\\/:*?"<>|]/g,"_").slice(0,110)||"附件";
const isPdf=b=>b.subarray(0,4).toString("latin1")==="%PDF";
const isPng=b=>b.subarray(0,8).toString("hex")==="89504e470d0a1a0a";
const isJpg=b=>b.subarray(0,3).toString("hex")==="ffd8ff";
function textSegments(text,lines=12,chars=60){
 const parts=[];
 for(const block of String(text??"").split(/\r?\n/)){
  if(!block){parts.push("");continue;}
  for(let n=0;n<block.length;n+=chars)parts.push(block.slice(n,n+chars));
 }
 const out=[];
 for(let n=0;n<parts.length;n+=lines)out.push(parts.slice(n,n+lines).join("\n"));
 return out.length?out:[""];
}
function asTextPages(project,source){
 const rows=toPdfLines(project,source).map(x=>x.text);
 return textSegments(rows.join("\n"),12,48).map((text,i)=>({
  kind:"text",text,source_name:source.name,source_group:source.kind,
  source_id:source.source_id,page:i+1,total:0,generated:true
 }));
}
function environmentSupportsConversion(store){
 return store?.name!=="r2"&&typeof process!=="undefined"&&!!process?.versions?.node;
}
async function inTemp(fn){
 const fs=require("node:fs/promises"),path=require("node:path"),os=require("node:os");
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),"erp-ppt-material-"));
 try{return await fn(dir,fs,path);}
 finally{await fs.rm(dir,{recursive:true,force:true}).catch(()=>{});}
}
async function runCommand(name,args,opts={}){
 const {promisify}=require("node:util");
 const {execFile}=require("node:child_process");
 return promisify(execFile)(name,args,{timeout:120000,maxBuffer:8*1024*1024,...opts});
}
/** 1200px width is legible in a 16:9 slide without creating huge ZIP images. */
async function renderPdfPages(bytes){
 const doc=await PDFDocument.load(bytes,{ignoreEncryption:false});
 const pages=doc.getPageCount();
 if(pages<1)throw new Error("PDF 无有效页面");
 if(pages>MAX_SLIDES)throw new HttpError(413,"ARCHIVE_PPT_SLIDE_LIMIT","单份PDF页数超过PPT允许范围，请拆分材料");
 return inTemp(async(dir,fs,path)=>{
  const input=path.join(dir,"source.pdf"),prefix=path.join(dir,"page");
  await fs.writeFile(input,bytes);
  await runCommand("pdftoppm",["-f","1","-l",String(pages),"-png","-scale-to","1400","-r","110",input,prefix],{cwd:dir});
  const names=(await fs.readdir(dir)).filter(x=>/^page-\d+\.png$/.test(x))
   .sort((a,b)=>Number(a.match(/\d+/)[0])-Number(b.match(/\d+/)[0]));
  if(names.length!==pages)throw new Error("PDF 转换页数不完整");
  const images=await Promise.all(names.map(name=>fs.readFile(path.join(dir,name))));
  return images;
 });
}
async function convertOfficeToPdf(bytes,fileName){
 return inTemp(async(dir,fs,path)=>{
  const ext=extOf(fileName);
  const input=path.join(dir,"source."+ext),profile=path.join(dir,"lo-profile");
  await fs.writeFile(input,bytes);
  await runCommand("soffice",["--headless","--norestore",
   "-env:UserInstallation=file://"+profile,
   "--convert-to","pdf","--outdir",dir,input],{cwd:dir});
  return fs.readFile(path.join(dir,"source.pdf"));
 });
}
async function materialSlides(project,sources,store,{strict=false}={}){
 if(!Array.isArray(sources)||sources.length>MAX_SOURCES)
  throw new HttpError(413,"ARCHIVE_PPT_TOO_MANY","一次最多生成120项资料，请按类别选择并分批下载");
 const slides=[],attachments=[];
 let totalBytes=0;
 const append=slide=>{
  if(slides.length>=MAX_SLIDES)
   throw new HttpError(413,"ARCHIVE_PPT_SLIDE_LIMIT","会议资料转换后超过160页，请分批选择材料");
  slides.push(slide);
 };
 const sourceIds=new Set();
 for(const source of sources){
  if(!source?.source_id||sourceIds.has(source.source_id))
   throw new HttpError(400,"ARCHIVE_PPT_SOURCE_DUPLICATE","资料来源ID重复或不合法");
  sourceIds.add(source.source_id);
  if(source.generated&&source.virtual&&source.virtual.type!=="invitation"){
   const cards=asTextPages(project,source);
   for(const slide of cards)append(slide);
   continue;
  }
  if(!source.file_key){
   append({kind:"text",text:"该资料仅有业务登记，无实际原件。\n请到材料收集模块补充上传。",
    source_name:source.name,source_group:source.kind,source_id:source.source_id,page:1,total:1});
   continue;
  }
  let object;
  try{object=await store.get(source.file_key);}
  catch{throw new HttpError(503,"ARCHIVE_STORAGE_UNAVAILABLE","读取会议资料失败："+safeText(source.name));}
  if(!object?.buffer)throw new HttpError(409,"ARCHIVE_MATERIAL_MISSING","会议资料原件已丢失："+safeText(source.name));
  const original=Buffer.from(object.buffer);
  if(!original.length||original.length>MAX_SOURCE_BYTES)
   throw new HttpError(413,"ARCHIVE_PPT_SOURCE_SIZE","原件为空或超过25MB："+safeText(source.name));
  totalBytes+=original.length;
  if(totalBytes>MAX_TOTAL_BYTES)
   throw new HttpError(413,"ARCHIVE_PPT_TOTAL_SIZE","选中原件总大小超过160MB，请按目录分批下载");
  const base={source_name:source.name,source_group:source.kind,
   source_id:source.source_id,generated:!!source.generated};
  attachments.push({
   bytes:original,filename:cleanName(source.file_name||source.name),
   id:source.source_id,kind:source.kind
  });
  if(isPng(original)||isJpg(original)){
   append({...base,kind:"image",image:original,mime:isPng(original)?"image/png":"image/jpeg",page:1,total:1});
   continue;
  }
  let readable=original,reason="",pdf=isPdf(original);
  const ext=extOf(source.file_name||source.file_key);
  if(!pdf&&OFFICE_EXT.has(ext)&&environmentSupportsConversion(store)){
   try{readable=await convertOfficeToPdf(original,source.file_name||source.file_key);pdf=isPdf(readable);}
   catch(e){reason="Office格式暂无法在当前环境转换为图片："+safeText(e.message).slice(0,75);}
  }
  if(pdf&&environmentSupportsConversion(store)){
   try{
    const pages=await renderPdfPages(readable);
    pages.forEach((image,i)=>append({...base,kind:"image",image,mime:"image/png",
     page:i+1,total:pages.length}));
    continue;
   }catch(e){
    if(e instanceof HttpError)throw e;
    reason="原件PDF无法转为可见幻灯片："+safeText(e.message).slice(0,80);
   }
  }
  if(["txt","csv"].includes(ext)){
   const text=original.toString("utf8").slice(0,7000);
   for(const [i,segment] of textSegments(text).entries())append({...base,kind:"text",text:segment,
    page:i+1,total:0});
   continue;
  }
  if(strict)throw new HttpError(503,"ARCHIVE_PPT_RENDER_UNAVAILABLE",
   "原件在当前服务器无法转换为PPT内容，请使用PDF导出："+safeText(source.name));
  append({...base,kind:"text",
   text:(reason||"当前运行环境不支持将此格式渲染到PPT页面。")+
    "\n原件已在PPTX包内随资料打包（ppt/embeddings）；PDF材料下载可查看原件完整内容。"+
    "\n文件："+cleanName(source.file_name||source.name),
   page:1,total:1,fallback:true});
 }
 return {slides,attachments};
}
module.exports={materialSlides,renderPdfPages,convertOfficeToPdf,MAX_SLIDES};
