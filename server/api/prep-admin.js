"use strict";
const { assertCan }=require("../lib/rbac");
const { logAudit }=require("../lib/audit");
const { bad }=require("../lib/util");
const { read,editDraft,publish,rollback,validateConfig }=require("../lib/prep-config");
const { getProject }=require("../lib/workflow");
const { renderInvitation,invitationPdf }=require("../lib/prep-invitation");
const { getDeliveryEnv,mailDelivery }=require("./prep-invitations");
const {saveKey,removeKey,stored}=require("../lib/prep-mail-credentials");

function admin(ctx){assertCan(ctx.user,"setting:write","只有总管理员可以配置邀请函模板与上线渠道");}
function readiness(cfg){
  const env=getDeliveryEnv();
  let providerKeyReady=false;
  let issue="";
  try {providerKeyReady=!!mailDelivery().apiKey;}catch(e){issue=e.message;}
  const publicUrlReady=/^https:\/\//.test(String(cfg.public_base_url||""));
  const mail=providerKeyReady && !!cfg.mail_from && publicUrlReady;
  const wechat=!!(cfg.mini_appid && cfg.mini_program_verified);
  return {mail_service_ready:mail,public_url_ready:publicUrlReady,
    mail_credential_stored:stored(),
    mail_encryption_ready:!!(env.ERP_MAIL_CONFIG_KEY && String(env.ERP_MAIL_CONFIG_KEY).length>=32),
    mail_key_readable:providerKeyReady,mail_issue:issue,
    wechat_config_ready:wechat,
    note:"邮件 API 密钥只加密保存在服务端，前端不可读取；微信审核状态由总管理员手工确认，不代表已实时查询微信平台。"};
}
function expose(state){
  return {version:state.version,live:state.live,draft:state.draft,
    history:state.history.map(h=>({version:h.version,at:h.at,by:h.by})),
    readiness:readiness(state.draft||state.live)};
}
function checkReady(config){
  const ready=readiness(config);
  if(config.email_enabled&&!ready.mail_service_ready)
    throw bad("邮件服务尚未配置完成，请先在服务端设置密钥、发件地址与 HTTPS 公开地址");
  if(config.wechat_enabled&&!ready.wechat_config_ready)
    throw bad("微信渠道需设置正式 AppID 并人工确认小程序已审核发布");
}
function register(router){
  router.post("/api/admin/invitation-config/email-credentials",async ctx=>{
    admin(ctx);
    const data=ctx.body||{};
    saveKey(data.resend_api_key,getDeliveryEnv());
    logAudit({user:ctx.user,module:"系统配置",action:"配置加密邮件发件凭证",target:"invitation-config",
      detail:"更新邮件凭证（已加密，日志不记录密钥）",ip:ctx.ip});
    return {configured:true,readiness:readiness(read().draft||read().live)};
  });
  router.delete("/api/admin/invitation-config/email-credentials",async ctx=>{
    admin(ctx);
    removeKey();
    logAudit({user:ctx.user,module:"系统配置",action:"撤销邮件发件凭证",target:"invitation-config",
      detail:"已清除加密凭证（不影响 Worker 环境变量中的独立配置）",ip:ctx.ip});
    return {configured:false,readiness:readiness(read().draft||read().live)};
  });
  router.get("/api/admin/invitation-config",async ctx=>{
    admin(ctx);return expose(read());
  });
  router.patch("/api/admin/invitation-config",async ctx=>{
    admin(ctx);
    const b=ctx.body||{};
    if(!Number.isInteger(b.expected_version)||!b.config)throw bad("缺少配置内容或版本号");
    const state=editDraft(b.config,b.expected_version);
    logAudit({user:ctx.user,module:"系统配置",action:"保存邀请函上线草稿",target:"invitation-config",
      detail:"当前已发布版本="+state.version,ip:ctx.ip});
    return expose(state);
  });
  router.post("/api/admin/invitation-config/publish",async ctx=>{
    admin(ctx);
    const b=ctx.body||{};
    if(!Number.isInteger(b.expected_version))throw bad("需要版本号");
    const state=read();
    if(!state.draft)throw bad("请先保存草稿");
    checkReady(state.draft);
    const done=publish(b.expected_version,ctx.user.name);
    logAudit({user:ctx.user,module:"系统配置",action:"发布邀请函上线配置",target:"invitation-config",
      detail:"发布版本="+done.version+"，邮件="+done.live.email_enabled+"，微信="+done.live.wechat_enabled,ip:ctx.ip});
    return expose(done);
  });
  router.post("/api/admin/invitation-config/rollback",async ctx=>{
    admin(ctx);
    const b=ctx.body||{};
    if(!Number.isInteger(b.target_version)||!Number.isInteger(b.expected_version))throw bad("需要回退版本号及当前版本号");
    const current=read();
    if(current.version!==b.expected_version)throw bad("配置版本已变化，请刷新");
    const target=current.history.find(x=>x.version===b.target_version);
    if(!target)throw bad("回退版本不存在");
    checkReady(validateConfig(target.config));
    const done=rollback(b.target_version,ctx.user.name);
    logAudit({user:ctx.user,module:"系统配置",action:"回退邀请函上线配置",target:"invitation-config",
      detail:"来源版本="+b.target_version+"，新版本="+done.version,ip:ctx.ip});
    return expose(done);
  });
  router.get("/api/admin/invitation-config/preview",async ctx=>{
    admin(ctx);
    const state=read(), cfg=state.draft||state.live;
    const type=String(ctx.query.type||"guest"), pid=String(ctx.query.pid||"");
    if(!pid)throw bad("预览需要选择会议项目");
    const p=getProject(pid);
    const recipient=type==="enterprise"?{recipient_org:"示例合作企业",recipient_title:"负责人"}:
      {recipient_name:"示例嘉宾",recipient_title:"教授",guest_role:"主讲嘉宾",topic:"会议交流"};
    const snapshot=renderInvitation(type,p,recipient,undefined,cfg);
    return {__file:{buffer:invitationPdf(snapshot),mime:"application/pdf",
      name:"邀请函模板预览.pdf",cache:"no-store",download:true}};
  });
}
module.exports={register};
