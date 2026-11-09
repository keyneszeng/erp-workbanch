"use strict";
/**
 * 归档导出前的原件压缩。
 *
 * 目的：材料库里常有大体积原件（课件 PPTX、扫描 PDF、手机照片），
 * 直接合并会让导出的 PDF 过大甚至被单份 20MB 限制拦下。
 * 这里按格式选择压缩方式，尽量保留可读内容：
 *   - 图片：等比缩到最长边 2400px，转 JPEG（质量 82）
 *   - PDF：Ghostscript /ebook 重采样图像（保留文字层与页面结构）
 *   - Office（pptx/docx/xlsx/ppt/doc/xls）：LibreOffice 转 PDF，再按需 gs 压缩
 *   - 其他格式：不处理，交调用方决定
 *
 * 所有外部命令都在临时目录里跑，带超时与串行锁：
 * 同一时间只压缩一份，避免 LibreOffice/Ghostscript 并发把 1.7G 内存打满。
 */
const fs=require("node:fs/promises");
const os=require("node:os");
const path=require("node:path");
const {execFile}=require("node:child_process");
const {promisify}=require("node:util");
const run=promisify(execFile);

const MAX_EDGE=2400,JPEG_QUALITY="82",CMD_TIMEOUT=180000;
const OFFICE_EXT=new Set(["pptx","ppt","docx","doc","xlsx","xls"]);
const IMAGE_EXT=new Set(["jpg","jpeg","png","webp"]);

// 串行锁：压缩是内存/CPU 密集型，不能并发跑多个 LibreOffice。
let queue=Promise.resolve();
function serial(fn){
 const next=queue.then(fn,fn);
 queue=next.then(()=>undefined,()=>undefined);
 return next;
}
function extOf(name){return String(name||"").split(".").pop().toLowerCase();}
async function withTempDir(fn){
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),"erp-compress-"));
 try{return await fn(dir);}
 finally{await fs.rm(dir,{recursive:true,force:true}).catch(()=>{});}
}
async function hasCommand(cmd){
 try{await run(cmd,["--version"],{timeout:8000});return true;}
 catch{return false;}
}
async function gsCompress(input,output){
 await run("gs",["-q","-dNOPAUSE","-dBATCH","-dSAFER","-sDEVICE=pdfwrite",
  "-dCompatibilityLevel=1.5","-dPDFSETTINGS=/ebook",
  "-dColorImageResolution=150","-dGrayImageResolution=150","-dMonoImageResolution=300",
  "-dEmbedAllFonts=true","-dSubsetFonts=true",
  "-sOutputFile="+output,input],{timeout:CMD_TIMEOUT,maxBuffer:8*1024*1024});
 const stat=await fs.stat(output);
 return await fs.readFile(output).then(buf=>({buf,size:stat.size}));
}
async function compressImage(input,ext,dir){
 if(!await hasCommand("convert"))
  throw Object.assign(new Error("未安装 ImageMagick，无法压缩图片"),{code:"COMPRESS_TOOL_MISSING"});
 const output=path.join(dir,"image.jpg");
 // 透明 PNG 铺白底，避免转 JPEG 后出现黑块。
 await run("convert",[input,"-auto-orient","-resize",MAX_EDGE+"x"+MAX_EDGE+">",
  "-background","white","-alpha","remove","-alpha","off",
  "-strip","-quality",JPEG_QUALITY,output],{timeout:CMD_TIMEOUT,maxBuffer:8*1024*1024});
 return {buf:await fs.readFile(output),type:"image/jpeg"};
}
async function compressOffice(input,ext,dir,limitBytes){
 if(!await hasCommand("soffice"))
  throw Object.assign(new Error("未安装 LibreOffice，无法转换 Office 原件"),{code:"COMPRESS_TOOL_MISSING"});
 await run("soffice",["--headless","--norestore","--convert-to","pdf","--outdir",dir,input],
  {timeout:CMD_TIMEOUT,maxBuffer:8*1024*1024});
 const converted=path.join(dir,path.basename(input).replace(/\.[^.]+$/,"")+".pdf");
 const buf=await fs.readFile(converted);
 if(buf.length<=limitBytes)return {buf,type:"application/pdf"};
 // 转出来的 PDF 仍偏大时再用 gs 压一遍。
 const squeezed=await gsCompress(converted,path.join(dir,"office-squeezed.pdf"));
 return {buf:squeezed.buf,type:"application/pdf"};
}
/**
 * @returns {Promise<{bytes:Buffer,type:string,method:string,note:string}|null>}
 *   null 表示该格式没有可用压缩策略（调用方按原逻辑处理）。
 */
async function compressOriginal(bytes,{type,fileName}={}){
 const ext=extOf(fileName);
 const isPdf=type==="application/pdf"||ext==="pdf";
 const isImage=type==="image/jpeg"||type==="image/png"||IMAGE_EXT.has(ext);
 const isOffice=OFFICE_EXT.has(ext);
 if(!isPdf&&!isImage&&!isOffice)return null;
 return serial(()=>withTempDir(async dir=>{
  const input=path.join(dir,"source."+ext);
  await fs.writeFile(input,bytes);
  if(isPdf){
   const out=await gsCompress(input,path.join(dir,"compressed.pdf"));
   return {bytes:out.buf,type:"application/pdf",method:"ghostscript",
    note:"PDF 已用 Ghostscript 重采样压缩"};
  }
  if(isImage){
   const out=await compressImage(input,ext,dir);
   return {bytes:out.buf,type:out.type,method:"imagemagick",
    note:"图片已缩放至最长边 "+MAX_EDGE+"px 并重新压缩"};
  }
  const out=await compressOffice(input,ext,dir,20*1024*1024);
  return {bytes:out.buf,type:"application/pdf",method:"libreoffice",
   note:"Office 原件已转换为 PDF 压缩版"};
 }));
}
module.exports={compressOriginal,MAX_EDGE,OFFICE_EXT,IMAGE_EXT};
