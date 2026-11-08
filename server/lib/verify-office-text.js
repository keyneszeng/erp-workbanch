"use strict";
/**
 * Office native-text reader. XLSX uses its actual worksheet cells (rather than
 * concatenating sharedStrings.xml, which includes UNUSED names and loses rows).
 * No macro execution, network calls or image OCR is performed.
 */
const PizZip=require("pizzip");
const {detectOoxml,MIME}=require("./ooxml");
const {MAX_BYTES}=require("./storage");
const SUPPORTED=new Set(["docx","pptx","xlsx","txt","csv"]);
const XLSX_ENGINE="Excel表格结构化文本提取 v2";
const MAX_TEXT=30000,MAX_PART=10*1024*1024;
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
function error(message,code="OFFICE_INVALID"){
 return Object.assign(new Error(message),{status:422,code});
}
/** Extract text from OOXML rich-text <t> runs; neither tags nor shared indices are evidence. */
function richText(xml){
 const found=[];
 for(const m of String(xml||"").matchAll(/<(?:[A-Za-z_][\w.-]*:)?t\b[^>]*>([\s\S]*?)<\/(?:[A-Za-z_][\w.-]*:)?t>/g))
  found.push(entities(m[1]));
 return found.join("");
}
function attribute(attrs,name){
 const re=new RegExp("(?:^|\\s)"+name+"\\s*=\\s*([\"'])(.*?)\\1");
 return re.exec(attrs)?.[2]||"";
}
function colNum(ref){
 const letters=/^[A-Z]{1,3}/i.exec(String(ref||""))?.[0]?.toUpperCase()||"";
 let n=0;
 for(const x of letters)n=n*26+x.charCodeAt(0)-64;
 return n;
}
function parseXlsx(zip,names){
 const fetch=name=>{
  const node=zip.file(name);
  if(!node)return "";
  const raw=node.asText();
  if(raw.length>MAX_PART)throw error("Excel工作表 XML 过大，无法安全提取","OFFICE_TOO_LARGE");
  return raw;
 };
 const shared=[];
 const sharedXml=fetch("xl/sharedStrings.xml");
 for(const m of sharedXml.matchAll(/<(?:\w+:)?si\b[^>]*>([\s\S]*?)<\/(?:\w+:)?si>/g))
  shared.push(richText(m[1]));
 // Sheet order is numeric; unlike sharedStrings, only ACTUALLY REFERENCED cells
 // are emitted. Empty cells are skipped; each worksheet row retains its grouping.
 const sheets=names.filter(x=>/^xl\/worksheets\/sheet\d+\.xml$/.test(x))
  .sort((a,b)=>Number(a.match(/\d+(?=\.xml)/)[0])-Number(b.match(/\d+(?=\.xml)/)[0]));
 let result="",truncated=sheets.length>40;
 const append=line=>{
  if(result.length>=MAX_TEXT){truncated=true;return false;}
  const text=(result?"\n":"")+line;
  const free=MAX_TEXT-result.length;
  if(text.length>free){result+=text.slice(0,free);truncated=true;return false;}
  result+=text;
  return true;
 };
 for(const name of sheets.slice(0,40)){
  const xml=fetch(name),number=Number(name.match(/\d+(?=\.xml)/)[0]);
  if(!append("工作表 "+number))break;
  // A row is a semantic unit for attendance lists. Preserve cell order even
  // when the worksheet XML contains sparse columns / gaps.
  for(const row of xml.matchAll(/<(?:\w+:)?row\b[^>]*>([\s\S]*?)<\/(?:\w+:)?row>/g)){
   const cells=[];let seq=0;
   const re=/<(?:\w+:)?c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/(?:\w+:)?c>)/g;
   for(const c of row[1].matchAll(re)){
    const type=attribute(c[1],"t");
    const body=c[2]||"";
    const v=/<(?:\w+:)?v\b[^>]*>([\s\S]*?)<\/(?:\w+:)?v>/g.exec(body)?.[1];
    let value="";
    if(type==="s"){
      // Shared strings contain unused entries too. Resolve ONLY the index
      // used by this actual cell, never append the string table wholesale.
      const idx=Number(v);
      if(Number.isSafeInteger(idx)&&idx>=0&&idx<shared.length)value=shared[idx];
    }else if(type==="inlineStr"){
      const inline=/<(?:\w+:)?is\b[^>]*>([\s\S]*?)<\/(?:\w+:)?is>/.exec(body);
      value=richText(inline?.[1]||body);
    }else if(type!=="e"){
      // Numbers and cached formula values are in <v>, not <t>.
      value=v!==undefined?entities(v):richText(body);
    }
    value=String(value||"").replace(/[\r\n\t]+/g," ").trim();
    if(value){
      const col=colNum(attribute(c[1],"r"))||++seq;
      cells.push({col,value});
    }
   }
   if(cells.length){
    cells.sort((a,b)=>a.col-b.col);
    if(!append(cells.map(c=>c.value).join("\t")))break;
   }
  }
  if(result.length>=MAX_TEXT){truncated=true;break;}
 }
 return {text:result,mode:"office-text",engine:XLSX_ENGINE,pages:0,totalPages:0,
  truncated,note:"Excel按工作表实际单元格逐行提取（含共享字符串、内联文字及数值）；不含图片或手写签名，仍需人工核对签到真实性"};
}
function extract(buffer,ext){
 if(!SUPPORTED.has(ext))return null;
 if(!Buffer.isBuffer(buffer)||buffer.length>MAX_BYTES||!buffer.length)
  throw error("Office文档超过50MB或不是有效文件");
 if(ext==="txt"||ext==="csv"){
  const text=buffer.toString("utf8").replace(/\0/g,"");
  return {text:text.slice(0,MAX_TEXT),mode:"native-text",engine:"UTF-8原始文档",
   pages:0,totalPages:0,truncated:text.length>MAX_TEXT};
 }
 if(detectOoxml(buffer)!==MIME[ext])
  throw error("Office文件内部格式不符合扩展名，无法自动提取");
 const zip=new PizZip(buffer),names=Object.keys(zip.files);
 if(ext==="xlsx"){
  const result=parseXlsx(zip,names);
  if(!result.text.trim())throw error("Excel工作簿中没有可提取的实际单元格内容","OFFICE_EMPTY");
  return result;
 }
 const contents=[];
 const add=name=>{
  const node=zip.file(name);
  if(!node)return;
  const str=node.asText();
  if(str.length>MAX_PART)throw error("Office内部XML过大，已停止提取","OFFICE_TOO_LARGE");
  contents.push(str);
 };
 if(ext==="docx")add("word/document.xml");
 if(ext==="pptx"){
  const slides=names.filter(x=>/^ppt\/slides\/slide\d+\.xml$/.test(x)).sort((a,b)=>
    Number(a.match(/\d+(?=\.xml)/)[0])-Number(b.match(/\d+(?=\.xml)/)[0]));
  for(const name of slides.slice(0,80))add(name);
 }
 const text=contents.map(flat).join("\n").slice(0,MAX_TEXT);
 if(!text.trim())throw error("Office文件没有可提取的文本","OFFICE_EMPTY");
 return {text,mode:"office-text",engine:"Office原生文本提取",pages:0,totalPages:0,
  truncated:contents.reduce((n,x)=>n+x.length,0)>MAX_TEXT,
  note:"Office内嵌文本提取并非图片OCR；嵌入截图、扫描页和复杂表格仍需人工核对"};
}
module.exports={extract,SUPPORTED,XLSX_ENGINE,parseXlsx};
