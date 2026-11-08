"use strict";
/** 兼容本地 Office 现代文档：优先提取 DOCX/PPTX/XLSX 内嵌文字，不把文件名当证据。 */
const PizZip=require("pizzip");
const {detectOoxml,MIME}=require("./ooxml");
const SUPPORTED=new Set(["docx","pptx","xlsx","txt","csv"]);
const {MAX_BYTES}=require("./storage");
function entities(text){
 return String(text||"").replace(/&#x([0-9a-f]+);/gi,(_,n)=>String.fromCodePoint(parseInt(n,16)))
  .replace(/&#(\d+);/g,(_,n)=>String.fromCodePoint(Number(n)))
  .replace(/&amp;/g,"&").replace(/&lt;/g,"<").replace(/&gt;/g,">")
  .replace(/&quot;/g,'"').replace(/&apos;/g,"'");
}
function flat(xml){
 return entities(String(xml).replace(/<\/(?:w:p|a:p|row|si|text:p)>/g,"\n")
  .replace(/<\/(?:a:br|w:br)>/g,"\n").replace(/<[^>]*>/g," "))
  .replace(/[ \t]+/g," ").replace(/\n\s+/g,"\n").trim();
}
function extract(buffer,ext){
 if(!SUPPORTED.has(ext))return null;
 if(!Buffer.isBuffer(buffer)||buffer.length>MAX_BYTES||!buffer.length)
  throw Object.assign(new Error("Office文档超过50MB或不是有效文件"),{status:422,code:"OFFICE_INVALID"});
 if(ext==="txt"||ext==="csv"){
  let text=buffer.toString("utf8").replace(/\0/g,"");
  return {text:text.slice(0,30000),mode:"native-text",engine:"UTF-8原始文档",pages:0,totalPages:0,truncated:text.length>30000};
 }
 if(detectOoxml(buffer)!==MIME[ext])
  throw Object.assign(new Error("Office文件内部格式不符合扩展名，无法自动提取"),{status:422,code:"OFFICE_INVALID"});
 const zip=new PizZip(buffer);
 const names=Object.keys(zip.files);
 const contents=[],maxPart=10*1024*1024;
 const add=name=>{
  const node=zip.file(name);
  if(!node)return;
  const str=node.asText();
  if(str.length>maxPart)throw Object.assign(new Error("Office内部XML过大，已停止提取"),{status:422,code:"OFFICE_TOO_LARGE"});
  contents.push(str);
 };
 if(ext==="docx")add("word/document.xml");
 if(ext==="pptx"){
  const slides=names.filter(x=>/^ppt\/slides\/slide\d+\.xml$/.test(x)).sort((a,b)=>
    Number(a.match(/\d+(?=\.xml)/)[0])-Number(b.match(/\d+(?=\.xml)/)[0]));
  for(const name of slides.slice(0,80))add(name);
 }
 if(ext==="xlsx"){
  add("xl/sharedStrings.xml");
  const sheets=names.filter(x=>/^xl\/worksheets\/sheet\d+\.xml$/.test(x));
  for(const name of sheets.slice(0,40))add(name);
 }
 const text=contents.map(flat).join("\n").slice(0,30000);
 if(!text.trim())throw Object.assign(new Error("Office文件没有可提取的文本"),{status:422,code:"OFFICE_EMPTY"});
 return {text,mode:"office-text",engine:"Office原生文本提取",pages:0,totalPages:0,
  truncated:contents.reduce((n,x)=>n+x.length,0)>30000,
  note:"Office内嵌文本提取并非图片OCR；嵌入截图、扫描页和复杂表格仍需人工核对"};
}
module.exports={extract,SUPPORTED};
