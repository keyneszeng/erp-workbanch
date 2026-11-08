"use strict";
/**
 * 立项函与项目通知函：按协会维护 Word 模板，审批时冻结函件与模板版本。
 *
 * Word 始终是「待盖章」原件；系统既不伪造电子签章，也不把下载视为已盖章。
 * 云端演示和 ECS 共用模型，但每份正式函件必须关联审批快照。
 */
const { db } = require("./db");
const { now, bad, conflict, notFound, forbidden } = require("./util");
const { storage, sniffMime } = require("./storage");
const { isSuper,can } = require("./rbac");
const { listForUser } = require("./user-associations");

const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const TEMPLATE_KEY = /^[a-f0-9]{32}\.docx$/;
const APPROVED = new Set(["已立项", "筹备中", "执行中", "待核销", "已核销", "已结算", "已归档"]);
const VARS = Object.freeze([
  "通知函标题", "立项函标题", "立项函正文", "会议名称", "项目编号", "协会名称",
  "会议日期", "会期", "会议形式", "预计参会人数", "预算金额", "项目负责人",
  "承办部门", "初版议程", "审批人", "审批日期", "发文日期", "联系电话", "发文说明"
]);

function canManage(user, assoc) {
  return isSuper(user) || (can(user,"project:approve") && listForUser(user.id,user.assoc).includes(assoc));
}

function letterFor(project) {
  const row = db.prepare("SELECT title,body,updated_at,updated_by FROM project_initiation_letters WHERE pid=?")
    .get(project.id);
  if (row) return row;
  return {
    title: "关于举办《" + project.name + "》的立项申请",
    body: [
      "拟举办会议：" + project.name,
      "主办协会：" + project.assoc,
      "会议时间：" + project.date + "（" + project.days + "天），形式：" + project.form,
      "预计参会：" + (project.people || 0) + "人，预算：" + Number(project.budget).toFixed(2) + "元",
      "项目负责人：" + (project.owner || "待确定"),
      "初版议程：" + (project.agenda || "待完善"),
      "现申请批准该会议项目立项，并按审批意见组织后续筹备工作。"
    ].join("\n"),
    updated_at: null,
    updated_by: null
  };
}

function templateFor(assoc) {
  return db.prepare(
    "SELECT assoc,file_key,file_name,version,updated_by,updated_at FROM project_notice_templates WHERE assoc=?"
  ).get(assoc) || null;
}

function noticeFor(pid) {
  return db.prepare(
    "SELECT pid,approval_id,template_key,template_version,template_name,snapshot_json,approved_by,approved_at,backfilled,created_at FROM project_notices WHERE pid=?"
  ).get(pid) || null;
}

function overview(project) {
  const t = templateFor(project.assoc);
  const n = noticeFor(project.id);
  const frozen=n ? JSON.parse(n.snapshot_json) : null;
  return {
    // 页面也展示当时批准的正文；否则旧的默认函会随项目修改而静默漂移。
    initiationLetter: frozen ? {
      title:frozen["立项函标题"],body:frozen["立项函正文"],
      updated_at:n.approved_at,updated_by:n.approved_by,locked:true
    } : letterFor(project),
    noticeTemplate: t ? {name:t.file_name,version:t.version,updatedAt:t.updated_at} :
      {name:"系统内置 Word 模板",version:0,updatedAt:null},
    projectNotice: n ? {
      ready:true, approvedAt:n.approved_at, approvedBy:n.approved_by,
      templateName:n.template_name, templateVersion:n.template_version, backfilled:!!n.backfilled
    } : {ready:false, historical:APPROVED.has(project.status)}
  };
}

function updateLetter(project, user, input) {
  if (!canManage(user, project.assoc)) throw forbidden("只有所属协会管理员或总管理员可修改立项函");
  if (!["草稿", "待审批"].includes(project.status)) {
    throw conflict("立项审批通过后函件正文已冻结，如需改动须走项目变更流程", "INITIATION_LETTER_LOCKED");
  }
  if (!input || typeof input.title !== "string" || typeof input.body !== "string") {
    throw bad("请填写立项函标题和正文");
  }
  const title=input.title.trim(), body=input.body.trim();
  if (!title || title.length>120 || /[\r\n]/.test(title)) throw bad("立项函标题须为 1～120 字，且不能换行");
  if (!body || body.length>10000) throw bad("立项函正文须为 1～10000 字");
  const at=now();
  db.prepare(
    "INSERT INTO project_initiation_letters(pid,title,body,updated_by,updated_at) VALUES (?,?,?,?,?) " +
    "ON CONFLICT(pid) DO UPDATE SET title=excluded.title,body=excluded.body,updated_by=excluded.updated_by,updated_at=excluded.updated_at"
  ).run(project.id,title,body,user.id,at);
  return letterFor(project);
}

function snapshotFields(project, letter, user, approvedAt, backfilled) {
  const day=String(approvedAt || now()).slice(0,10);
  const budget=Number(project.budget||0).toLocaleString("zh-CN",{minimumFractionDigits:2,maximumFractionDigits:2});
  return {
    "通知函标题":"关于" + project.name + "项目立项的通知",
    "立项函标题":letter.title,
    "立项函正文":letter.body,
    "会议名称":project.name,
    "项目编号":project.id,
    "协会名称":project.assoc,
    "会议日期":project.date,
    "会期":String(project.days) + "天",
    "会议形式":project.form,
    "预计参会人数":String(project.people||0) + "人",
    "预算金额":budget + "元",
    "项目负责人":project.owner||"",
    "承办部门":project.dept||"",
    "初版议程":project.agenda||"",
    "审批人":user?.name||"",
    "审批日期":day,
    "发文日期":day,
    "联系电话":project.phone||"",
    "发文说明":backfilled ? "历史项目补发：依据当前保存的项目资料生成，非原审批日原始快照。" :
      "本函系立项审批通过后生成的待盖章 Word 文件，正式对外发文前请办理盖章。"
  };
}

function freeze(project, user, approvalId, {backfilled=false, approvedAt}={}) {
  if (!backfilled && project.status !== "待审批") throw conflict("只有待审批的项目可生成正式立项快照", "NOTICE_NOT_APPROVED");
  if (backfilled && !APPROVED.has(project.status)) throw conflict("项目尚未通过立项，不允许补发通知函", "NOTICE_NOT_APPROVED");
  if (noticeFor(project.id)) return false; // 幂等：不因重复请求覆盖已审批的文件
  const template=templateFor(project.assoc);
  const at=now(), source=approvedAt||at;
  const fields=snapshotFields(project,letterFor(project),user,source,backfilled);
  db.prepare(
    "INSERT INTO project_notices(pid,approval_id,template_key,template_version,template_name,snapshot_json,approved_by,approved_at,backfilled,created_at) " +
    "VALUES (?,?,?,?,?,?,?,?,?,?)"
  ).run(project.id,approvalId||null,template?.file_key||null,template?.version||0,
    template?.file_name||"系统内置 Word 模板",JSON.stringify(fields),user.name,String(source),backfilled?1:0,at);
  return true;
}

function docParagraph(text, {bold=false,center=false,size=24}={}) {
  const xmlText=String(text).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
  const justify=center?' <w:jc w:val="center"/>':"";
  return '<w:p><w:pPr>'+justify+'</w:pPr><w:r><w:rPr>'+(bold?"<w:b/>":"")+
    '<w:sz w:val="'+size+'"/></w:rPr><w:t xml:space="preserve">'+xmlText+'</w:t></w:r></w:p>';
}

function defaultWordTemplate() {
  const PizZip=require("pizzip");
  const zip=new PizZip();
  zip.file("[Content_Types].xml", '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'+
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'+
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'+
    '<Default Extension="xml" ContentType="application/xml"/>'+
    '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
  zip.file("_rels/.rels", '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'+
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'+
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
  zip.file("word/document.xml", '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'+
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>'+
    docParagraph("{{通知函标题}}",{bold:true,center:true,size:34})+
    docParagraph("会议名称：{{会议名称}}")+
    docParagraph("项目编号：{{项目编号}}")+
    docParagraph("致：{{协会名称}}")+
    docParagraph("立项依据：{{立项函标题}}")+
    docParagraph("根据项目立项审批结果，现通知如下：")+
    docParagraph("{{立项函正文}}")+
    docParagraph("会议日期：{{会议日期}}  项目负责人：{{项目负责人}}")+
    docParagraph("审批人：{{审批人}}  审批日期：{{审批日期}}")+
    docParagraph("{{发文说明}}")+
    docParagraph(" ") + docParagraph("（盖章处）",{center:true})+
    docParagraph("发文日期：{{发文日期}}")+
    '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr>'+
    '</w:body></w:document>');
  return zip.generate({type:"nodebuffer",compression:"DEFLATE"});
}

function compileDocx(buffer) {
  const PizZip=require("pizzip"), Docxtemplater=require("docxtemplater");
  let doc;
  try {
    doc=new Docxtemplater(new PizZip(buffer),{
      delimiters:{start:"{{",end:"}}"},linebreaks:true,paragraphLoop:false,
      nullGetter(){return "";}
    });
  } catch (err) {
    const detail=err?.properties?.errors?.[0]?.properties?.explanation ||
      err?.properties?.explanation || err?.message || "未知错误";
    throw bad("Word 模板无法解析：" + String(detail).slice(0,160));
  }
  return doc;
}

function validateTemplate(buffer) {
  if (!Buffer.isBuffer(buffer)||buffer.length===0||buffer.length>20*1024*1024||sniffMime(buffer)!==DOCX_MIME)
    throw bad("通知函模板必须是 20MB 以内、无宏且未损坏的 DOCX");
  const doc=compileDocx(buffer);
  const text=doc.getFullText();
  for (const tag of ["会议名称","立项函正文"]) {
    if (!text.includes("{{"+tag+"}}")) throw bad("Word 模板必须包含 {{"+tag+"}} 占位符");
  }
  // 不允许模板扩展到未知字段、表达式或引用其他数据。
  for(const match of text.matchAll(/\{\{([^{}]*)\}\}/g)) {
    if(!VARS.includes(match[1].trim()))throw bad("模板含未知占位符："+match[1]);
  }
}

async function registerTemplate(project,user,fileKey,fileName) {
  if(!canManage(user,project.assoc))throw forbidden("只有所属协会管理员或总管理员可设置通知函模板");
  const key=String(fileKey||"");
  if(!TEMPLATE_KEY.test(key))throw bad("仅支持 DOCX Word 模板");
  const uploaded=db.prepare("SELECT user_id,pid FROM uploaded_files WHERE file_key=?").get(key);
  if(!uploaded)throw bad("请通过本系统先上传 Word 模板");
  if(!isSuper(user)&&Number(uploaded.user_id)!==Number(user.id))throw forbidden("仅能设置本人上传的模板");
  if(uploaded.pid&&uploaded.pid!==project.id)throw forbidden("附件所属项目不符");
  const bound=db.prepare("SELECT assoc FROM project_notice_templates WHERE file_key=? AND assoc<>?").get(key,project.assoc);
  if(bound)throw conflict("该模板文件已被其他协会使用，请重新上传", "NOTICE_TEMPLATE_BOUND");
  const already=db.prepare("SELECT 1 FROM materials WHERE file_key=? UNION SELECT 1 FROM contracts WHERE file_key=?").get(key,key);
  if(already)throw conflict("该文件已作为业务单据使用，请单独上传 Word 模板", "FILE_ALREADY_LINKED");
  const obj=await storage().get(key);
  if(!obj)throw notFound("模板附件未找到");
  validateTemplate(obj.buffer);
  const old=templateFor(project.assoc);
  if(old?.file_key===key) return old;
  const version=(old?.version||0)+1;
  const name=String(fileName||"项目通知函模板.docx").replace(/[\/\\\r\n]/g,"").slice(0,120);
  db.prepare(
    "INSERT INTO project_notice_templates(assoc,file_key,file_name,version,updated_by,updated_at) VALUES (?,?,?,?,?,?) "+
    "ON CONFLICT(assoc) DO UPDATE SET file_key=excluded.file_key,file_name=excluded.file_name,version=excluded.version,updated_by=excluded.updated_by,updated_at=excluded.updated_at"
  ).run(project.assoc,key,name,version,user.id,now());
  return templateFor(project.assoc);
}

async function renderNotice(project,{preview=false}={}) {
  const n=preview ? null : noticeFor(project.id);
  if(!preview&&!n)throw conflict("立项未通过或历史项目尚未补发通知函", "NOTICE_NOT_READY");
  const t=preview?templateFor(project.assoc):null;
  const fields=n ? JSON.parse(n.snapshot_json) :
    snapshotFields(project,letterFor(project),{name:"（待审批）"},now(),false);
  const templateKey=n?n.template_key:t?.file_key;
  let template=defaultWordTemplate();
  if(templateKey) {
    const obj=await storage().get(templateKey);
    if(!obj)throw conflict("审批时锁定的 Word 模板原件已丢失，请联系管理员恢复备份","NOTICE_TEMPLATE_MISSING");
    template=obj.buffer;
  }
  const doc=compileDocx(template);
  try { doc.render(fields); }
  catch { throw bad("Word 模板渲染失败，请检查模板占位符及其格式"); }
  return doc.getZip().generate({type:"nodebuffer",compression:"DEFLATE"});
}

module.exports={
  DOCX_MIME,VARS,APPROVED,canManage,letterFor,templateFor,noticeFor,overview,
  updateLetter,freeze,defaultWordTemplate,validateTemplate,registerTemplate,renderNotice
};
