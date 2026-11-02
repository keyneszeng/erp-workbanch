"use strict";
const path=require("node:path");
const MAX_PAGES=3, MAX_SIZE=Math.max(1,Number(process.env.ERP_MAX_FILE_MB||50))*1024*1024;
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
  if(!Buffer.isBuffer(buffer)||!buffer.length||buffer.length>MAX_SIZE)throw fail("OCR_INVALID_INPUT",`OCR 文件必须在 ${Math.round(MAX_SIZE/1024/1024)} MB 以内`,400);
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
        // 议程多为表格，字号小、列多。1800px 时同一行的「时间/内容/讲者/单位」会被糊成一块，
        // 实测 2400px + 200dpi 才能把一行的四个格子基本读开。
        await exec("pdftoppm",["-f","1","-l",String(pages),"-scale-to","2400","-png","-r","200",file,prefix],{timeout:60000});
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
/**
 * 把议程还原成「时间 / 课题 / 讲者 / 单位」四列。
 *
 * 为什么要按时间行切：议程表在 OCR 里是按列读出来的碎片，
 * 直接按行找「讲者：X 课题：Y」几乎匹配不到。而时间（19:35-20:05）
 * 是每行最稳定的锚点 —— 认准它，后面跟着的几行就属于同一场次。
 */
function parseAgendaRows(raw){
  const lines=cleanText(raw).split("\n").map(x=>x.replace(/[\t　]+/g," ").replace(/\s{2,}/g,"  ").trim())
    .filter(Boolean)
    // 页脚、页码、纯英文噪声行（OCR 对表格线常吐出「ARE」「HATE」这类碎片）
    .filter(x=>!/^(注\s*[:：]|备注|最终日程|第\s*\d+\s*页)/.test(x))
    // 会议时间/地点/主办/联系人这类抬头信息不是场次内容
    .filter(x=>!/^(会议时间|会议地点|会议形式|主办|承办|协办|联系人|联系电话|邮箱|地址)\s*[:：]?/.test(x))
    .filter(x=>!/^[A-Za-z\s|·.,-]{1,12}$/.test(x));
  const TIME=/^(\d{1,2}[:：]\d{2})\s*[-–—~至]?\s*(\d{1,2}[:：]\d{2})?/;
  const rows=[];let cur=null,orphan="";
  for(const line of lines){
    const m=line.match(TIME);
    if(m){
      if(cur)rows.push(cur);
      const time=(m[1]+(m[2]?"-"+m[2]:"")).replace(/：/g,":");
      const rest=line.slice(m[0].length).trim();
      // 表格单元格常跨行：课题的上半截会出现在时间行之前，先接过来
      cur={time,cells:[orphan,rest].filter(Boolean)};
      orphan="";
    }else if(cur){
      cur.cells.push(line);
    }else{
      // 还没有时间行时先留一行，等下一个时间行归给它；
      // 但标题/日程说明不是内容，别当成课题
      orphan=/(议程|日程|会议名称|标题|邀请函|安排)$/.test(line)||line.length>40?"":line;
    }
  }
  if(cur)rows.push(cur);

  const ORG=/(医院|大学|学院|学会|协会|中心|公司|研究所|卫生院|保健院|门诊部)/;
  const TITLE=/(教授|主任|医师|医生|博士|老师|院长|护士长|Dr\.?)/i;
  // 议程环节词：它们出现在「讲者」列的位置，但不是人
  const STEP=/^(讨论|总结|主持|致辞|签到|茶歇|开幕|闭幕|合影|午餐|晚宴|会议|日程|备注|提问|交流|答疑|休息|签到入场)$/;
  // 表头单元格：OCR 把表头也读进来时，不能当成讲者或课题
  const HEADER=/^(姓名|职务|职称|单位|医院|时间|内容|讲者|讲师|主持|备注|序号|日程|环节|课程)$/;

  return rows.filter(r=>{
    // 带显式标签的行交给 parseAgenda 的标签路径处理，这里跳过，
    // 否则同一场次会被两种解析各出一遍，还可能配错对
    const labeled=r.cells.some(c=>/(讲者|讲师|演讲人|授课人|Speaker|Presenter)\s*[:：]/i.test(c)
      ||/(课题|主题|讲题|演讲题目|报告题目|Topic|Subject)\s*[:：]/i.test(c));
    return !labeled;
  }).map(r=>{
    let cells=r.cells.join("  ").split(/\s{2,}|[|｜]/).map(x=>x.replace(/[，,。;；]$/,"").trim()).filter(x=>x.length>=1);
    // 「讲者：张三教授 课题：胃肠病诊疗新进展」这类一行写完的，先按标签拆成两块
    cells=cells.flatMap(cell=>{
      const m=cell.match(/(?:讲者|讲师|演讲人|授课人|Speaker|Presenter)\s*[:：]\s*(.+?)\s+(?:课题|主题|讲题|演讲题目|报告题目|Topic|Subject)\s*[:：]\s*(.+)$/i);
      return m?[m[1].trim(),m[2].trim()]:[cell];
    });
    // 单独的「讲者：X」「课题：Y」去掉标签，剩下的交给位置判断
    cells=cells.map(cell=>cell
      .replace(/^(?:讲者|讲师|演讲人|授课人|Speaker|Presenter)\s*[:：]\s*/i,"")
      .replace(/^(?:课题|主题|讲题|演讲题目|报告题目|Topic|Subject)\s*[:：]\s*/i,""));
    // 只把「院/学/心/司/所」这类单字后缀接回上一个单元格（机构名折行的典型形态），
    // 不能见短就并：「讨论」后面的「院」并过去会变成「讨论院」这种假讲者。
    const merged=[];
    for(const cell of cells){
      const prev=merged[merged.length-1];
      const orgTail=cell.length===1&&/[院学心司所]/.test(cell)&&(prev||"").length>=4;
      if(prev&&orgTail&&!/[。；，,]$/.test(prev))merged[merged.length-1]=prev+cell;
      else merged.push(cell);
    }
    const usable=merged.filter(x=>x.length>=2&&!HEADER.test(x));

    /**
     * 讲者按「机构名前面那一个」来认。
     * 表格里人名几乎总是紧挨着单位列，而单看字面分不清「临床」和「徐一劲」——
     * 用位置关系比用词表可靠得多。
     */
    const orgIdx=usable.findIndex(x=>ORG.test(x)&&x.length<=30);
    let speaker="",org="";
    if(orgIdx>=0){
      org=usable[orgIdx];
      for(let i=orgIdx-1;i>=0;i--){
        const c=usable[i];
        if(c.length>=2&&c.length<=6&&!STEP.test(c)&&!ORG.test(c)){speaker=c;break;}
      }
    }else{
      speaker=usable.find(x=>TITLE.test(x)&&x.length<=20)||"";
    }
    // 课题：讲者/单位之外最长的一条，且像内容（≥4 字、含中文、不是环节词或机构名）
    const topicPool=usable.filter(x=>x!==speaker&&x!==org&&x.length>=4
      &&/[\u4e00-\u9fa5]{2,}/.test(x)&&!STEP.test(x)&&!ORG.test(x)&&!HEADER.test(x));
    topicPool.sort((a,b)=>b.length-a.length);
    let topic=topicPool[0]||"";
    if(!speaker){
      const hit=topic.match(/([\u4e00-\u9fa5]{2,4}(?:教授|主任|医师|医生|博士))/);
      if(hit)speaker=hit[1];
    }
    return {time:r.time,topic,speaker,org};
  }).filter(r=>r.time&&(r.topic||r.speaker||r.org));
}

function parseAgenda(raw){
  /**
   * 两条路并用：
   *   1) 显式标签行（讲者：X 课题：Y / Speaker: X Topic: Y）—— 置信度最高；
   *   2) 按时间行还原的表格行 —— 覆盖「时间 | 内容 | 讲者 | 单位」这类议程表。
   * 先收 1 再补 2，同一组讲者+课题只留一条。
   */
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
    // 「张教授：课题」「Dr Alex - Topic」这类最常见写法。
    // 前缀必须是 .{0,35}?：写成 .{2,35}? 会强制名字前至少两个字符，
    // 于是「张教授：X」（教授二字就是名字结尾）和「Dr Alex - X」永远匹配不上，
    // 只有显式写「讲者：X 课题：Y」才认，等于把绝大多数议程挡在门外。
    m=line.match(/^(.{0,35}?(?:教授|主任|医生|博士|老师|Dr\.?\s+\w+))\s*[：:|｜—-]\s*(.{3,160})$/iu);
    if(m){add(m[1],m[2]);pending="";continue;}
    m=line.match(/^(?:讲者|讲师|演讲人|授课人|Speaker|Presenter)\s*[:：]\s*(.{2,35})$/i);
    if(m){pending=m[1];continue;}
    m=line.match(/^(?:课题|讲题|主题|演讲题目|报告题目|Topic|Subject)\s*[:：]\s*(.{3,160})$/i);
    if(m&&pending){add(pending,m[1]);pending="";continue;}
    m=line.match(/^([^|｜]{2,35})\s*[|｜]\s*([^|｜]{3,160})$/);
    if(m&&!/^(讲者|姓名|课程|课题)$/.test(m[1].trim())){add(m[1],m[2]);pending="";}
  }
  for(const r of parseAgendaRows(raw))
    if(r.speaker&&r.topic)add(r.speaker,r.topic);
  return out;
}
module.exports={enabled,recognize,parseAgenda,parseAgendaRows,cleanText,runOCRImage,MAX_PAGES};
