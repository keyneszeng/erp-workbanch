"use strict";
/**
 * 筹备阶段内置模板：立项通过后直接从会议项目取字段匹配。
 * 不使用任意代码/HTML 模板执行；生成邀请函时固定项目快照，避免后续静默变更已发送版本。
 */
const { bad } = require("./util");
const { createReportPdf } = require("./archive-pdf");

const TEMPLATES = Object.freeze({
  enterprise: Object.freeze({
    key: "enterprise",
    name: "企业邀请（招商）函",
    version: 1,
    subject: "关于邀请参与{{会议名称}}的函",
    paragraphs: [
      "尊敬的{{受邀单位}}{{称谓}}：",
      "您好！{{主办协会}}计划于{{会议日期}}举办“{{会议名称}}”，会议形式为{{会议形式}}。",
      "本次活动围绕学术交流及会议合作展开，诚邀贵单位了解会议安排，并就参会支持与合作事宜开展沟通。具体合作内容、权益与费用以双方正式确认的合同或协议为准。",
      "会议议程：{{会议议程}}",
      "敬请审阅并回复是否有意参与。衷心感谢贵单位的关注与支持！",
      "主办单位：{{主办协会}}",
      "会议联系人：{{项目负责人}}",
      "日期：{{生成日期}}"
    ]
  }),
  guest: Object.freeze({
    key: "guest",
    name: "嘉宾邀请函",
    version: 1,
    subject: "诚邀出席{{会议名称}}",
    paragraphs: [
      "尊敬的{{受邀姓名}}{{称谓}}：",
      "您好！{{主办协会}}诚挚邀请您于{{会议日期}}出席“{{会议名称}}”，会议形式为{{会议形式}}。",
      "拟邀请您担任：{{嘉宾角色}}。{{课题说明}}",
      "会议议程：{{会议议程}}",
      "如您方便出席，敬请确认邀请；具体行程和会议安排以会务组后续确认为准。",
      "主办单位：{{主办协会}}",
      "会议联系人：{{项目负责人}}",
      "日期：{{生成日期}}"
    ]
  })
});

function clean(value, label, max = 120, required = false) {
  const v = String(value == null ? "" : value).replace(/[\u0000-\u001f\u007f]/g, " ").trim();
  if (required && !v) throw bad(label + "为必填项");
  if (v.length > max) throw bad(label + "不能超过 " + max + " 字");
  return v;
}

function projectFields(project, date = new Date()) {
  return {
    "会议编号": clean(project.id, "会议编号", 70, true),
    "会议名称": clean(project.name, "会议名称", 100, true),
    "主办协会": clean(project.assoc, "主办协会", 100, true),
    "会议日期": clean(project.date, "会议日期", 40, true) + (Number(project.days) > 1 ? "（会期 " + project.days + " 天）" : ""),
    "会议形式": clean(project.form, "会议形式", 40) || "待确认",
    "会议议程": clean(project.agenda, "会议议程", 2000) || "以最终确认的议程为准",
    "项目负责人": clean(project.owner, "项目负责人", 80) || "会务组",
    "生成日期": date.toISOString().slice(0, 10)
  };
}

function recipientFields(type, body) {
  if (!TEMPLATES[type]) throw bad("不支持的邀请函模板类型");
  const data = body || {};
  return {
    "受邀单位": type === "enterprise" ? clean(data.recipient_org, "受邀单位", 120, true) : "",
    "受邀姓名": type === "guest" ? clean(data.recipient_name, "受邀姓名", 100, true) : "",
    "称谓": clean(data.recipient_title, "称谓/名头", 60) || (type === "enterprise" ? "负责人" : "老师"),
    "嘉宾角色": type === "guest" ? (clean(data.guest_role, "嘉宾角色", 60) || "特邀嘉宾") : "",
    "课题说明": type === "guest" ? (clean(data.topic, "课题", 240) ? "拟交流主题：" + clean(data.topic, "课题", 240) + "。" : "交流主题以双方最终确认的议程为准。") : ""
  };
}

function substitute(t, vars) {
  return String(t).replace(/\{\{([^{}]+)\}\}/g, (_, k) => Object.prototype.hasOwnProperty.call(vars, k) ? vars[k] : "");
}

function renderInvitation(type, project, body, date, settings) {
  const template = TEMPLATES[type];
  if (!template) throw bad("不支持的邀请函模板类型");
  // Keep the template module dependency acyclic: prep-config imports TEMPLATES.
  const cfg = settings || require("./prep-config").live();
  const layout = cfg.templates[type];
  const fields = Object.assign({}, projectFields(project, date), recipientFields(type, body));
  return {
    template_key: template.key, template_version: template.version,
    template_name: template.name,
    subject: substitute(layout.subject, fields),
    header_text: substitute(cfg.org_header,fields),
    footer_text: substitute(cfg.org_footer,fields),
    fields,
    paragraphs: layout.paragraphs.map(x => substitute(x, fields))
  };
}

function invitationPdf(snapshot) {
  const lines = [
    ...(snapshot.header_text ? [{kind:"section",text:snapshot.header_text}] : []),
    { kind: "title", text: snapshot.subject },
    { kind: "body", text: "" },
    ...snapshot.paragraphs.flatMap(s => [{ kind: "body", text: s }, { kind: "body", text: "" }]),
    ...(snapshot.footer_text ? [{kind:"body",text:snapshot.footer_text}] : [])
  ];
  return createReportPdf(lines, snapshot.template_name, { footer: "会议项目筹备 · 正式邀请函" });
}
module.exports = { TEMPLATES, projectFields, recipientFields, renderInvitation, invitationPdf, clean };
