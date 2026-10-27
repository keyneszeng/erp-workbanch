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

/**
 * 合同类别。
 *
 * 核销第 5 步核的是「劳务与专家费」，第 6 步核的是「发票 = 合同 = 付款」的全量。
 * 以前合同没有类别，第 5 步只能把项目下所有合同都列出来 —— 于是 MP-2026-012
 * 那份「会场租赁及餐饮」被摆到了劳务核对里，看着就像专家费走了场地合同。
 * 类别是给「这一步该核哪几份合同」用的，不是装饰。
 */
const CONTRACT_CATEGORIES = ["场地餐饮", "物料搭建", "劳务专家", "设备技术", "其他"];

/**
 * 按合同名称猜类别 —— 只用于两处：老库升级时给历史数据补一个初始值，
 * 以及新录入时没选类别（不强制选，避免为了填表硬猜）。
 * 猜错不致命：类别只影响第 5 步列哪几份，随时可在合同台账改。
 */
function guessContractCategory(name) {
  const s = String(name || "");
  if (/劳务|专家|讲课|授课|咨询|讲者|主持/.test(s)) return "劳务专家";
  if (/场地|会场|餐饮|住宿|酒店|会议中心|宴会/.test(s)) return "场地餐饮";
  if (/物料|制作|视觉|搭建|展板|印刷|礼品|广告/.test(s)) return "物料搭建";
  if (/设备|直播|平台|技术|影像|摄影|摄像|音响|灯光|系统/.test(s)) return "设备技术";
  return "其他";
}

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

/** 会务需求确认 —— 四组模板（老板提供的《会务需求确认》业务清单） */
const DEMAND_GROUPS = ["设计", "制作", "现场执行", "其他"];

/**
 * 每组下的默认条目；note 为括号内的业务提示（如「需要吗」「需要几位」）
 * 第一次打开某项目的需求单时由后端按此模板生成，之后以数据库为准
 */
const DEMAND_TEMPLATE = {
  "设计": [
    { item: "串场" },
    { item: "议程A4单张" },
    { item: "台卡" },
    { item: "议程易拉宝" },
    { item: "人头易拉宝" }
  ],
  "制作": [
    { item: "串场纸质版单面彩印", note: "几份，需不需要装订" },
    { item: "议程A4单张", note: "几份" },
    { item: "台卡", note: "讲者是否需要两份" },
    { item: "易拉宝", note: "人头 / 议程" },
    { item: "产品易拉宝", note: "需要吗" },
    { item: "横幅", note: "需要吗" },
    { item: "讲台花", note: "需要吗" },
    { item: "讲台包边", note: "需要吗" },
    { item: "背景板", note: "需要吗" }
  ],
  "现场执行": [
    { item: "控台", note: "需要几位" },
    { item: "控场", note: "包含普通拍照，需要几位" },
    { item: "专业摄影", note: "需要几位" },
    { item: "线上端口", note: "需要吗" }
  ],
  "其他": [
    { item: "垫付" },
    { item: "参会胸卡设计及实物" },
    { item: "代购酒水" },
    { item: "车队服务" },
    { item: "其他" }
  ]
};

const DEMAND_NEED_OPTIONS = ["需要", "不需要"];

module.exports = { ASSOCS, FORMS, DEPTS, PAYMENT_TYPES, VERIFY_STEPS, MATERIAL_KINDS, CONTRACT_CATEGORIES, guessContractCategory, FLOW, STATUS_DESC, DEMAND_GROUPS, DEMAND_TEMPLATE, DEMAND_NEED_OPTIONS };
