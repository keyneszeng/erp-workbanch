"use strict";
const { db } = require("./db");
const { now, nextId, conflict, forbidden, notFound, bad, cents, yuan, parseBankAccount, parseBankName } = require("./util");
const { can, isSuper, ROLES } = require("./rbac");
const { logAudit } = require("./audit");
const { FLOW, VERIFY_STEPS, MATERIAL_KINDS } = require("./constants");
const { isDemoMode } = require("./runtime");

function getProject(id) {
  const p = db.prepare("SELECT * FROM projects WHERE id = ?").get(id);
  if (!p) throw notFound(`项目 ${id} 不存在`);
  return p;
}

/** 核销进度 */
function verification(pid) {
  const rows = db.prepare("SELECT * FROM verify_steps WHERE pid = ? ORDER BY step_no").all(pid);
  const map = new Map(rows.map((r) => [r.step_no, r]));
  const steps = VERIFY_STEPS.map((def) => {
    const r = map.get(def.no);
    return {
      ...def,
      result: r ? r.result : "待判定",
      remark: r ? r.remark : "",
      invoiceAmount: r ? r.invoice_amount : null,
      checked_by: r ? r.checked_by : "",
      checked_at: r ? r.checked_at : ""
    };
  });
  const judged = steps.filter((s) => s.result !== "待判定").length;
  const passed = steps.filter((s) => s.result === "通过" || s.result === "已解例外").length;
  const failedSteps = steps.filter((s) => s.result === "不通过").map((s) => s.no);
  const openExceptions = db
    .prepare("SELECT COUNT(*) AS c FROM exceptions WHERE pid = ? AND status = '待审批'")
    .get(pid).c;
  const exceptions = db.prepare("SELECT * FROM exceptions WHERE pid = ? ORDER BY created_at DESC").all(pid);
  return {
    steps,
    judged,
    passed,
    total: VERIFY_STEPS.length,
    failedSteps,
    openExceptions,
    exceptions,
    complete: passed === VERIFY_STEPS.length && openExceptions === 0
  };
}

/** 归档材料 8 类齐备情况 */
function materialsStatus(pid) {
  const rows = db.prepare("SELECT DISTINCT kind FROM materials WHERE pid = ?").all(pid);
  const have = rows.map((r) => r.kind);
  const missing = MATERIAL_KINDS.filter((k) => !have.includes(k));
  return { have, missing, ok: missing.length === 0, required: MATERIAL_KINDS };
}

function settlementOf(pid) {
  return db.prepare("SELECT * FROM settlements WHERE pid = ?").get(pid) || null;
}

/**
 * 归档的会务需求单 —— 核销第 3 步的费用对照基准。
 *
 * 需求单确认后即归档，它记的是「当初答应花多少」；核销要核的是「实际花了多少」，
 * 两者摆在一起才看得出超没超。
 *
 * 放在 workflow 里而不是 api/demand.js，是因为两个入口都要用它：
 * GET /api/projects/:id（项目详情页的核销页签）与 GET /api/projects/:id/verify（核销看板）。
 * 放在 demand.js 会形成 projects ↔ demand 循环 require，一边拿到 undefined。
 * 两处必须同源，否则同一个第 3 步在两个页面给出不同答案。
 */
function demandSummary(pid) {
  const sheet = db.prepare("SELECT * FROM demand_sheets WHERE pid = ?").get(pid);
  if (!sheet) return null;
  const items = db.prepare(
    "SELECT grp,item,need,budget FROM demand_items WHERE pid = ? ORDER BY ordering, id"
  ).all(pid);
  if (!items.length) return null;
  const need = items.filter((x) => x.need === "需要");
  return {
    archived: !!sheet.confirmed,
    confirmedBy: sheet.confirmed_by || "",
    confirmedAt: sheet.confirmed_at || "",
    total: items.length,
    needCount: need.length,
    // 逐条累加会留浮点尾巴，收敛到「分」
    budgetTotal: yuan(need.reduce((s, x) => s + (Number(x.budget) || 0), 0)),
    items: need.map((x) => ({ grp: x.grp, item: x.item, budget: x.budget || "" }))
  };
}

/**
 * 冻结判定：已归档 = 卷宗封存；有结算单 = 账目封账。
 *
 * 用「有没有结算单」而不是只看 status —— 状态可能被人为改过，
 * 但结算单存在与否是硬事实。材料删除、需求单、项目成员等
 * 「结算后不该再动」的写操作统一走这里，避免每个接口各写一套判断。
 */
function assertNotFrozen(p, what = "业务数据") {
  if (p.status === "已归档") {
    throw conflict(`项目已归档，${what}已封存，不可修改`, "ARCHIVED", { status: p.status });
  }
  if (settlementOf(p.id)) {
    throw conflict(`结算单已生成，${what}已冻结，不可修改`, "FROZEN", { status: p.status });
  }
}

/**
 * 已占用预算：待审批 + 已审批 + 已付款（驳回的不占）。
 * 放在这里而不是 finance.js，是因为改预算（projects.js）与付款申请（finance.js）
 * 必须用同一把尺子 —— 两边各算一份，迟早算出不同的数。
 */
function committed(pid) {
  // ROUND(...,2) 不能省：SUM 出来是 3580.2300000000005 这种尾巴，
  // 预算门禁拿它跟预算比，会把「正好用尽」判成超预算。
  return yuan(db.prepare(
    "SELECT COALESCE(ROUND(SUM(amount),2),0) AS s FROM payments WHERE pid = ? AND status IN ('待审批','已审批','已付款')"
  ).get(pid).s);
}

/** 门禁：所有前置条件 */
const GUARDS = {
  submit(p) {
    if (!p.agenda || String(p.agenda).trim().length < 4) return "立项必须填写初版议程要点";
    if (!(p.budget > 0)) return "预算必须大于 0";
    return null;
  },
  /**
   * V1.2.19：材料 8 类齐备才能「开启核销」。
   *
   * 老板 2026-10-28：「必须完成 材料 8 项录入，才能开启 核销功能」。
   * 原来材料只是**归档**的前置，核销 6 步可以先判、材料后补 ——
   * 于是判定人手里没有签到表、没有票据，只能凭印象点「通过」，核销就退化成橡皮图章。
   * 现在把材料前置到核销入口：材料不齐，提交核销直接拦。
   */
  request_verify(p) {
    const m = materialsStatus(p.id);
    if (!m.ok) {
      return `核销材料还缺 ${m.missing.length} 类：${m.missing.join("、")}。` +
        `材料 8 类齐备后才能开启核销（材料页签可逐类登记）`;
    }
    return null;
  },
  verify_pass(p) {
    const m = materialsStatus(p.id);
    if (!m.ok) return `核销材料缺 ${m.missing.length} 类：${m.missing.join("、")}，补齐后才能核销通过`;
    const v = verification(p.id);
    if (v.judged < v.total) return `还有 ${v.total - v.judged} 步未判定，6 步必须全部判定`;
    if (v.failedSteps.length) return `第 ${v.failedSteps.join("、")} 步不通过，需提交例外单并获批`;
    if (v.openExceptions > 0) return `存在 ${v.openExceptions} 张未审批的例外单`;
    return null;
  },
  settle(p) {
    const v = verification(p.id);
    if (!v.complete) return "核销未通过（6 步未全过或存在未决例外），不能结算";
    if (settlementOf(p.id)) return "结算单已存在，不可重复生成";
    const pending = db
      .prepare("SELECT COUNT(*) AS c FROM payments WHERE pid = ? AND status IN ('待审批','已审批')")
      .get(p.id).c;
    if (pending) return `还有 ${pending} 笔付款未完成（待审批 / 已审批），需先处理完才能结算`;
    if (!isDemoMode()) {
      const paid = db.prepare("SELECT COUNT(*) AS n, COALESCE(SUM(amount),0) AS total FROM payments WHERE pid=? AND status='已付款'").get(p.id);
      if (!paid.n) return "结算前必须先申请付款并由财务完成实际付款，不能跳过付款直接结算";
      const matched = db.prepare("SELECT invoice_amount FROM verify_steps WHERE pid=? AND step_no=6 AND result='通过'").get(p.id);
      if (!matched || !Number.isFinite(matched.invoice_amount))
        return "发票与已签署合同金额尚未完成核对，不允许结算";
      if (cents(paid.total) !== cents(matched.invoice_amount))
        return `实际已付款 ¥${yuan(paid.total)} 与核销确认发票金额 ¥${yuan(matched.invoice_amount)} 不一致，不能结算`;
    }
    return null;
  },
  archive(p) {
    const m = materialsStatus(p.id);
    if (!m.ok) return `归档材料缺 ${m.missing.length} 类：${m.missing.join("、")}`;
    if (!settlementOf(p.id)) return "结算单未生成，不能归档";
    const pending = db
      .prepare("SELECT COUNT(*) AS c FROM payments WHERE pid = ? AND status IN ('待审批','已审批')")
      .get(p.id).c;
    if (pending) return `还有 ${pending} 笔付款未完成，不能归档`;
    return null;
  }
};

/** 当前可执行动作（含不可执行原因），供前端渲染按钮 */
function availableActions(project, user) {
  const out = [];
  for (const f of FLOW) {
    if (f.from !== project.status) continue;
    const roleOk = can(user, f.perm);
    const reason = roleOk ? (GUARDS[f.action] ? GUARDS[f.action](project) : null) : `需要「${permRoleName(f.perm)}」权限`;
    out.push({ action: f.action, label: f.label, to: f.to, enabled: roleOk && !reason, reason: reason || "" });
  }
  if (project.status === "待审批") {
    out.push({
      action: "reject", label: "驳回", to: "草稿",
      enabled: can(user, "project:approve"), reason: can(user, "project:approve") ? "" : "需要「协会管理员」权限"
    });
  }
  return out;
}

function permRoleName(perm) {
  const { PERMS } = require("./rbac");
  const roles = PERMS[perm] || [];
  return roles.map((r) => ROLES[r]?.name || r).join(" / ") || "总管理员";
}

function setStatus(p, to, user, ip, detail) {
  const at = now();
  db.prepare("UPDATE projects SET status = ?, status_at = ?, updated_at = ? WHERE id = ?").run(to, at, at, p.id);
  logAudit({
    user, module: "项目管理", action: "状态流转", target: p.id,
    detail: detail || `${p.status} → ${to}`, ip
  });
}

/**
 * 执行流转
 * @returns {{project:object, message:string}}
 */
function transition(projectId, action, user, payload = {}, ip = "") {
  const p = getProject(projectId);

  if (action === "reject") {
    // 错误码必须和 FLOW 里其它非法跳转一致（ILLEGAL_TRANSITION + allowed 列表），
    // 否则前端要为一个动作单独写分支，code 也失去「可据此判断状态不合法」的意义。
    if (p.status !== "待审批") {
      throw conflict(
        `只有「待审批」的项目可以驳回，当前状态「${p.status}」`,
        "ILLEGAL_TRANSITION",
        { status: p.status, allowed: FLOW.filter((f) => f.from === p.status).map((f) => f.action) }
      );
    }
    if (!can(user, "project:approve")) throw forbidden("需要协会管理员权限");
    const reason = String(payload.comment || "").trim();
    if (!reason) throw bad("驳回必须填写理由");
    db.prepare(
      "UPDATE approvals SET status = '已驳回', decided_by = ?, decided_at = ?, comment = ? WHERE pid = ? AND type = '立项审批' AND status = '待审批'"
    ).run(user.name, now(), reason, p.id);
    setStatus(p, "草稿", user, ip, `立项驳回：${reason}`);
    return { project: getProject(p.id), message: "已驳回，退回草稿" };
  }

  const flow = FLOW.find((f) => f.from === p.status && f.action === action);
  if (!flow) {
    const hint = FLOW.filter((f) => f.from === p.status).map((f) => f.label).join(" / ") || "无";
    throw conflict(`当前状态「${p.status}」不支持该操作，可执行：${hint}`, "ILLEGAL_TRANSITION", {
      status: p.status, allowed: FLOW.filter((f) => f.from === p.status).map((f) => f.action)
    });
  }
  if (!can(user, flow.perm)) throw forbidden(`需要「${permRoleName(flow.perm)}」权限才能${flow.label}`);

  const guardMsg = GUARDS[action] ? GUARDS[action](p) : null;
  if (guardMsg) {
    // 材料门禁单独给一个码：前端要据此把用户引到「材料」页签，而不是笼统的「门禁未通过」
    const code = action === "request_verify" ? "MATERIAL_GATE" : "GATE_BLOCKED";
    throw conflict(guardMsg, code, { action, status: p.status });
  }

  switch (action) {
    case "submit": {
      const at = now();
      const apId = nextId(db, "approvals", "id", "AP");
      db.prepare(
        "INSERT INTO approvals (id,type,title,pid,ref_id,amount,by_user,sla,status,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)"
      ).run(apId, "立项审批", p.name, p.id, p.id, p.budget, p.owner || user.name, "2 个工作日", "待审批", at);
      db.prepare(
        `INSERT OR REPLACE INTO verify_steps (pid, step_no, name, result) VALUES ${VERIFY_STEPS.map(() => "(?,?,?,?)").join(",")}`
      ).run(...VERIFY_STEPS.flatMap((s) => [p.id, s.no, s.name, "待判定"]));
      setStatus(p, "待审批", user, ip, `提交立项，预算 ¥${Number(p.budget).toLocaleString("zh-CN")}，生成审批单 ${apId}`);
      return { project: getProject(p.id), message: `已提交，等待审批（${apId}）` };
    }
    case "approve": {
      const ap = db
        .prepare("SELECT * FROM approvals WHERE pid = ? AND type = '立项审批' AND status = '待审批' ORDER BY created_at DESC")
        .get(p.id);
      if (ap) {
        db.prepare("UPDATE approvals SET status = '已通过', decided_by = ?, decided_at = ?, comment = ? WHERE id = ?")
          .run(user.name, now(), String(payload.comment || "同意立项"), ap.id);
      }
      setStatus(p, "已立项", user, ip, `立项审批通过${ap ? `（${ap.id}）` : ""}${payload.comment ? "：" + payload.comment : ""}`);
      return { project: getProject(p.id), message: "审批通过，状态 → 已立项" };
    }
    case "settle": {
      const at = now();
      /**
       * V1.2.18：结算单必须有收款方与收款账户。
       *
       * 老板 2026-10-28：「生成结算单 / 付款两个功能板块缺少了收款方和银行账号信息」。
       * 结算单原来只有收入 / 支出 / 结余三个数，结余打给谁、打到哪个账户纸上一个字没有，
       * 财务拿到单子还得回头问人。
       *
       * 收款方不传时默认取项目负责人（结余通常归负责人所属协会），
       * 但开户行与账号必须显式填 —— 这个没法猜，猜错就是打错钱。
       */
      const payee = String((payload && payload.payee) || p.owner || "").trim();
      if (!payee) throw bad("结算单收款方为必填项");
      if (payee.length > 60) throw bad("收款方不能超过 60 字");
      const payeeBank = parseBankName(payload && payload.payee_bank, "收款开户行");
      const payeeAccount = parseBankAccount(payload && payload.payee_account, "收款账号");

      // 三个数都必须落在「分」上：140000 - 135580.6 = 4419.399999999994，
      // 不收敛的话结算单 profit 会带着 12 位小数入库，导出 CSV 也是这个数。
      const income = yuan(p.budget);
      const expense = yuan(
        db.prepare("SELECT COALESCE(ROUND(SUM(amount),2),0) AS s FROM payments WHERE pid = ? AND status = '已付款'")
          .get(p.id).s
      );
      const profit = yuan(income - expense);
      const id = nextId(db, "settlements", "id", "ST");
      db.prepare(
        "INSERT INTO settlements (id,pid,income,expense,profit,payee,payee_bank,payee_account,status,created_by,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)"
      ).run(id, p.id, income, expense, profit, payee, payeeBank, payeeAccount, "已生成", user.name, at);
      setStatus(p, "已结算", user, ip,
        `生成结算单 ${id}：收入 ¥${income.toLocaleString("zh-CN")} / 支出 ¥${expense.toLocaleString("zh-CN")} / ` +
        `结余 ¥${profit.toLocaleString("zh-CN")}；收款方 ${payee}（${payeeBank} 尾号 ${payeeAccount.slice(-4)}）`);
      return { project: getProject(p.id), message: `结算单 ${id} 已生成，结论冻结` };
    }
    case "archive": {
      const at = now();
      db.prepare("UPDATE projects SET status = '已归档', status_at = ?, updated_at = ? WHERE id = ?").run(at, at, p.id);
      logAudit({ user, module: "档案中心", action: "归档", target: p.id, detail: "数字卷宗封存，材料 8/8 齐备", ip });
      return { project: getProject(p.id), message: "已归档，卷宗封存" };
    }
    default: {
      setStatus(p, flow.to, user, ip, `${flow.label}：${p.status} → ${flow.to}`);
      // V1.2.17 FLOW-01：核销通过后，同协会的财务必须能直接生成结算单
      if (action === "verify_pass") grantFinanceMember(p, user, ip);
      return { project: getProject(p.id), message: `${flow.label}成功，状态 → ${flow.to}` };
    }
  }
}

/**
 * 核销通过 → 把同协会的财务负责人加进项目成员。
 *
 * 测试报告 FLOW-01：项目 6/6 核销通过后，finance 生成结算单 403「不在你的数据范围内」，
 * 只能让超管代劳或临时加成员 —— 流程在这里断了一刀，规模化后就是一堆「已核销未结算」。
 *
 * 为什么在这一步自动授权：结算单是核销结论的下一步，财务不是「来旁听」的，
 * 是这条流程的下一个责任人。只加同协会的财务（协会管理员看得见范围之外的财务没意义），
 * 且写审计，谁因为什么被授权都能追。
 */
function grantFinanceMember(p, user, ip) {
  // assoc 为空的财务是「全平台财务」（种子里的陈静就是这种），也要覆盖到 ——
  // 只按协会精确匹配会把最常见的配置漏掉，等于没修。
  const financeUsers = db
    .prepare(
      `SELECT id, name FROM users
        WHERE role = 'finance' AND active = 1
          AND (assoc IS NULL OR assoc = '' OR assoc = ?)`
    )
    .all(p.assoc || "");
  if (!financeUsers.length) return;
  const ins = db.prepare("INSERT OR IGNORE INTO project_members (project_id, user_id, role) VALUES (?,?,?)");
  const added = [];
  for (const f of financeUsers) {
    const r = ins.run(p.id, f.id, "成员");
    if (r.changes) added.push(f.name);
  }
  if (!added.length) return;
  logAudit({
    user, module: "会后核销", action: "自动授权财务", target: p.id,
    detail: `核销通过，将 ${added.join("、")} 加入项目成员以便生成结算单`, ip
  });
}

module.exports = { getProject, verification, materialsStatus, settlementOf, demandSummary, assertNotFrozen, committed, availableActions, transition, GUARDS };
