"use strict";
const { db } = require("../lib/db");
const { now, bad, notFound, conflict } = require("../lib/util");
const { getProject, assertNotFrozen } = require("../lib/workflow");
const { assertProjectVisible, assertCan, assertModule } = require("../lib/rbac");
const { MATERIAL_MODULE_KINDS } = require("../lib/constants");
const { logAudit } = require("../lib/audit");
const { storage } = require("../lib/storage");
const { isDemoMode } = require("../lib/runtime");
const ocr = require("../lib/ocr-engine");
let ocrRunning = false;
const OCR_TYPES = new Set(["jpg","png","pdf"]);
function checkOcrMaterial(pid,id) {
  const material=db.prepare("SELECT * FROM materials WHERE id=? AND pid=? AND deleted_at IS NULL")
    .get(Number(id),pid);
  if(!material || !material.file_key)throw notFound("请选择当前会议下已上传原件的材料");
  if(!OCR_TYPES.has(material.file_key.split(".").pop()))
    throw bad("OCR 当前支持 JPG、PNG、PDF；Office 文档请先导出 PDF");
  return material;
}
function resultFor(materialId,pid,fileKey) {
  const r=db.prepare("SELECT * FROM material_ocr_results WHERE material_id=? AND pid=? AND file_key=?")
    .get(materialId,pid,fileKey);
  return r ? {materialId,recognizedText:r.recognized_text,suggestions:JSON.parse(r.suggestions_json),
    mode:r.mode,engine:r.engine,pages:r.pages,totalPages:r.total_pages,truncated:!!r.truncated,
    updatedAt:r.updated_at,updatedBy:r.updated_by,reviewRequired:true} : null;
}


const allowedStates = ["未提交","已提交","比对通过","不一致","待补件","复核通过"];
const normalize = v=>String(v ?? "").trim().replace(/\s+/g,"").toLowerCase();
function moduleRows(pid) {
  const rows=db.prepare("SELECT kind,enabled,updated_at,updated_by FROM meeting_material_modules WHERE pid=?").all(pid);
  return MATERIAL_MODULE_KINDS.map(kind=>rows.find(r=>r.kind===kind)||{kind,enabled:1});
}
function taskRows(pid) {
  return db.prepare("SELECT t.*,m.name AS material_name,m.file_key FROM meeting_material_tasks t LEFT JOIN materials m ON m.id=t.material_id AND m.deleted_at IS NULL WHERE t.pid=? ORDER BY t.id DESC").all(pid);
}
function assertWritable(ctx,p){
  assertProjectVisible(ctx.user,p);
  assertCan(ctx.user,"material:write","无材料管理权限");
  assertNotFrozen(p,"材料模块与待办");
}
function register(router) {
  router.get("/api/projects/:id/material-workbench",async ctx=>{
    assertModule(ctx.user,"materials","material:write");
    const p=getProject(ctx.params.id);assertProjectVisible(ctx.user,p);
    return {pid:p.id,modules:moduleRows(p.id),tasks:taskRows(p.id),
      ocrAvailable:ocr.enabled() && !isDemoMode() && storage().name==="fs",
      note:"上传的中文/英文图片与 PDF 可由本地 OCR 识别；建议项须人工确认后才生成待办"};
  });

  // OCR 只在 ECS 的真实文件存储后端上执行，Cloudflare 演示保持手动录入能力。
  router.get("/api/projects/:id/material-workbench/ocr/:materialId",async ctx=>{
    const p=getProject(ctx.params.id);assertProjectVisible(ctx.user,p);
    assertModule(ctx.user,"materials","material:write");
    const material=checkOcrMaterial(p.id,ctx.params.materialId);
    return {result:resultFor(material.id,p.id,material.file_key),ocrAvailable:ocr.enabled() && !isDemoMode() && storage().name==="fs"};
  });
  router.post("/api/projects/:id/material-workbench/ocr",async ctx=>{
    const p=getProject(ctx.params.id);assertWritable(ctx,p);
    if(isDemoMode() || !ocr.enabled() || storage().name!=="fs")
      throw Object.assign(new Error("OCR 当前仅可在已配置本地识别引擎的阿里云 ECS 环境运行"),{status:503,code:"OCR_NOT_CONFIGURED"});
    const material=checkOcrMaterial(p.id,ctx.body?.materialId);
    const existing=resultFor(material.id,p.id,material.file_key);
    if(existing && ctx.body?.force!==true)return {result:existing,fromCache:true};
    if(ocrRunning)throw Object.assign(new Error("OCR 正在处理另一个文件，请稍后重试"),{status:429,code:"OCR_BUSY"});
    ocrRunning=true;
    try{
      const file=await storage().get(material.file_key);
      if(!file)throw notFound("原件已不存在，请重新上传");
      const ext=material.file_key.split(".").pop();
      const processed=await ocr.recognize(file.buffer,ext);
      const suggestions=["议程","终版议程"].includes(material.kind) ? ocr.parseAgenda(processed.text) : [];
      const stamp=now();
      db.prepare("INSERT INTO material_ocr_results (material_id,pid,file_key,recognized_text,suggestions_json,engine,mode,pages,total_pages,truncated,updated_at,updated_by) VALUES (?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(material_id) DO UPDATE SET file_key=excluded.file_key,recognized_text=excluded.recognized_text,suggestions_json=excluded.suggestions_json,engine=excluded.engine,mode=excluded.mode,pages=excluded.pages,total_pages=excluded.total_pages,truncated=excluded.truncated,updated_at=excluded.updated_at,updated_by=excluded.updated_by")
        .run(material.id,p.id,material.file_key,processed.text,JSON.stringify(suggestions),processed.engine,
          processed.mode,processed.pages,processed.totalPages,processed.truncated?1:0,stamp,ctx.user.name);
      // 审计仅记录材料 ID、引擎与页数；不泄露文件 OCR 的人名、个人信息及正文。
      logAudit({user:ctx.user,module:"材料中心",action:"本地 OCR 识别",target:p.id,
        detail:"材料 "+material.id+"；"+processed.engine+"；"+processed.pages+" 页；建议 "+suggestions.length+" 条",ip:ctx.ip});
      return {result:resultFor(material.id,p.id,material.file_key),fromCache:false};
    }finally{ocrRunning=false;}
  });
  router.post("/api/projects/:id/material-workbench/modules",async ctx=>{
    const p=getProject(ctx.params.id);assertWritable(ctx,p);
    const {kind,enabled}=ctx.body||{};
    if(!MATERIAL_MODULE_KINDS.includes(kind)||typeof enabled!=="boolean")throw bad("模块名称或开关不合法");
    db.prepare("INSERT INTO meeting_material_modules (pid,kind,enabled,updated_at,updated_by) VALUES (?,?,?,?,?) ON CONFLICT(pid,kind) DO UPDATE SET enabled=excluded.enabled,updated_at=excluded.updated_at,updated_by=excluded.updated_by")
      .run(p.id,kind,enabled?1:0,now(),ctx.user.name);
    logAudit({user:ctx.user,module:"材料中心",action:"固定模块启停",target:p.id,detail:kind+" "+(enabled?"启用":"停用")+"；历史材料与待办均保留",ip:ctx.ip});
    return {modules:moduleRows(p.id)};
  });
  // 先上传终版议程原件，再提供人工提取的讲者/课题列表；只生成待办，不伪称 OCR。
  router.post("/api/projects/:id/material-workbench/agenda",async ctx=>{
    const p=getProject(ctx.params.id);assertWritable(ctx,p);
    const {materialId,entries}=ctx.body||{};
    const material=db.prepare("SELECT * FROM materials WHERE id=? AND pid=? AND deleted_at IS NULL").get(Number(materialId),p.id);
    if(!material || !["议程","终版议程"].includes(material.kind) || !material.file_key ||
       !(material.kind==="终版议程" || /终版|final/i.test(material.version||"")))
      throw conflict("请先上传有文件原件且标记为终版的议程材料","FINAL_AGENDA_REQUIRED");
    if(!Array.isArray(entries)||!entries.length||entries.length>100)throw bad("终版议程须包含 1~100 条讲者与课题记录");
    const unique=new Set();
    for(const e of entries){
      if(!e||typeof e.speaker!=="string"||typeof e.topic!=="string"||!e.speaker.trim()||!e.topic.trim()||e.speaker.length>80||e.topic.length>160)
        throw bad("讲者或课题为空/超长");
      const key=normalize(e.speaker)+"@"+normalize(e.topic);
      if(unique.has(key))throw bad("终版议程有重复的讲者/课题");unique.add(key);
    }
    const stamp=now();
    const insert=db.prepare("INSERT OR IGNORE INTO meeting_material_tasks (pid,kind,speaker,topic,status,updated_at,updated_by) VALUES (?,?,?,?,'未提交',?,?)");
    for(const e of entries)for(const kind of ["课件","串场"])insert.run(p.id,kind,e.speaker.trim(),e.topic.trim(),stamp,ctx.user.name);
    logAudit({user:ctx.user,module:"材料中心",action:"生成议程待办",target:p.id,detail:"终版议程 "+material.id+"；"+entries.length+" 讲者课题；旧待办保留",ip:ctx.ip});
    return {tasks:taskRows(p.id),generated:entries.length*2,note:"依结构化条目生成待办，非图像自动识别"};
  });
  router.post("/api/projects/:id/material-workbench/tasks/:taskId/compare",async ctx=>{
    const p=getProject(ctx.params.id);assertWritable(ctx,p);
    const task=db.prepare("SELECT * FROM meeting_material_tasks WHERE id=? AND pid=?").get(Number(ctx.params.taskId),p.id);
    if(!task)throw notFound("待办不存在");
    const isEnabled=moduleRows(p.id).find(m=>m.kind===task.kind)?.enabled!==0;
    if(!isEnabled)throw conflict("模块已停用，不能继续核验","MODULE_DISABLED");
    const m=db.prepare("SELECT * FROM materials WHERE id=? AND pid=? AND kind=? AND deleted_at IS NULL")
      .get(Number(ctx.body?.materialId),p.id,task.kind);
    if(!m||!m.file_key)throw bad("请选择同项目、相同类别且已上传原件的材料");
    // 生产内容比对优先看 OCR 实际原文；文件名不能作为"材料内容已一致"的证明。
    // 演示环境保持旧版文件名比对体验；未完成 OCR 的生产材料进入人工复核。
    const ocrRow=db.prepare("SELECT recognized_text FROM material_ocr_results WHERE material_id=? AND pid=? AND file_key=?")
      .get(m.id,p.id,m.file_key);
    const basis=ocrRow?.recognized_text || (isDemoMode()?m.name:"");
    const method=ocrRow?"ocr-text":(isDemoMode()?"demo-filename":"manual-required");
    const match=!!basis && normalize(basis).includes(normalize(task.speaker)) &&
      normalize(basis).includes(normalize(task.topic));
    const status=match?"比对通过":"不一致";
    db.prepare("UPDATE meeting_material_tasks SET status=?,material_id=?,updated_at=?,updated_by=? WHERE id=?")
      .run(status,m.id,now(),ctx.user.name,task.id);
    logAudit({user:ctx.user,module:"材料中心",action:"待办字符串比对",target:p.id,detail:"待办 "+task.id+" "+status+"；依据："+method,ip:ctx.ip});
    return {status,method,task:taskRows(p.id).find(t=>t.id===task.id)};
  });
  router.post("/api/projects/:id/material-workbench/tasks/:taskId/review",async ctx=>{
    const p=getProject(ctx.params.id);assertWritable(ctx,p);
    const task=db.prepare("SELECT * FROM meeting_material_tasks WHERE id=? AND pid=?").get(Number(ctx.params.taskId),p.id);
    if(!task)throw notFound("待办不存在");
    if(task.status!=="不一致" && task.status!=="待补件")throw conflict("只有不一致或待补件待办可人工复核");
    if(moduleRows(p.id).find(m=>m.kind===task.kind)?.enabled===0)
      throw conflict("材料模块已停用，不能借人工复核绕过停用门禁","MODULE_DISABLED");
    const evidence=db.prepare("SELECT id FROM materials WHERE id=? AND pid=? AND kind=? AND file_key IS NOT NULL AND deleted_at IS NULL")
      .get(task.material_id,p.id,task.kind);
    if(!evidence)throw conflict("关联材料原件已缺失或已删除，请重新上传并比对","MATERIAL_EVIDENCE_REQUIRED");
    const reason=String(ctx.body?.reason||"").trim();
    const approved=ctx.body?.approved;
    if(typeof approved!=="boolean"||reason.length<4||reason.length>300)throw bad("复核必须写明理由（4~300字）与结论");
    db.prepare("UPDATE meeting_material_tasks SET status=?,updated_at=?,updated_by=? WHERE id=?")
      .run(approved?"复核通过":"待补件",now(),ctx.user.name,task.id);
    logAudit({user:ctx.user,module:"材料中心",action:"人工复核",target:p.id,detail:"待办 "+task.id+(approved?" 已通过":" 待补件")+"："+reason,ip:ctx.ip});
    return {task:taskRows(p.id).find(t=>t.id===task.id)};
  });
}
module.exports={register};
