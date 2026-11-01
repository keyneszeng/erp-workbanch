"use strict";
const path=require("node:path");
const MAX_PAGES=3, MAX_SIZE=8*1024*1024;
function fail(code,message,status=503){return Object.assign(new Error(message),{status,code});}
function enabled(){return typeof process!=="undefined"&&process.env?.ERP_OCR_ENABLED==="1";}
async function execNative(program,args,opts={}){
  const child=process.getBuiltinModule?.("node:child_process");
  if(!child)throw fail("OCR_UNAVAILABLE","当前部署不支持本地 OCR");
  return new Promise((resolve,reject)=>child.execFile(program,args,{
    encoding:"utf8",timeout:opts.timeout||20000,maxBuffer:2*1024*1024,
    windowsHide:true,shell:false,env:{...process.env,OMP_THREAD_LIMIT:"1"}
  },(e,stdout)=>{
    if(!e)return resolve(String(stdout||""));
    if(e.code==="ENOENT")return reject(fail("OCR_ENGINE_MISSING","OCR 依赖尚未安装："+program));
    if(e.killed||e.code==="ETIMEDOUT")return reject(fail("OCR_TIMEOUT","OCR 超时，请缩小文件或提高扫描质量",422));
    reject(fail("OCR_PROCESS_FAILED","OCR 引擎未能处理此文件（损坏、加密或无法解析）",422));
  }));
}
function cleanText(x){return String(x||"").replace(/\0/g,"").replace(/\r\n?/g,"\n").replace(/[\x01-\x08\x0b\x0c\x0e-\x1f]/g,"").trim().slice(0,30000);}
async function runOCRImage(file,exec=execNative){
  return cleanText(await exec("tesseract",[file,"stdout","-l","chi_sim+eng","--psm","3","quiet"],{timeout:25000}));
}
async function recognize(buffer,ext,opts={}){
  if(!enabled())throw fail("OCR_DISABLED","OCR 尚未启用，请在 ECS 设置 ERP_OCR_ENABLED=1");
  if(!Buffer.isBuffer(buffer)||!buffer.length||buffer.length>MAX_SIZE)throw fail("OCR_INVALID_INPUT","OCR 文件必须在 8 MB 以内",400);
  if(!["png","jpg","pdf"].includes(ext))throw fail("OCR_UNSUPPORTED","OCR 支持 JPG、PNG 和 PDF；Office 文件请先导出 PDF",415);
  if(!process.getBuiltinModule?.("node:child_process"))throw fail("OCR_UNAVAILABLE","Cloudflare 等运行环境不支持本地 OCR");
  const fs=process.getBuiltinModule("node:fs/promises"),os=process.getBuiltinModule("node:os");
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),"erp-ocr-"));
  const exec=opts.exec||execNative;
  try{
    await fs.chmod(dir,0o700);
    const file=path.join(dir,"original."+ext);
    const {sniffMime}=require("./storage");
    if(sniffMime(buffer)!=={png:"image/png",jpg:"image/jpeg",pdf:"application/pdf"}[ext])
      throw fail("OCR_MIME_MISMATCH","原件内容与扩展名不符",400);
    await fs.writeFile(file,buffer,{mode:0o600});
    let text="",mode="ocr",pages=1,totalPages=1,truncated=false;
    if(ext==="pdf"){
      const info=await exec("pdfinfo",[file],{timeout:10000});
      const match=/^Pages:\s+(\d+)/im.exec(info);
      if(!match||!(+match[1]>0))throw fail("OCR_INVALID_PDF","PDF 页数无效或文件已加密",422);
      totalPages=+match[1];pages=Math.min(totalPages,MAX_PAGES);truncated=totalPages>MAX_PAGES;
      const layer=cleanText(await exec("pdftotext",["-f","1","-l",String(pages),"-layout",file,"-"],{timeout:10000}));
      if(layer.length>=40){text=layer;mode="pdf-text";}
      else{
        const prefix=path.join(dir,"page");
        await exec("pdftoppm",["-f","1","-l",String(pages),"-scale-to","1800","-png","-r","140",file,prefix],{timeout:30000});
        const files=(await fs.readdir(dir)).filter(s=>/^page-\d+\.png$/.test(s)).sort((a,b)=>
          Number(a.match(/\d+/)[0])-Number(b.match(/\d+/)[0]));
        if(!files.length)throw fail("OCR_RENDER_FAILED","未能转换 PDF 扫描页",422);
        const chunks=[];
        for(const name of files.slice(0,MAX_PAGES))chunks.push(await runOCRImage(path.join(dir,name),exec));
        text=cleanText(chunks.join("\n"));mode="pdf-ocr";
      }
    }else text=await runOCRImage(file,exec);
    if(!text)throw fail("OCR_EMPTY","没有识别到文字，请检查扫描清晰度或人工填写",422);
    return {text,mode,engine:mode==="pdf-text"?"Poppler pdftotext":"Tesseract chi_sim+eng",pages,totalPages,truncated};
  }finally{await fs.rm(dir,{recursive:true,force:true}).catch(()=>{});}
}
function parseAgenda(raw){
  const lines=cleanText(raw).split("\n").map(s=>s.replace(/[\t　]+/g," ").trim()).filter(Boolean);
  const out=[],seen=new Set();let pending="";
  function add(a,b){
    const speaker=String(a||"").replace(/^(?:讲者|讲师|演讲人|授课人)\s*[:：]?/,"").trim();
    const topic=String(b||"").replace(/^(?:课题|主题|演讲题目|报告题目|讲题)\s*[:：]?/,"").trim();
    if(speaker.length<2||speaker.length>45||topic.length<3||topic.length>160||/^(会议|时间|地点|主题|开场|结束|签到|议程|姓名|职务|主持)/.test(speaker))return;
    const key=(speaker+"|"+topic).replace(/\s+/g,"").toLowerCase();
    if(!seen.has(key)){seen.add(key);out.push({speaker,topic});}
  }
  for(const rawLine of lines){
    if(out.length>=100)break;
    const line=rawLine.replace(/^\d{1,2}[:：]\d{2}\s*(?:[-—~至]\s*\d{1,2}[:：]\d{2})?\s*/,"").trim();
    let m=line.match(/(?:讲者|讲师|演讲人|授课人|Speaker|Presenter)\s*[:：]?\s*([^，,;；|]{2,35}?)\s+(?:课题|主题|讲题|报告题目|Topic|Subject)\s*[:：]?\s*(.{3,160})/i);
    if(m){add(m[1],m[2]);pending="";continue;}
    m=line.match(/^(.{2,35}?(?:教授|主任|医生|博士|老师|Dr\.?\s+\w+))\s*[：:|｜—-]\s*(.{3,160})$/iu);
    if(m){add(m[1],m[2]);pending="";continue;}
    m=line.match(/^(?:讲者|讲师|演讲人|授课人|Speaker|Presenter)\s*[:：]\s*(.{2,35})$/i);
    if(m){pending=m[1];continue;}
    m=line.match(/^(?:课题|讲题|主题|演讲题目|报告题目|Topic|Subject)\s*[:：]\s*(.{3,160})$/i);
    if(m&&pending){add(pending,m[1]);pending="";continue;}
    m=line.match(/^([^|｜]{2,35})\s*[|｜]\s*([^|｜]{3,160})$/);
    if(m&&!/^(讲者|姓名|课程|课题)$/.test(m[1].trim())){add(m[1],m[2]);pending="";}
  }
  return out;
}
module.exports={enabled,recognize,parseAgenda,cleanText,runOCRImage,MAX_PAGES};
