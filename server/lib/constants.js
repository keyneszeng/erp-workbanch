"use strict";

const ASSOCS = [
  "华东医学会", "京津冀医学会", "护理协会", "外科分会",
  "全科医学分会", "消化病分会", "肿瘤分会", "心血管分会",
  "内分泌分会", "呼吸病分会"
];

const FORMS = ["线下", "线上", "混合"];
// 承办部门与账号部门分类的业务含义不同，不能共用一个选项表。
const DEPTS = ["会务部", "学术部", "财务部", "秘书处"];
const USER_DEPTS = ["供应商", "非供应商", "学术部", "财务部", "秘书处"];
const PAYMENT_TYPES = ["学会公付", "专家费", "个人报销", "厂家款"];

/** 核销 6 步 SOP —— 顺序不可跳过，全部通过才允许进入结算 */
const VERIFY_STEPS = [
  { no: 1, name: "盖章函件与立项信息核验", desc: "文件已盖章且为终版，核对会议名、时间、主办方与招商主体", who: "会务执行" },
  { no: 2, name: "讲者名单三处一致", desc: "议程 ∩ 劳务收集表 ∩ 劳务协议：无冒领、漏发、重复", who: "财务与核销" },
  { no: 3, name: "参会数据与时长", desc: "线上讲者在线 >30 分钟；线下签到表；混合会议两者均满足", who: "会务执行" },
  { no: 4, name: "课件与串场内容核验", desc: "课件课题匹配议程，串场题目与主办方名/logo 一致；药企 logo 仅首页/尾页/鸣谢页", who: "财务与核销" },
  { no: 5, name: "劳务五字段一致", desc: "劳务收集表与协议：姓名、时间、角色、金额、银行账号逐项一致", who: "财务与核销" },
  { no: 6, name: "会务三单一致", desc: "合同总额 = 拟请款总额；应开票合同金额 = 发票总额；专家劳务按已核验协议免票请款", who: "财务与核销" }
];

/** 材料中心固定模块；按项目启停，永远保留历史材料 */
const MATERIAL_MODULE_KINDS = ["课件", "串场", "劳务收集表", "劳务协议"];

/** 建议材料类别（不是归档前置条件）；支持自定义其他类别。 */
const MATERIAL_KINDS = [
  "立项文件", "合同", "议程", "终版议程", "课件", "签到表",
  "劳务表", "发票", "现场照片", "权益照片"
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
  "已核销": "核销通过：核票→付款申请→协会审批→财务付款→结算",
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

/**
 * 会务需求只属于「筹备中 / 执行中」两个阶段。
 *
 * 老板 2026-10-28 的修正：会务需求是筹备和执行阶段由负责人填写的作业，
 * 立项前还没到筹备、核销后已经是存档记录 —— 这两头的项目不该出现在
 * 「会务需求 → 会议项目」列表里。归档后的需求单在项目详情页看。
 */
const DEMAND_STATUSES = ["筹备中", "执行中"];

module.exports = { ASSOCS, FORMS, DEPTS, USER_DEPTS, PAYMENT_TYPES, VERIFY_STEPS, MATERIAL_KINDS, MATERIAL_MODULE_KINDS, CONTRACT_CATEGORIES, guessContractCategory, FLOW, STATUS_DESC, DEMAND_GROUPS, DEMAND_TEMPLATE, DEMAND_NEED_OPTIONS, DEMAND_STATUSES };
