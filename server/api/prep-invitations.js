"use strict";
/**
 * 会议信息 → 筹备固定模板 → 受邀方个性化 PDF → 邮件/小程序分享 → 回复归档。
 *
 * 注意：微信 API 不能代替用户发送分享卡片；wechat-share 接口只签发一次性
 * 分享路径，前端需调用小程序分享行为，不能把“生成分享路径”写成“已送达”。
 */
const crypto = require("node:crypto");
const { db, transaction } = require("../lib/db");
const { getProject, assertNotFrozen } = require("../lib/workflow");
const { assertProjectVisible, assertCan } = require("../lib/rbac");
const { nowIso, nextId, randToken, bad, conflict, notFound, HttpError } = require("../lib/util");
const { logAudit } = require("../lib/audit");
const { TEMPLATES, projectFields, renderInvitation, invitationPdf, clean } = require("../lib/prep-invitation");

let deliveryEnv = null;
function attachDeliveryEnv(env) { deliveryEnv = env || null; }
function getDeliveryEnv() {
  if (deliveryEnv) return deliveryEnv;
  return typeof process === "object" && process.env ? process.env : {};
}
const prepareStatuses = new Set(["已立项", "筹备中"]);

function requireManager(ctx, id, allowView = false) {
  const p = getProject(id);
  assertProjectVisible(ctx.user, p);
  assertCan(ctx.user, "invite:manage", "嘉宾/企业邀请仅总管理员、协会管理员和授权会务执行人员可操作");
  if (!allowView) {
    assertNotFrozen(p, "邀请函");
    if (!prepareStatuses.has(p.status)) {
      throw conflict("邀请函应在项目立项完成后的筹备阶段生成", "PREPARATION_REQUIRED", { status: p.status });
    }
  }
  return p;
}
function getInvitation(projectId, invitationId) {
  const r = db.prepare("SELECT * FROM prep_invitations WHERE id=? AND pid=?").get(invitationId, projectId);
  if (!r) throw notFound("邀请函不存在或不属于该会议项目");
  return r;
}
function summarize(r) {
  const s = JSON.parse(r.snapshot_json);
  return { id:r.id, pid:r.pid, type:r.type, template_name:s.template_name,
    template_version:r.template_version, subject:s.subject,
    recipient_name:s.fields["受邀姓名"] || "", recipient_org:s.fields["受邀单位"] || "",
    recipient_title:s.fields["称谓"] || "", recipient_email:r.recipient_email || "",
    status:r.status, channel:r.channel, created_at:r.created_at,
    sent_at:r.sent_at, responded_at:r.responded_at, response:r.response || "" };
}
function fingerprint(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}
function inviteByToken(token) {
  if (!/^[a-f0-9]{48,64}$/.test(String(token||""))) throw notFound("邀请链接无效");
  const row=db.prepare("SELECT * FROM prep_invitations WHERE token_hash=?").get(fingerprint(token));
  if (!row) throw notFound("邀请链接无效");
  if (row.status === "已撤销") throw new HttpError(410,"INVITATION_REVOKED","邀请已撤销");
  if (Date.parse(row.expires_at) <= Date.now()) throw new HttpError(410,"INVITATION_EXPIRED","邀请链接已过期");
  return row;
}
function issueToken(id) {
  const token=randToken(24);
  db.prepare("UPDATE prep_invitations SET token_hash=?, expires_at=? WHERE id=?").run(
    fingerprint(token), new Date(Date.now()+30*86400e3).toISOString(), id
  );
  return token;
}
function validEmail(value) {
  const email=clean(value,"收件邮箱",254,true);
  if (!/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(email)) throw bad("邮箱地址格式不正确");
  return email;
}
function subjectFrom(snapshot) {
  return clean(snapshot.subject, "主题", 220, true);
}
function sharePath(token) {
  return "pages/invite/index?token=" + token;
}
async function sendViaResend({to,subject,text,pdf,name}) {
  const env=getDeliveryEnv();
  if (!env.ERP_RESEND_API_KEY || !env.ERP_MAIL_FROM) {
    throw new HttpError(503,"MAIL_NOT_CONFIGURED","邮件服务未配置；请配置 ERP_RESEND_API_KEY 和 ERP_MAIL_FROM");
  }
  const response=await fetch("https://api.resend.com/emails", {
    method:"POST",
    headers:{Authorization:"Bearer "+env.ERP_RESEND_API_KEY,"Content-Type":"application/json"},
    body:JSON.stringify({from:env.ERP_MAIL_FROM,to:[to],subject,text,
      attachments:[{filename:name,content:pdf.toString("base64")}]})
  });
  let body={};
  try { body=await response.json(); } catch { /* provider returned non-JSON */ }
  if (!response.ok || !body.id) {
    throw new HttpError(502,"MAIL_PROVIDER_FAILED","邮件服务未确认发送成功，请核对配置或稍后重试");
  }
  return body.id;
}

function register(router) {
  router.get("/api/projects/:id/prep/templates", async ctx => {
    const p=requireManager(ctx, ctx.params.id);
    return { pid:p.id, stage:"筹备管理", project_fields:projectFields(p),
      templates:Object.values(TEMPLATES).map(t=>({key:t.key,name:t.name,version:t.version,
        prefilled:true, editable_fields:t.key==="guest"?
          ["受邀姓名","称谓/职务","嘉宾角色","交流课题","邮箱"]:
          ["受邀单位","受邀联系人称谓","邮箱"]})) };
  });
  router.get("/api/projects/:id/prep/invitations", async ctx => {
    const p=requireManager(ctx,ctx.params.id,true);
    const rows=db.prepare("SELECT * FROM prep_invitations WHERE pid=? ORDER BY created_at DESC,id DESC").all(p.id);
    return { rows:rows.map(summarize), total:rows.length };
  });
  router.post("/api/projects/:id/prep/invitations", async ctx => {
    const p=requireManager(ctx,ctx.params.id);
    const body=ctx.body||{}, type=String(body.type||"");
    const snapshot=renderInvitation(type,p,body);
    const email=body.recipient_email ? validEmail(body.recipient_email) : "";
    const id=nextId(db,"prep_invitations","id","IV");
    const token=randToken(24), createdAt=nowIso();
    db.prepare(
      "INSERT INTO prep_invitations (id,pid,type,template_version,snapshot_json,recipient_email,token_hash,expires_at,status,created_by,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)"
    ).run(id,p.id,type,snapshot.template_version,JSON.stringify(snapshot),email,
      fingerprint(token),new Date(Date.now()+30*86400e3).toISOString(),"草稿",ctx.user.id,createdAt);
    logAudit({user:ctx.user,module:"筹备管理",action:"生成邀请函草稿",target:p.id,
      detail:id+" / "+snapshot.template_name+" / "+(snapshot.fields["受邀单位"]||snapshot.fields["受邀姓名"]),ip:ctx.ip});
    return { invitation:summarize(getInvitation(p.id,id)),
      pdf_url:"/api/projects/"+p.id+"/prep/invitations/"+id+"/pdf",
      wechat_share_path:sharePath(token), token, delivery_confirmed:false };
  });
  router.get("/api/projects/:id/prep/invitations/:inviteId/pdf", async ctx => {
    requireManager(ctx,ctx.params.id,true);
    const row=getInvitation(ctx.params.id,ctx.params.inviteId);
    const pdf=invitationPdf(JSON.parse(row.snapshot_json));
    return { __file:{buffer:pdf,mime:"application/pdf",name:row.id+"-邀请函.pdf",cache:"no-store",download:true} };
  });
  router.post("/api/projects/:id/prep/invitations/:inviteId/email", async ctx => {
    const p=requireManager(ctx,ctx.params.id);
    const row=getInvitation(p.id,ctx.params.inviteId);
    if (["已确认","已拒绝","已撤销","发送中","已邮件发送","待微信分享"].includes(row.status))
      throw conflict("当前邀请函状态不允许重复邮件发送","INVITATION_STATE_CONFLICT");
    const email=validEmail((ctx.body||{}).recipient_email||row.recipient_email);
    // Check configuration before consuming a new token; failed configuration must not mutate state.
    const env=getDeliveryEnv();
    if (!env.ERP_RESEND_API_KEY || !env.ERP_MAIL_FROM)
      throw new HttpError(503,"MAIL_NOT_CONFIGURED","邮件发送未启用，管理员需要配置邮件服务");
    const base=String(env.ERP_PUBLIC_BASE_URL||"").replace(/\/$/,"");
    if (!/^https:\/\//.test(base)) throw new HttpError(503,"PUBLIC_URL_NOT_CONFIGURED","请配置 HTTPS 公开邀请页域名 ERP_PUBLIC_BASE_URL");
    const snapshot=JSON.parse(row.snapshot_json), token=issueToken(row.id);
    const replyLink=base+"/invite.html?token="+token;
    db.prepare("UPDATE prep_invitations SET status='发送中',recipient_email=? WHERE id=?").run(email,row.id);
    let providerId;
    try {
      providerId=await sendViaResend({to:email,subject:subjectFrom(snapshot),
        text:snapshot.paragraphs.join("\n\n")+(replyLink?"\n\n邀请确认入口："+replyLink:""),
        pdf:invitationPdf(snapshot),name:row.id+"-邀请函.pdf"});
    } catch(e) {
      db.prepare("UPDATE prep_invitations SET status='发送失败' WHERE id=? AND status='发送中'").run(row.id);
      throw e;
    }
    db.prepare("UPDATE prep_invitations SET status='已邮件发送',channel='email',provider_id=?,sent_at=? WHERE id=?")
      .run(providerId,nowIso(),row.id);
    logAudit({user:ctx.user,module:"筹备管理",action:"邮件发送邀请函",target:p.id,
      detail:row.id+" / 邮件服务已受理",ip:ctx.ip});
    return { invitation:summarize(getInvitation(p.id,row.id)), provider_accepted:true };
  });
  router.post("/api/projects/:id/prep/invitations/:inviteId/wechat-share", async ctx => {
    const p=requireManager(ctx,ctx.params.id);
    const row=getInvitation(p.id,ctx.params.inviteId);
    if (["已确认","已拒绝","已撤销","已邮件发送","发送中","待微信分享"].includes(row.status))
      throw conflict("邀请已发送或有最终回复，不能重签分享路径以免旧链接失效","INVITATION_STATE_CONFLICT");
    const token=issueToken(row.id);
    db.prepare("UPDATE prep_invitations SET status='待微信分享',channel='wechat' WHERE id=?").run(row.id);
    logAudit({user:ctx.user,module:"筹备管理",action:"生成微信小程序分享路径",target:p.id,
      detail:row.id+" / 待负责人在微信中分享",ip:ctx.ip});
    return { invitation:summarize(getInvitation(p.id,row.id)),
      path:sharePath(token), title:JSON.parse(row.snapshot_json).subject,
      note:"仅生成小程序分享路径，不代表消息已实际送达", delivery_confirmed:false };
  });
  router.post("/api/projects/:id/prep/invitations/:inviteId/revoke", async ctx => {
    const p=requireManager(ctx,ctx.params.id);
    const row=getInvitation(p.id,ctx.params.inviteId);
    if (row.status==="已撤销") return { status:"已撤销",idempotent:true };
    if (["已确认","已拒绝"].includes(row.status)) throw conflict("邀请已有最终回复，不能撤销");
    db.prepare("UPDATE prep_invitations SET status='已撤销' WHERE id=?").run(row.id);
    logAudit({user:ctx.user,module:"筹备管理",action:"撤销邀请函",target:p.id,detail:row.id,ip:ctx.ip});
    return { status:"已撤销",idempotent:false };
  });
  // Possession of a long, randomly issued token authorizes only this one invite.
  router.get("/api/public/prep-invitation", async ctx => {
    const row=inviteByToken(ctx.query.token);
    const s=JSON.parse(row.snapshot_json);
    return { invitation_id:row.id, type:row.type, title:s.subject, template:s.template_name,
      paragraphs:s.paragraphs, status:row.status,
      response:row.response||"", expires_at:row.expires_at };
  });
  router.get("/api/public/prep-invitation-pdf", async ctx => {
    const row=inviteByToken(ctx.query.token);
    const pdf=invitationPdf(JSON.parse(row.snapshot_json));
    return { __file:{buffer:pdf,mime:"application/pdf",name:row.id+"-邀请函.pdf",cache:"no-store",download:true} };
  });
  router.post("/api/public/prep-invitation/respond", async ctx => {
    const body=ctx.body||{}, row=inviteByToken(body.token);
    const choice=String(body.action||"").toUpperCase();
    if (!["CONFIRM","DECLINE"].includes(choice)) throw bad("只允许 CONFIRM / DECLINE");
    const response=choice==="CONFIRM"?"确认参加":"无法参加";
    if (row.response===choice) return { id:row.id,status:row.status,idempotent:true };
    if (row.response) throw conflict("邀请已回复，不能反向覆盖");
    transaction(() => {
      db.prepare("UPDATE prep_invitations SET status=?,response=?,responded_at=? WHERE id=?")
        .run(choice==="CONFIRM"?"已确认":"已拒绝",choice,nowIso(),row.id);
      // 入库到会议项目嘉宾档案：按 invitation_id 定位，不使用容易重名的姓名匹配。
    if (row.type==="guest") {
      const info=JSON.parse(row.snapshot_json).fields;
      const guestStatus=choice==="CONFIRM"?"已确认":"无法参加";
      const exists=db.prepare("SELECT id FROM guests WHERE invitation_id=?").get(row.id);
      if (exists) db.prepare("UPDATE guests SET status=? WHERE invitation_id=?").run(guestStatus,row.id);
      else db.prepare("INSERT INTO guests (pid,name,org,title,status,created_at,invitation_id) VALUES (?,?,?,?,?,?,?)")
        .run(row.pid,info["受邀姓名"],"",info["称谓"],guestStatus,nowIso(),row.id);
    }
    logAudit({user:null,module:"筹备管理",action:"受邀对象回复邀请",target:row.pid,
        detail:row.id+" / "+response,ip:ctx.ip});
    });
    return { id:row.id,status:choice==="CONFIRM"?"已确认":"已拒绝",idempotent:false };
  });
}
module.exports={register,attachDeliveryEnv};
