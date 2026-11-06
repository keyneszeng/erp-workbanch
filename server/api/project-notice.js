"use strict";
const { getProject }=require("../lib/workflow");
const { assertProjectVisible }=require("../lib/rbac");
const { logAudit }=require("../lib/audit");
const { now, forbidden, conflict, notFound }=require("../lib/util");
const { storage, safeName }=require("../lib/storage");
const notices=require("../lib/project-notice");

function scoped(ctx) {
  const project=getProject(ctx.params.id);
  assertProjectVisible(ctx.user,project);
  if(ctx.user.role==="user")throw forbidden("普通参与者不能访问内部立项函或项目通知函");
  return project;
}
function manager(ctx,project) {
  if(!notices.canManage(ctx.user,project.assoc))
    throw forbidden("此操作仅限所属协会管理员或总管理员");
}
function file(buffer,name) {
  return {__file:{
    buffer,mime:notices.DOCX_MIME,name:safeName(name),
    download:true,cache:"no-store"
  }};
}
function register(router) {
  router.get("/api/projects/:id/initiation-letter",async ctx=>{
    const p=scoped(ctx);
    const view=notices.overview(p);
    return {...view,canEdit:notices.canManage(ctx.user,p.assoc)&&["草稿","待审批"].includes(p.status)};
  });

  router.patch("/api/projects/:id/initiation-letter",async ctx=>{
    const p=scoped(ctx);manager(ctx,p);
    const letter=notices.updateLetter(p,ctx.user,ctx.body);
    logAudit({user:ctx.user,module:"立项管理",action:"编辑立项函",target:p.id,
      detail:"立项函正文及标题更新（"+letter.body.length+"字），审批前可修改",ip:ctx.ip});
    return {letter,message:"立项函已保存，审批通过后自动锁定"};
  });

  // 以项目的协会为作用域，模板版本影响该协会后续批准的所有会议。
  router.post("/api/projects/:id/notice-template",async ctx=>{
    const p=scoped(ctx);manager(ctx,p);
    const t=await notices.registerTemplate(p,ctx.user,ctx.body?.file_key,ctx.body?.file_name);
    logAudit({user:ctx.user,module:"系统配置",action:"设置项目通知函 Word 模板",target:p.id,
      detail:p.assoc+" / v"+t.version+" / "+t.file_name,ip:ctx.ip});
    return {template:{name:t.file_name,version:t.version,updatedAt:t.updated_at},
      message:"已保存本协会 Word 通知函模板（v"+t.version+"）"};
  });

  router.get("/api/projects/:id/notice-template.docx",async ctx=>{
    const p=scoped(ctx);manager(ctx,p);
    const t=notices.templateFor(p.assoc);
    if(!t)throw notFound("当前协会尚未上传自定义 Word 模板");
    const obj=await storage().get(t.file_key);
    if(!obj)throw notFound("原始 Word 模板文件不存在");
    return file(obj.buffer,t.file_name);
  });

  router.get("/api/projects/:id/notice/preview.docx",async ctx=>{
    const p=scoped(ctx);manager(ctx,p);
    const out=await notices.renderNotice(p,{preview:true});
    return file(out,p.id+"-项目通知函-预览待盖章.docx");
  });

  // 提供给具备项目内部查看权限的执行人下载打印盖章；不等于已经完成线下盖章。
  router.get("/api/projects/:id/notice.docx",async ctx=>{
    const p=scoped(ctx);
    const out=await notices.renderNotice(p);
    logAudit({user:ctx.user,module:"立项管理",action:"下载项目通知函 Word",target:p.id,
      detail:"下载待盖章 Word；正式盖章仍需线下办理",ip:ctx.ip});
    return file(out,p.id+"-项目通知函-待盖章.docx");
  });

  // 旧库中已审批项目没有审批时快照，明确按「历史补发」处理，不能冒充历史原文。
  router.post("/api/projects/:id/notice/backfill",async ctx=>{
    const p=scoped(ctx);manager(ctx,p);
    if(notices.noticeFor(p.id))throw conflict("该项目已存在已锁定的通知函，禁止重复生成", "NOTICE_ALREADY_ISSUED");
    notices.freeze(p,ctx.user,null,{backfilled:true,approvedAt:now()});
    logAudit({user:ctx.user,module:"立项管理",action:"历史项目通知函补发",target:p.id,
      detail:"依据当前项目资料补发；非原审批时点快照",ip:ctx.ip});
    return {notice:notices.overview(p).projectNotice,message:"历史项目通知函已补发（标注为历史补发版）"};
  });
}
module.exports={register};
