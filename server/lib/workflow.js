"use strict";
const { db } = require("./db");
const { now, nextId, conflict, forbidden, notFound, bad } = require("./util");
const { can, isSuper, ROLES } = require("./rbac");
const { logAudit } = require("./audit");
const { FLOW, VERIFY_STEPS, MATERIAL_KINDS } = require("./constants");

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
  return Number(db.prepare(
    "SELECT COALESCE(SUM(amount),0) AS s FROM payments WHERE pid = ? AND status IN ('待审批','已审批','已付款')"
  ).get(pid).s) || 0;
}

/** 门禁：所有前置条件 */
const GUARDS = {
  submit(p) {
    if (!p.agenda || String(p.agenda).trim().length < 4) return "立项必须填写初版议程要点";
    if (!(p.budget > 0)) return "预算必须大于 0";
    return null;
  },
  verify_pass(p) {
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
    if (p.status !== "待审批") throw conflict("只有「待审批」的项目可以驳回");
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
  if (guardMsg) throw conflict(guardMsg, "GATE_BLOCKED", { action, status: p.status });

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
      const income = Number(p.budget) || 0;
      const expense = db
        .prepare("SELECT COALESCE(SUM(amount),0) AS s FROM payments WHERE pid = ? AND status = '已付款'")
        .get(p.id).s;
      const id = nextId(db, "settlements", "id", "ST");
      db.prepare(
        "INSERT INTO settlements (id,pid,income,expense,profit,status,created_by,created_at) VALUES (?,?,?,?,?,?,?,?)"
      ).run(id, p.id, income, expense, income - expense, "已生成", user.name, at);
      setStatus(p, "已结算", user, ip, `生成结算单 ${id}：收入 ¥${income.toLocaleString("zh-CN")} / 支出 ¥${Number(expense).toLocaleString("zh-CN")} / 结余 ¥${(income - expense).toLocaleString("zh-CN")}`);
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
      return { project: getProject(p.id), message: `${flow.label}成功，状态 → ${flow.to}` };
    }
  }
}

module.exports = { getProject, verification, materialsStatus, settlementOf, assertNotFrozen, committed, availableActions, transition, GUARDS };
