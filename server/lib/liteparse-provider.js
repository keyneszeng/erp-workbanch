"use strict";
/** Optional PDF parser. The only OCR backend is our local RapidOCR sidecar.
 * Do not accept a user-supplied binary path, URL, model or command arguments.
 */
const path=require("node:path");
const ENGINE="LiteParse 2.21.4 + RapidOCR (local)";
const DEFAULT_BIN="/opt/erp-liteparse/node_modules/.bin/lit";
const OCR_URL="http://127.0.0.1:18765/ocr";
function enabled(env=process.env){return env.ERP_LITEPARSE_ENABLED==="1";}
function binary(env=process.env){
 const bin=String(env.ERP_LITEPARSE_BIN||DEFAULT_BIN);
 if(!path.isAbsolute(bin))throw Error("ERP_LITEPARSE_BIN must be absolute");
 return bin;
}
function parseResult(raw,pages,totalPages){
 const d=JSON.parse(raw);
 if(!d||!Array.isArray(d.pages)||d.pages.length!==pages||
    (d.page_errors!=null&&(!Array.isArray(d.page_errors)||d.page_errors.length)))
   throw Error("LiteParse returned incomplete pages");
 const ordered=[...d.pages].sort((a,b)=>a.page-b.page);
 if(ordered.some((p,i)=>p.page!==i+1||typeof p.text!=="string"||!Array.isArray(p.text_items)))
   throw Error("LiteParse page schema mismatch");
 // Spatial projection retains line/column gaps for existing business extractors.
 // A blank page is conservatively sent through the existing fallback pipeline.
 if(ordered.some(p=>!p.text.trim()))throw Error("LiteParse returned a blank page");
 const text=ordered.map(p=>p.text).join("\n\n");
 if(text.length>100000)throw Error("LiteParse text exceeds existing extraction limit");
 return {text,mode:"pdf-hybrid",engine:ENGINE,pages,totalPages,truncated:totalPages>pages};
}
let active=false;
async function recognizePdf(file,pages,totalPages,exec){
 // Keep additional CPU/memory usage bounded. If busy, caller falls back.
 if(active)throw Error("LiteParse busy");
 active=true;
 try{
  const out=await exec(binary(),["parse",file,"--format","json","--ocr-server-url",OCR_URL,
    "--ocr-language","zh","--target-pages",pages===1?"1":"1-"+pages,
    "--max-pages",String(pages),"--num-workers","1","--dpi","250","--quiet"],
    {timeout:120000,maxBuffer:16*1024*1024,rejectPartialOcr:true,localOcr:true});
  return parseResult(out,pages,totalPages);
 }finally{active=false;}
}
module.exports={ENGINE,DEFAULT_BIN,OCR_URL,enabled,binary,parseResult,recognizePdf};
