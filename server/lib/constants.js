"use strict";

const ASSOCS = [
  "华东医学会", "京津冀医学会", "护理协会", "外科分会",
  "全科医学分会", "消化病分会", "肿瘤分会", "心血管分会",
  "内分泌分会", "呼吸病分会"
];

const FORMS = ["线下", "线上", "混合"];
const DEPTS = ["会务部", "学术部", "财务部", "秘书处"];
const PAYMENT_TYPES = ["学会公付", "个人报销", "厂家款"];

/** 核销 6 步 SOP —— 顺序不可跳过，全部通过才允许进入结算 */
const VERIFY_STEPS = [
  { no: 1, name: "议程与课件核对", desc: "实际议程环节与提交版本一致", who: "会务执行" },
  { no: 2, name: "签到人数与报名核对", desc: "签到人数 ≥ 报名人数 85%，名单可追溯", who: "会务执行" },
  { no: 3, name: "现场费用凭证", desc: "场地、餐饮、物料票据齐全且金额可对", who: "会务执行" },
  { no: 4, name: "课件与议程课题一致性", desc: "每个课件都能对应到议程上的课题", who: "财务与核销" },
  { no: 5, name: "劳务与专家费核对", desc: "劳务表签字齐全，专家费与合同一致", who: "财务与核销" },
  { no: 6, name: "发票与合同金额核对", desc: "发票金额 = 合同金额 = 付款金额", who: "财务与核销" }
];

/** 归档必备材料 8 类 */
const MATERIAL_KINDS = [
  "立项文件", "合同", "议程", "课件", "签到表",
  "劳务表", "发票", "现场照片"
];

/** 9 状态 8 流转 */
const FLOW = [
  { from: "草稿", action: "submit", to: "待审批", label: "提交立项", perm: "project:create" },
  { from: "待审批", action: "approve", to: "已立项", label: "审批通过", perm: "project:approve" },
  { from: "已立项", action: "prep", to: "筹备中", label: "进入筹备", perm: "project:transition" },
  { from: "筹备中", action: "exec", to: "执行中", label: "进入执行", perm: "project:transition" },
  { from: "执行中", action: "request_verify", to: "待核销", label: "提交核销", perm: "project:transition" },
  { from: "待核销", action: "verify_pass", to: "已核销", label: "核销通过", perm: "verify:conclude" },
  { from: "已核销", action: "settle", to: "已结算", label: "生成结算单", perm: "settle:create" },
  { from: "已结算", action: "archive", to: "已归档", label: "归档", perm: "archive:write" }
];

const STATUS_DESC = {
  "草稿": "立项材料未提交",
  "待审批": "等待协会管理员审批",
  "已立项": "审批通过，待组建团队",
  "筹备中": "合同 / 嘉宾 / 议程 / 资源筹备",
  "执行中": "会期执行与现场取证",
  "待核销": "等待 6 步核销判定",
  "已核销": "核销通过，可付款 / 可结算",
  "已结算": "结算单已生成，结论冻结",
  "已归档": "数字卷宗已封存"
};

module.exports = { ASSOCS, FORMS, DEPTS, PAYMENT_TYPES, VERIFY_STEPS, MATERIAL_KINDS, FLOW, STATUS_DESC };
