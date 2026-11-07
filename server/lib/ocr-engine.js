"use strict";
const path=require("node:path");
const MAX_PAGES=3, MAX_SIZE=Math.max(1,Number(process.env.ERP_MAX_FILE_MB||50))*1024*1024;
function fail(code,message,status=503){return Object.assign(new Error(message),{status,code});}
function enabled(){return typeof process!=="undefined"&&process.env?.ERP_OCR_ENABLED==="1";}
async function execNative(program,args,opts={}){
  const child=process.getBuiltinModule?.("node:child_process");
  if(!child)throw fail("OCR_UNAVAILABLE","当前部署不支持本地 OCR");
  return new Promise((resolve,reject)=>child.execFile(program,args,{
    encoding:"utf8",timeout:opts.timeout||20000,maxBuffer:opts.maxBuffer||2*1024*1024,
    windowsHide:true,shell:false,env:{...process.env,OMP_THREAD_LIMIT:"1"}
  },(e,stdout)=>{
    if(!e)return resolve(String(stdout||""));
    if(e.code==="ENOENT")return reject(fail("OCR_ENGINE_MISSING","OCR 依赖尚未安装："+program));
    if(e.killed||e.code==="ETIMEDOUT")return reject(fail("OCR_TIMEOUT","OCR 超时，请缩小文件或提高扫描质量",422));
    reject(fail("OCR_PROCESS_FAILED","OCR 引擎未能处理此文件（损坏、加密或无法解析）",422));
  }));
}
function cleanText(x){return String(x||"").replace(/\0/g,"").replace(/\r\n?/g,"\n").replace(/[\x01-\x08\x0b\x0c\x0e-\x1f]/g,"").trim().slice(0,30000);}
/* ───────────────────────── OCR 引擎：RapidOCR ─────────────────────────
 * 只用 RapidOCR（PP-OCR 的 ONNXRuntime 版），纯 CPU、离线运行。
 * 原件不出服务器，也不需要 GPU 或云 API。
 *
 * 只负责「原件 → 带列分隔的文本」。下游 parseAgendaRows / extractNames /
 * extractTopics 一行不改。
 * PDF 有文本层时仍走 pdftotext：比任何视觉模型都快且准。
 */
/**
 * 缓存里的识别结果是不是当前引擎产出的。
 * 历史上用过 tesseract，旧缓存的 engine 是 "Tesseract ..."；
 * 切到 RapidOCR 后必须重识别，否则用户会以为「换了引擎却没生效」。
 */
function providerMatches(engine){
  return String(engine||"").includes("RapidOCR");
}
/**
 * PDF 扫描页渲染成 PNG。
 * RapidOCR 的检测模型会把长边缩到约 960px，渲染 2400px 足够；
 * 再大只是让 pdftoppm 多花时间，不会提升识别率。
 */
async function renderPdf(dir,file,pages,exec,scale=3600){
  const fs=process.getBuiltinModule("node:fs/promises");
  const prefix=path.join(dir,"page");
  await exec("pdftoppm",["-f","1","-l",String(pages),"-scale-to",String(scale),"-gray","-png","-r","300",file,prefix],{timeout:90000});
  const files=(await fs.readdir(dir)).filter(s=>/^page-\d+\.png$/.test(s)).sort((a,b)=>
    Number(a.match(/\d+/)[0])-Number(b.match(/\d+/)[0]));
  if(!files.length)throw fail("OCR_RENDER_FAILED","未能转换 PDF 扫描页",422);
  return files.slice(0,MAX_PAGES).map(n=>path.join(dir,n));
}
/**
 * RapidOCR：PP-OCR 的 ONNXRuntime 版，纯 CPU，不用 GPU。
 *
 * 相比 tesseract 的三个优势（同一张议程表实测）：
 *   1) 中文错字少：东莞市不会被读成「莞市」，讲者「徐一劲」不再变噪声
 *   2) 每个文本框带坐标，按 x 间距还原表格列，不依赖空格数量
 *   3) 快：单页 2~4 秒，tesseract 要 10 秒
 * 代价是多一个 Python 进程，峰值内存约 560 MB。
 *
 * 这里只做「坐标 → 带列分隔的文本」，下游 parseAgendaRows 等一行不用改。
 */
function rapidItemsToText(items){
  const words=(items||[])
    .filter(x=>x&&String(x.text||"").trim()&&Number(x.score??1)>=0.3)
    .map(x=>({...x,text:String(x.text).trim()}));
  if(!words.length)return "";
  words.sort((a,b)=>a.y-b.y||a.x-b.x);
  const lines=[];let cur=null;
  for(const w of words){
    const h=Math.max(Number(w.h)||0,1);
    if(!cur||Math.abs(w.y-cur.y)>h*0.6){
      cur={y:w.y,h,words:[w]};
      lines.push(cur);
    }else{
      cur.words.push(w);
      cur.y=(cur.y*(cur.words.length-1)+w.y)/cur.words.length;
      cur.h=Math.max(cur.h,h);
    }
  }
  return lines.map(l=>{
    l.words.sort((a,b)=>a.x-b.x);
    let s="",prev=null;
    for(const w of l.words){
      if(prev){
        const gap=w.x-(prev.x+(Number(prev.w)||0));
        // 列间距约 42~138px、行高 30~37px，列内字间距接近 0。
        // 阈值取 1.0 倍行高：42>35 断列，列内 10<30 不断。
        if(gap>l.h*1.0)s+="\t";
        else if(/[A-Za-z0-9]$/.test(prev.text)&&/^[A-Za-z0-9]/.test(w.text))s+=" ";
      }
      s+=w.text;prev=w;
    }
    return s;
  }).filter(Boolean).join("\n");
}
async function recognizeRapid(file,dir,ext,pages,exec){
  const py=String(process.env.ERP_RAPIDOCR_PYTHON||"/opt/rapidocr-venv/bin/python");
  const script=path.join(__dirname,"rapid-ocr.py");
  const runOne=async(img)=>{
    let out;
    try{
      out=await exec(py,[script,img],{timeout:120000,maxBuffer:8*1024*1024});
    }catch(e){
      if(e&&e.code==="OCR_ENGINE_MISSING")
        throw fail("OCR_PROVIDER_MISCONFIGURED",`RapidOCR 未安装或解释器路径不对：${py}；请运行 deploy/aliyun/install-rapidocr.sh`,503);
      throw e;
    }
    let data;
    try{data=JSON.parse(out);}catch{throw fail("OCR_PROVIDER_FAILED","RapidOCR 返回了无法解析的结果",503);}
    if(data.error)throw fail("OCR_PROVIDER_FAILED","RapidOCR 失败："+data.error,503);
    return rapidItemsToText(data.items);
  };
  if(ext==="pdf"){
    const chunks=[];
    // RapidOCR 检测模型会把长边缩到 ~960px，渲染 2400px 足够，再大只是白等
    for(const img of await renderPdf(dir,file,pages,exec,2400))chunks.push(await runOne(img));
    return {text:cleanText(chunks.join("\n")),mode:"pdf-ocr",engine:"RapidOCR (PP-OCR)"};
  }
  return {text:cleanText(await runOne(file)),mode:"ocr",engine:"RapidOCR (PP-OCR)"};
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

    let pages=1,totalPages=1,truncated=false;
    if(ext==="pdf"){
      const info=await exec("pdfinfo",[file],{timeout:10000});
      const match=/^Pages:\s+(\d+)/im.exec(info);
      if(!match||!(+match[1]>0))throw fail("OCR_INVALID_PDF","PDF 页数无效或文件已加密",422);
      totalPages=+match[1];pages=Math.min(totalPages,MAX_PAGES);truncated=totalPages>MAX_PAGES;
      const layer=cleanText(await exec("pdftotext",["-f","1","-l",String(pages),"-layout",file,"-"],{timeout:10000}));
      // 有文本层就用文本层：比任何视觉模型都准，而且不花钱
      if(layer.length>=40)
        return {text:layer,mode:"pdf-text",engine:"Poppler pdftotext",pages,totalPages,truncated};
    }

    const out=await recognizeRapid(file,dir,ext,pages,exec);
    return {...out,pages:out.pages??pages,totalPages,truncated};
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
  const lines=cleanText(raw).split("\n")
    // \t 是 RapidOCR 的列分隔符，必须转成「两个空格」留给下面的分列正则，
    // 直接换成单空格会把整行糊成一列。
    .map(x=>x.replace(/[\t　]+/g,"  ").replace(/\s{2,}/g,"  ").trim())
    .filter(Boolean)
    // 页脚、页码、纯英文噪声行（OCR 对表格线常吐出「ARE」「HATE」这类碎片）
    .filter(x=>!/^(注\s*[，,:：]|备注|最终日程|第\s*\d+\s*页)/.test(x))
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
      // 表头行（时间/课题/讲者/单位）不是场次内容，别拼进第一条场次
      orphan=/^(时间|课题|讲者|单位|序号|姓名|身份证|手机|银行卡|金额|备注)(\s|$)/.test(line)
        ||/(议程|日程|会议名称|标题|邀请函|安排)$/.test(line)||line.length>40?"":line;
    }
  }
  if(cur)rows.push(cur);

  const ORG=/(医院|大学|学院|学会|协会|中心|公司|研究所|卫生院|保健院|门诊部)/;
  const TITLE=/(教授|主任|医师|医生|博士|老师|院长|护士长|Dr\.?)/i;
  // 议程环节词：它们出现在「讲者」列的位置，但不是人
  const STEP=/^(讨论|总结|主持|致辞|签到|茶歇|开幕|闭幕|合影|午餐|晚宴|会议|日程|备注|提问|交流|答疑|休息|签到入场)$/;
  // 表头单元格：OCR 把表头也读进来时，不能当成讲者或课题
  const HEADER=/^(姓名|职务|职称|单位|医院|时间|内容|讲者|讲师|主持|备注|序号|日程|环节|课程)$/;
  // 两三个字但不是人名的常见词：OCR 里它们常出现在「讲者」列的位置
  const NOT_NAME=/^(临床|讨论|总结|主持|致辞|专题|病例|手术|影像|诊疗|指南|研究|进展|交流|提问|答疑|签到|茶歇|开幕|闭幕|会议|日程|环节|内容|主题|课题)$/;
  // 「讨论主持」「开场致辞」「学术讨论」这类组合也要认成环节，不能当课题
  const isStep=x=>STEP.test(x)||/(主持|致辞|讨论|总结|签到|茶歇|答疑)$/.test(x);

  return rows.filter(r=>{
    // 带显式标签的行交给 parseAgenda 的标签路径处理，这里跳过，
    // 否则同一场次会被两种解析各出一遍，还可能配错对
    const labeled=r.cells.some(c=>/(讲者|讲师|演讲人|授课人|Speaker|Presenter)\s*[:：]/i.test(c)
      ||/(课题|主题|讲题|演讲题目|报告题目|Topic|Subject)\s*[:：]/i.test(c));
    return !labeled;
  }).map(r=>{
    // OCR 常把表格线读成标点，堆在单元格开头（，”内痔的规范化治疗）。
    // 不清理的话这些噪声会跟着进课题/讲者字段，人工核对时还得手工删。
    let cells=r.cells.join("  ").split(/\s{2,}|[|｜]/)
      .map(x=>x.replace(/^[，,。;；:：、“”"'‘’\s]+/,"").replace(/[，,。;；:：]+$/,"").trim())
      .filter(x=>x.length>=1);
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
        if(c.length>=2&&c.length<=6&&!isStep(c)&&!ORG.test(c)&&!NOT_NAME.test(c)&&!HEADER.test(c)){speaker=c;break;}
      }
    }else{
      speaker=usable.find(x=>TITLE.test(x)&&x.length<=20)||"";
    }
    // 课题：讲者/单位之外最长的一条，且像内容（≥4 字、含中文、不是环节词或机构名）
    const topicPool=usable.filter(x=>x!==speaker&&x!==org&&x.length>=4
      &&/[\u4e00-\u9fa5]{2,}/.test(x)&&!isStep(x)&&!ORG.test(x)&&!HEADER.test(x));
    topicPool.sort((a,b)=>b.length-a.length);
    let topic=topicPool[0]||"";
    if(!speaker){
      const hit=topic.match(/([\u4e00-\u9fa5]{2,4}(?:教授|主任|医师|医生|博士))/);
      if(hit)speaker=hit[1];
    }
    return {time:r.time,topic,speaker,org};
  }).filter(r=>r.time&&(r.topic||r.speaker||r.org));
}

/**
 * 从识别文本里抽人名。
 *
 * 第 2 步要核「三处名单一致」，靠人眼在三份材料里逐个对名字最容易漏。
 * 这里按几种在真实材料里稳定出现的形态抓：
 *   表格行（序号 姓名 身份证）、姓名后跟身份证/手机/银行卡、姓名带职称、
 *   姓名后跟机构名、显式「姓名：X」、以及「1.张三」这种编号名单。
 * 只做候选，不做判定 —— 抓出来的名字仍要人工确认。
 */
const NAME_STOP = /^(姓名|讲者|专家|主持|讨论|总结|单位|医院|科室|金额|合计|备注|日期|时间|序号|开户行|银行卡|身份证|手机|实发数|应税|个税|签章|盖章)$/;
function extractNames(raw) {
  const text = cleanText(raw);
  const found = new Map();
  const add = (n) => {
    const s = String(n || "").trim();
    if (s.length >= 2 && s.length <= 4 && /^[\u4e00-\u9fa5]+$/.test(s) && !NAME_STOP.test(s))
      found.set(s, (found.get(s) || 0) + 1);
  };
  // 表格行：序号 姓名 18 位身份证
  for (const m of text.matchAll(/(?:^|\n)\s*\d{1,3}\s+([\u4e00-\u9fa5]{2,4})\s+\d{17}[\dXx]/g)) add(m[1]);
  // 姓名 + 身份证 / 手机号 / 银行卡
  for (const m of text.matchAll(/([\u4e00-\u9fa5]{2,4})\s{2,}(?:\d{17}[\dXx]|1[3-9]\d{9}|\d{16,19})/g)) add(m[1]);
  // 姓名 + 职称
  for (const m of text.matchAll(/([\u4e00-\u9fa5]{2,4})(?=教授|主任|医师|医生|博士|老师|院长)/g)) add(m[1]);
  // 姓名 + 机构（表格里姓名列与单位列相邻）。
  // 必须要求姓名前面是行首或两个以上空白：否则「…诊疗策略与临  东莞市…」这种
  // 课题尾部的四个字会被当成人名。
  for (const m of text.matchAll(/(?:^|\n|\s{2,})([\u4e00-\u9fa5]{2,4})\s{2,}[\u4e00-\u9fa5]{2,12}(?:医院|大学|学院|学会|中心|卫生院)/g)) add(m[1]);
  // 显式标签
  for (const m of text.matchAll(/(?:姓名|讲者|专家|签字|签名)\s*[:：]\s*([\u4e00-\u9fa5]{2,4})/g)) add(m[1]);
  // 编号名单：1.刘志华 / 1、刘志华
  for (const m of text.matchAll(/(?:^|\n)\s*\d{1,3}\s*[.、]\s*([\u4e00-\u9fa5]{2,4})(?=\s|$)/g)) add(m[1]);
  return [...found.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([n]) => n);
}

/**
 * 从识别文本里抽「课题 / 讲题 / 主题」。
 *
 * 第 4 步核的是「课件课题 = 终版议程课题」。课件 PPT 里通常有一页议程表
 * （表头 时间 | 讲题 | 姓名 | 医院），或者每页第一行就是讲题；
 * 也常见「讲题：X」「主题：X」这种显式写法。
 * 只做候选，判定仍由人确认。
 */
const TOPIC_STOP = /^(主持|讨论|讨论主持|会议主持|总结|致辞|签到|茶歇|开幕|闭幕|合影|午餐|晚宴|答疑|提问|交流|时间|姓名|医院|单位|讲题|课题|主题|序号|备注)$/;
function extractTopics(raw) {
  const text = cleanText(raw);
  const out = [];
  const seen = new Set();
  const add = (t) => {
    let v = String(t || "").replace(/\s+/g, " ").trim()
      .replace(/^[#·\-*\s]+/, "").replace(/[，,。;；]$/, "").trim();
    if (v.length < 4 || v.length > 80) return;
    if (!/[\u4e00-\u9fa5]/.test(v)) return;
    if (TOPIC_STOP.test(v)) return;
    // 会议信息、简历条目、机构碎片都不是课题
    if (/腾讯会议|会议号|会议时间|主办方|承办方|会议地点/.test(v)) return;
    if (/(委员|理事|常委|学会|协会|博士生导师|主任医师|主治医师|护士长)/.test(v)) return;
    if (/(医院|大学|学院|中心|卫生院|人民医)$/.test(v)) return;
    const digits = (v.match(/\d/g) || []).length;
    if (digits / v.length > 0.3) return;
    const key = v.replace(/\s+/g, "").toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push(v);
  };
  // 1) 显式标签：「讲题：X」「主题：X」「课题：X」
  for (const m of text.matchAll(/(?:讲题|课题|主题|题目|Topic|Subject)\s*[:：]\s*([^\n]{4,80})/gi)) add(m[1]);
  // 2) 表格行：以时间为锚点，取「讲题」那一列（议程表/课件里的议程页）
  try {
    for (const r of parseAgendaRows(text)) if (r.topic) add(r.topic);
  } catch {}
  return out;
}

function parseAgenda(raw){
  /**
   * 两条路并用：
   *   1) 显式标签行（讲者：X 课题：Y / Speaker: X Topic: Y）—— 置信度最高；
   *   2) 按时间行还原的表格行 —— 覆盖「时间 | 内容 | 讲者 | 单位」这类议程表。
   * 先收 1 再补 2，同一组讲者+课题只留一条。
   */
  const lines=cleanText(raw).split("\n").map(s=>s.replace(/[\t　]+/g,"  ").trim()).filter(Boolean);
  const out=[],seen=new Set();let pending="";
  function add(a,b){
    const clean=(s)=>String(s||"").replace(/^[，,。;；:：、“”"'‘’\s]+/,"").replace(/[，,。;；:：]+$/,"").trim();
    const speaker=clean(String(a||"").replace(/^(?:讲者|讲师|演讲人|授课人)\s*[:：]?/,""));
    const topic=clean(String(b||"").replace(/^(?:课题|主题|演讲题目|报告题目|讲题)\s*[:：]?/,""));
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
module.exports={enabled,recognize,parseAgenda,parseAgendaRows,extractNames,extractTopics,cleanText,MAX_PAGES,
  providerMatches,rapidItemsToText};
