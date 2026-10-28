"use strict";
const { db } = require("./db");
const { hashPassword } = require("./auth");
const { now, today } = require("./util");
const { VERIFY_STEPS, MATERIAL_KINDS, DEMAND_GROUPS, DEMAND_TEMPLATE, guessContractCategory } = require("./constants");

const PASS = "123456";

const USERS = [
  { username: "admin",   name: "李静", role: "admin",   assoc: null,        dept: "秘书处", phone: "13800000001", title: "总管理员" },
  { username: "assoc",   name: "王敏", role: "assoc",   assoc: "华东医学会", dept: "会务部", phone: "13800000002", title: "协会管理员" },
  { username: "exec",    name: "张伟", role: "exec",    assoc: "华东医学会", dept: "会务部", phone: "13800000003", title: "会务执行" },
  { username: "finance", name: "陈静", role: "finance", assoc: null,        dept: "财务部", phone: "13800000004", title: "财务与核销" },
  { username: "guest",   name: "刘洋", role: "user",    assoc: null,        dept: "—",     phone: "13800000005", title: "嘉宾" },
  { username: "zhaolei", name: "赵磊", role: "exec",    assoc: "消化病分会", dept: "学术部", phone: "13800000006", title: "会务执行" },
  { username: "sunqian", name: "孙倩", role: "assoc",   assoc: "肿瘤分会",   dept: "秘书处", phone: "13800000007", title: "协会管理员" },
  { username: "zhoutao", name: "周涛", role: "exec",    assoc: "护理协会",   dept: "会务部", phone: "13800000008", title: "会务执行" }
];

// id, 名称, 协会, 形式, 日期, 预算, 人数, 负责人, 状态
const PROJECTS = [
  ["MP-2026-001", "华东医学会年会", "华东医学会", "线下", "2026-09-12", 180000, 320, "王敏", "筹备中"],
  ["MP-2026-002", "护理协会论坛", "护理协会", "混合", "2026-09-25", 96000, 180, "张伟", "执行中"],
  ["MP-2026-003", "京津冀论坛 2026", "京津冀医学会", "混合", "2026-08-30", 240000, 260, "张伟", "待核销"],
  ["MP-2026-004", "外科沙龙 2026", "外科分会", "线下", "2026-08-15", 68000, 64, "陈静", "待核销"],
  ["MP-2026-005", "全科医学大会", "华东医学会", "线下", "2026-10-14", 150000, 0, "刘洋", "待审批"],
  ["MP-2026-006", "消化病学术周", "消化病分会", "混合", "2026-07-22", 210000, 210, "赵磊", "已结算"],
  ["MP-2026-007", "肿瘤精准治疗会", "肿瘤分会", "线上", "2026-06-10", 320000, 480, "孙倩", "已归档"],
  ["MP-2026-008", "儿科护理新进展", "护理协会", "线下", "2026-07-05", 72000, 96, "周涛", "已核销"],
  ["MP-2026-009", "心血管介入培训班", "华东医学会", "线下", "2026-11-06", 54000, 48, "陈静", "已立项"],
  ["MP-2026-010", "糖尿病管理论坛", "内分泌分会", "混合", "2026-10-28", 128000, 210, "王敏", "筹备中"],
  ["MP-2026-011", "基层医师能力提升班", "全科医学分会", "线下", "2026-11-18", 66000, 120, "刘洋", "筹备中"],
  ["MP-2026-012", "呼吸病学年会", "呼吸病分会", "线下", "2026-10-09", 265000, 380, "张伟", "执行中"],
  ["MP-2026-013", "骨科新技术研讨会", "华东医学会", "线下", "2026-12-03", 88000, 110, "王敏", "待审批"],
  ["MP-2026-014", "医学影像高峰论坛", "华东医学会", "混合", "2026-10-16", 175000, 240, "张伟", "执行中"],
  ["MP-2026-015", "皮肤科年会", "华东医学会", "线下", "2026-05-20", 142000, 200, "王敏", "已归档"],
  ["MP-2026-016", "急诊急救论坛", "华东医学会", "混合", "2026-07-11", 198000, 260, "陈静", "已结算"],
  ["MP-2026-017", "老年医学大会", "华东医学会", "线下", "2026-08-08", 140000, 160, "陈静", "已核销"],
  ["MP-2026-018", "青年医师沙龙", "华东医学会", "线下", "2027-01-15", 32000, 40, "王敏", "草稿"]
];

// 项目 → 成员（username）
const MEMBERS = {
  "MP-2026-001": ["exec", "assoc"],
  "MP-2026-002": ["exec", "guest"],
  "MP-2026-003": ["exec", "finance"],
  "MP-2026-004": ["finance"],
  "MP-2026-005": ["assoc"],
  "MP-2026-006": ["zhaolei", "finance"],
  "MP-2026-007": ["sunqian"],
  "MP-2026-008": ["zhoutao", "finance"],
  "MP-2026-009": ["finance"],
  "MP-2026-010": ["assoc"],
  "MP-2026-011": ["exec"],
  "MP-2026-012": ["exec"],
  "MP-2026-013": ["assoc"],
  "MP-2026-014": ["exec"],
  "MP-2026-015": ["assoc"],
  "MP-2026-016": ["finance"],
  "MP-2026-017": ["finance"],
  "MP-2026-018": ["assoc"]
};

const AGENDA = "09:00 开幕致辞 / 09:30 主题演讲 / 10:40 专题论坛 / 13:30 病例讨论 / 16:30 闭幕总结";

const CONTRACTS = [
  ["HT-2026-001", "MP-2026-001", "会场租赁及餐饮服务", "上海国际会议中心", 96000, "2026-07-20", "已签署"],
  ["HT-2026-002", "MP-2026-001", "主视觉与物料制作", "灵动广告", 28000, "2026-07-28", "已签署"],
  ["HT-2026-003", "MP-2026-002", "会场及直播服务", "浦东会展服务", 62000, "2026-08-05", "已签署"],
  ["HT-2026-004", "MP-2026-003", "会场租赁", "北京国际会议中心", 128000, "2026-06-18", "已签署"],
  ["HT-2026-005", "MP-2026-003", "专家劳务协议", "京津冀医学会", 36000, "2026-06-30", "已签署"],
  ["HT-2026-006", "MP-2026-006", "会务执行外包", "上海会务通", 88000, "2026-05-22", "已签署"],
  ["HT-2026-007", "MP-2026-007", "线上平台与直播", "云会科技", 120000, "2026-04-10", "已签署"],
  ["HT-2026-008", "MP-2026-012", "会场租赁及餐饮", "成都天府会议中心", 152000, "2026-08-20", "已签署"],
  ["HT-2026-009", "MP-2026-014", "影像设备租赁", "医影科技", 46000, "2026-09-01", "待签署"],
  ["HT-2026-010", "MP-2026-017", "会场租赁", "杭州国际博览中心", 68000, "2026-06-12", "已签署"]
];

const PAYMENTS = [
  ["MP-2026-003", "学会公付", "北京国际会议中心", 84000, "0312 4471", "张伟", "待审批"],
  ["MP-2026-006", "厂家款", "A 药业", 88200, "0312 4488", "赵磊", "已付款"],
  ["MP-2026-008", "个人报销", "周涛", 3600, "0312 4490", "周涛", "已付款"],
  ["MP-2026-004", "学会公付", "上海国际会议中心", 23800, "0312 4501", "陈静", "已驳回"],
  ["MP-2026-006", "学会公付", "上海国际会议中心", 120000, "0312 4488", "赵磊", "已付款"],
  ["MP-2026-017", "厂家款", "B 器械", 64000, "0312 4412", "陈静", "已付款"],
  ["MP-2026-017", "学会公付", "杭州国际博览中心", 68000, "0312 4413", "陈静", "已付款"],
  ["MP-2026-007", "学会公付", "云会科技", 120000, "0312 4390", "孙倩", "已付款"],
  ["MP-2026-007", "个人报销", "孙倩", 2800, "0312 4391", "孙倩", "已付款"],
  ["MP-2026-015", "学会公付", "上海国际会议中心", 82000, "0312 4350", "王敏", "已付款"],
  ["MP-2026-016", "学会公付", "上海会务通", 96000, "0312 4360", "陈静", "已付款"],
  ["MP-2026-016", "厂家款", "C 医药", 54000, "0312 4361", "陈静", "已付款"],
  ["MP-2026-001", "学会公付", "上海国际会议中心", 48000, "0312 4520", "王敏", "待审批"],
  ["MP-2026-012", "厂家款", "D 医疗", 76000, "0312 4530", "张伟", "待审批"]
];

const APPROVALS = [
  ["AP-2026-014", "立项审批", "全科医学大会", "MP-2026-005", 150000, "刘洋", "今日 18:00", "待审批"],
  ["AP-2026-015", "立项审批", "骨科新技术研讨会", "MP-2026-013", 88000, "王敏", "10-20", "待审批"],
  ["AP-2026-013", "例外单审批", "EX-2026-018 课件不在议程课题", "MP-2026-003", 0, "李XX", "10-19", "待审批"],
  ["AP-2026-012", "付款审批", "学会公付 ¥84,000", "MP-2026-003", 84000, "张伟", "10-18", "待审批"],
  ["AP-2026-011", "变更审批", "议程调整：新增 1 个圆桌环节", "MP-2026-001", 0, "王敏", "10-19", "已通过"],
  ["AP-2026-010", "立项审批", "儿科护理新进展", "MP-2026-008", 72000, "周涛", "已完成", "已通过"]
];

/**
 * 收款方 → [开户行, 银行账号]（V1.2.18）
 *
 * 付款单与结算单都要有收款账户，否则财务拿着单子没法打款。
 * 种子数据按收款方固定映射：同一家单位在不同项目上的账户必须一致，
 * 否则演示时会出现「北京国际会议中心有两张单子、账号却不一样」的怪事。
 */
const PAYEE_BANK = {
  "北京国际会议中心": ["中国银行北京朝阳支行", "3210123456789012"],
  "上海国际会议中心": ["工商银行上海浦东分行", "1001234567890123456"],
  "杭州国际博览中心": ["农业银行杭州钱江支行", "19012345678901234"],
  "A 药业": ["招商银行北京分行营业部", "6225880123456789"],
  "B 器械": ["建设银行上海静安支行", "3105012345678901234"],
  "C 医药": ["交通银行上海分行", "310012345678901234"],
  "D 医疗": ["浦发银行上海分行", "9801234567890123"],
  "云会科技": ["中信银行杭州分行", "8110123456789012345"],
  "上海会务通": ["民生银行上海分行", "6901234567890123"],
  "周涛": ["工商银行护理协会支行", "6222021234567890123"],
  "孙倩": ["招商银行杭州分行", "6225881234567890"]
};
const DEFAULT_BANK = ["中国银行北京分行", "3210987654321098"];
const bankOf = (payee) => PAYEE_BANK[payee] || DEFAULT_BANK;

const GUESTS = [
  ["MP-2026-001", "赵教授", "华东医科大学", "主任委员", "已确认"],
  ["MP-2026-001", "钱主任", "市第一人民医院", "科室主任", "待确认"],
  ["MP-2026-002", "孙护士长", "护理协会", "常务理事", "已确认"],
  ["MP-2026-012", "李院士", "呼吸病分会", "名誉主委", "待邀请"],
  ["MP-2026-014", "周教授", "影像医学中心", "教授", "已确认"]
];

const TASKS = [
  ["MP-2026-001", "确认主会场 LED 屏规格", "张伟", "2026-10-22", "进行中", "高"],
  ["MP-2026-001", "收集嘉宾 PPT 终版", "王敏", "2026-10-25", "待开始", "中"],
  ["MP-2026-002", "现场摄影摄像排班", "张伟", "2026-10-20", "进行中", "中"],
  ["MP-2026-012", "签到台物料到场", "张伟", "2026-10-19", "已完成", "高"],
  ["MP-2026-014", "设备调试与彩排", "张伟", "2026-10-20", "待开始", "高"]
];

const ISSUES = [
  ["MP-2026-002", "分会场音响偶发啸叫", "一般", "张伟", "处理中"],
  ["MP-2026-012", "部分嘉宾行程变更需改签", "重要", "张伟", "处理中"],
  ["MP-2026-014", "签到系统网络不稳", "紧急", "张伟", "已解决"]
];

function alreadySeeded() {
  const c = db.prepare("SELECT COUNT(*) AS c FROM users").get().c;
  return c > 0;
}

function seed({ reset = false } = {}) {
  if (reset) {
    for (const t of ["uploaded_files", "sessions", "audit_logs", "exports", "settlements", "exceptions", "verify_steps", "payments",
      "contracts", "approvals", "materials", "guests", "tasks", "issues", "demand_items", "demand_sheets",
      "project_members", "projects", "users", "settings"]) {
      db.exec(`DELETE FROM ${t}`);
    }
    db.exec("DELETE FROM sqlite_sequence");
  } else if (alreadySeeded()) {
    return { skipped: true };
  }

  const at = now();
  const minutesAgo = (m) => now(new Date(Date.now() - m * 60000));
  const insUser = db.prepare(
    "INSERT INTO users (username,name,role,assoc,dept,phone,pass_salt,pass_hash,active,created_at) VALUES (?,?,?,?,?,?,?,?,1,?)"
  );
  const userId = {};
  const userIdByName = {};
  for (const u of USERS) {
    const { salt, hash } = hashPassword(PASS);
    insUser.run(u.username, u.name, u.role, u.assoc, u.dept, u.phone, salt, hash, at);
    userId[u.username] = db.prepare("SELECT id FROM users WHERE username = ?").get(u.username).id;
    userIdByName[u.name] = userId[u.username];
  }

  const insProj = db.prepare(
    `INSERT INTO projects (id,name,assoc,form,date,days,budget,people,owner,owner_id,phone,dept,agenda,status,status_at,created_by,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  );
  let pi = 0;
  for (const [id, name, assoc, form, date, budget, people, owner, status] of PROJECTS) {
    const created = minutesAgo((PROJECTS.length - pi) * 60 * 26);
    insProj.run(id, name, assoc, form, date, 2, budget, people, owner,
      userIdByName[owner] || null, "021-60000000", "会务部",
      AGENDA, status, created, userId["assoc"], created, created);
    pi++;
  }

  const insMem = db.prepare("INSERT OR IGNORE INTO project_members (project_id,user_id,role) VALUES (?,?,?)");
  for (const [pid, list] of Object.entries(MEMBERS)) {
    for (const un of list) insMem.run(pid, userId[un], "成员");
  }

  const insC = db.prepare(
    "INSERT INTO contracts (id,pid,name,vendor,amount,sign_date,status,category,created_by,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)"
  );
  // 种子合同按名称自动归类：核销第 5 步只列「劳务专家」类，
  // 全塞成同一类会让演示数据里第 5 步永远显示同一批合同。
  for (const c of CONTRACTS) insC.run(...c, guessContractCategory(c[2]), userId["assoc"], at);

  const insP = db.prepare(
    "INSERT INTO payments (id,pid,type,payee,payee_bank,payee_account,amount,invoice_no,req_user,status,paid_at,created_by,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)"
  );
  let py = 30;
  for (const [pid, type, payee, amt, inv, req, st] of PAYMENTS) {
    py += 1;
    const when = minutesAgo((PAYMENTS.length - py + 31) * 97);
    const [bank, acct] = bankOf(payee);
    insP.run(`PY-2026-0${py}`, pid, type, payee, bank, acct, amt, inv, req, st,
      st === "已付款" ? when : null, userId["finance"], when);
  }

  // 审批单必须指向真实业务单据。
  // 老版本这里一律写 pid，于是「例外单审批 / 付款审批」两类单子两头都断：
  //   点「通过」时按 ref_id 找不到例外单 / 付款单 → 报「不存在」；
  //   付款审批、改判撤销这些业务动作按 ref_id 找不到审批单 → 单子永远挂「待审批」。
  // 所以 ref 按类型解析：例外单 → 标题里的 EX 号；付款 → 同项目同金额的付款单；立项 / 变更 → 项目号。
  // 必须放在付款单插入之后，否则付款审批拿不到真实单号。
  const insAp = db.prepare(
    "INSERT INTO approvals (id,type,title,pid,ref_id,amount,by_user,sla,status,created_at,decided_by,decided_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)"
  );
  const refOf = (type, title, pid, amt) => {
    if (type === "例外单审批") {
      const m = /EX-\d{4}-\d{3,}/.exec(title);
      if (m) return m[0];
    }
    if (type === "付款审批") {
      const y = db
        .prepare("SELECT id FROM payments WHERE pid = ? AND ABS(amount - ?) < 0.005 ORDER BY created_at DESC LIMIT 1")
        .get(pid, amt);
      if (y) return y.id;
    }
    return pid;
  };
  for (const [id, type, title, pid, amt, by, sla, st] of APPROVALS) {
    const decided = st === "已通过" ? "王敏" : null;
    insAp.run(id, type, title, pid, refOf(type, title, pid, amt), amt, by, sla, st, at, decided, decided ? at : null);
  }

  const insStep = db.prepare(
    "INSERT OR REPLACE INTO verify_steps (pid,step_no,name,result,remark,checked_by,checked_at) VALUES (?,?,?,?,?,?,?)"
  );
  const allPass = ["MP-2026-006", "MP-2026-007", "MP-2026-008", "MP-2026-015", "MP-2026-016", "MP-2026-017"];
  for (const pid of allPass) {
    for (const s of VERIFY_STEPS) insStep.run(pid, s.no, s.name, "通过", "核对无误", "陈静", at);
  }
  // MP-2026-003：前 3 步通过，第 4 步不通过 → 例外单待审批
  for (const s of VERIFY_STEPS.slice(0, 3)) insStep.run("MP-2026-003", s.no, s.name, "通过", "核对无误", "张伟", at);
  insStep.run("MP-2026-003", 4, VERIFY_STEPS[3].name, "不通过", "课件「糖尿病管理新进展」不在议程课题内", "陈静", at);
  db.prepare("INSERT INTO exceptions (id,pid,step_no,reason,status,created_by,created_at) VALUES (?,?,?,?,?,?,?)")
    .run("EX-2026-018", "MP-2026-003", 4, "课件「糖尿病管理新进展」不在议程课题内，申请补录议程", "待审批", "陈静", at);
  // MP-2026-004：前 2 步通过
  for (const s of VERIFY_STEPS.slice(0, 2)) insStep.run("MP-2026-004", s.no, s.name, "通过", "核对无误", "陈静", at);

  const insSt = db.prepare(
    "INSERT INTO settlements (id,pid,income,expense,profit,payee,payee_bank,payee_account,status,created_by,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)"
  );
  insSt.run("ST-2026-001", "MP-2026-006", 210000, 208200, 1800,
    "华东医学会", "中国银行北京分行", "3210987654321098", "已生成", "陈静", at);
  insSt.run("ST-2026-002", "MP-2026-007", 320000, 122800, 197200,
    "华东医学会", "中国银行北京分行", "3210987654321098", "已生成", "陈静", at);
  insSt.run("ST-2026-003", "MP-2026-015", 142000, 82000, 60000,
    "华东医学会", "中国银行北京分行", "3210987654321098", "已生成", "陈静", at);
  insSt.run("ST-2026-004", "MP-2026-016", 198000, 150000, 48000,
    "华东医学会", "中国银行北京分行", "3210987654321098", "已生成", "陈静", at);

  const insMat = db.prepare("INSERT INTO materials (pid,kind,name,version,uploader,created_at) VALUES (?,?,?,?,?,?)");
  /**
   * V1.2.19：材料 8 类齐备是**核销的前置门**。
   *
   * 所以「能走到待核销及以后」的项目，种子里材料必须本来就是 8/8 ——
   * 否则演示时点第 4 步判定会被拦「材料缺 8 类」，观众看到的是门禁失效（其实是数据不自洽）。
   * 这批项目覆盖：待核销（003/004）、已核销（008/017）、已结算（006/016）、已归档（007/015）。
   */
  const needAllMaterials = [
    "MP-2026-003", "MP-2026-004", "MP-2026-006", "MP-2026-007",
    "MP-2026-008", "MP-2026-015", "MP-2026-016", "MP-2026-017"
  ];
  for (const pid of needAllMaterials) {
    for (const k of MATERIAL_KINDS) insMat.run(pid, k, `${k}-终版.pdf`, "v1", "陈静", at);
  }
  // 筹备中的项目只登记 5 类：演示「材料还没齐、核销还没开启」的常态
  for (const k of ["立项文件", "合同", "议程", "课件", "签到表"]) {
    insMat.run("MP-2026-001", k, `${k}-初版.pdf`, "v1", "张伟", at);
  }

  const insG = db.prepare("INSERT INTO guests (pid,name,org,title,phone,status,created_at) VALUES (?,?,?,?,?,?,?)");
  for (const [pid, name, org, title, st] of GUESTS) insG.run(pid, name, org, title, "13900000000", st, at);

  const insT = db.prepare("INSERT INTO tasks (pid,name,owner,due,status,priority,created_at) VALUES (?,?,?,?,?,?,?)");
  for (const t of TASKS) insT.run(...t, at);

  const insI = db.prepare("INSERT INTO issues (pid,title,level,owner,status,created_at) VALUES (?,?,?,?,?,?)");
  for (const i of ISSUES) insI.run(...i, at);

  // 会务需求：为旗舰项目 MP-2026-001 播种一份已填写的需求单（其余项目首次打开时按模板生成）
  // 结构：[需要与否, 规格, 负责人, 交付时间, 预算金额]
  const DEMAND_SEED = {
    "设计|串场": ["需要", "主视觉 16:9，含 5 个环节页", "王敏", "2026-09-05", "3800"],
    "设计|议程A4单张": ["需要", "双面彩印 300 份", "王敏", "2026-09-08", "1200"],
    "设计|台卡": ["需要", "21×15cm 亚克力 40 个", "李强", "2026-09-10", "1600"],
    "设计|议程易拉宝": ["不需要", "", "", "", ""],
    "设计|人头易拉宝": ["需要", "签到区 1 个", "李强", "2026-09-12", "900"],
    "制作|串场纸质版单面彩印": ["需要", "200 份 不装订", "李强", "2026-09-12", "1500"],
    "制作|议程A4单张": ["需要", "200 份", "李强", "2026-09-12", "1200"],
    "制作|台卡": ["需要", "讲者另备 2 份", "李强", "2026-09-12", "600"],
    "制作|易拉宝": ["需要", "人头 + 议程 各 1 个", "李强", "2026-09-12", "1800"],
    "制作|产品易拉宝": ["不需要", "", "", "", ""],
    "制作|横幅": ["需要", "8m 含协会名 + logo", "王敏", "2026-09-12", "1200"],
    "制作|讲台花": ["需要", "鲜花 1 组，含更换", "陈静", "2026-09-13", "800"],
    "制作|讲台包边": ["需要", "红绒布包边", "李强", "2026-09-12", "400"],
    "制作|背景板": ["需要", "6×3m 桁架喷绘", "李强", "2026-09-12", "4500"],
    "现场执行|控台": ["需要", "2 人，含彩排", "张伟", "2026-09-14", "2400"],
    "现场执行|控场": ["需要", "2 人，含普通拍照", "张伟", "2026-09-14", "2400"],
    "现场执行|专业摄影": ["需要", "1 机位，全天", "张伟", "2026-09-14", "3600"],
    "现场执行|线上端口": ["需要", "直播推流 1 路", "张伟", "2026-09-14", "5000"],
    "其他|垫付": ["需要", "启动资金 5 万，实报实销", "陈静", "2026-09-01", "50000"],
    "其他|参会胸卡设计及实物": ["需要", "320 张含挂绳", "王敏", "2026-09-15", "4800"],
    "其他|代购酒水": ["不需要", "", "", "", ""],
    "其他|车队服务": ["需要", "大巴 2 辆机场往返", "刘洋", "2026-09-15", "3200"],
    "其他|其他": ["不需要", "", "", "", ""]
  };
  const insSheet = db.prepare("INSERT OR IGNORE INTO demand_sheets (pid,confirmed,created_at,updated_at) VALUES (?,0,?,?)");
  const insDemand = db.prepare(
    "INSERT OR IGNORE INTO demand_items (pid,grp,item,note,need,spec,owner,due,budget,attach,status,ordering,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)"
  );
  insSheet.run("MP-2026-001", at, at);
  let dOrder = 0;
  for (const g of DEMAND_GROUPS) {
    for (const t of (DEMAND_TEMPLATE[g] || [])) {
      const ov = DEMAND_SEED[`${g}|${t.item}`];
      const [need, spec, owner, due, budget] = ov || ["需要", "", "", "", ""];
      insDemand.run("MP-2026-001", g, t.item, t.note || "", need, spec, owner, due, budget, "", "未开始", dOrder++, at);
    }
  }

  const insA = db.prepare(
    "INSERT INTO audit_logs (at,user_id,user_name,role,module,action,target,detail,ip) VALUES (?,?,?,?,?,?,?,?,?)"
  );
  const AUDITS = [
    ["财务与核销", "会后核销", "结论", "MP-2026-003", "第 4 步判定不通过 → 生成例外单 EX-2026-018"],
    ["会务执行", "材料中心", "上传", "MP-2026-001", "上传串场 PPT v2"],
    ["协会管理员", "项目管理", "审批通过", "MP-2026-002", "立项审批通过，状态 → 已立项"],
    ["总管理员", "系统配置", "改角色", "—", "为 张伟 增加「财务与核销」授权"],
    ["财务与核销", "财务结算", "付款", "MP-2026-006", "学会公付 ¥120,000 已提交银行"],
    ["会务执行", "会务执行", "分配任务", "MP-2026-002", "现场摄影分配给 张伟"]
  ];
  const ROLE_USER = { "总管理员": "admin", "协会管理员": "assoc", "会务执行": "exec", "财务与核销": "finance" };
  let k = 0;
  for (const [role, mod, act, tgt, detail] of AUDITS) {
    const u = USERS.find((x) => x.username === ROLE_USER[role]) || USERS[0];
    insA.run(minutesAgo((AUDITS.length - k) * 43), userId[u.username], u.name, role, mod, act, tgt, detail, "127.0.0.1");
    k++;
  }

  db.prepare("INSERT OR REPLACE INTO settings (k,v) VALUES (?,?)").run("seeded_at", at);
  db.prepare("INSERT OR REPLACE INTO settings (k,v) VALUES (?,?)").run("org", "华东医学会 · 会务执行中心");

  return { skipped: false, users: USERS.length, projects: PROJECTS.length, payments: PAYMENTS.length, audits: k };
}

module.exports = { seed, USERS, PASS };
