"use strict";
const { db } = require("../lib/db");
const { now, nextId, bad, notFound, conflict, forbidden } = require("../lib/util");
const { assertCan, assertProjectVisible, scopeFilter, can } = require("../lib/rbac");
const { logAudit } = require("../lib/audit");
const { getProject, verification } = require("../lib/workflow");
const { PAYMENT_TYPES } = require("../lib/constants");
const { transition } = require("../lib/workflow");

const PAYABLE_STATUS = ["已核销", "已结算", "已归档"];

function register(router) {
  /* ---------------- 合同 ---------------- */
  router.get("/api/contracts", async (ctx) => {
    const { sql, params } = scopeFilter(ctx.user);
    const rows = db.prepare(
      `SELECT c.*, p.name AS pname FROM contracts c JOIN projects p ON p.id = c.pid
       WHERE ${sql} ${ctx.query.pid ? "AND c.pid = ?" : ""} ORDER BY c.id DESC`
    ).all(...params, ...(ctx.query.pid ? [ctx.query.pid] : []));
    return { rows };
  });

  router.post("/api/contracts", async (ctx) => {
    const b = ctx.body || {};
    const p = getProject(b.pid);
    assertProjectVisible(ctx.user, p);
    assertCan(ctx.user, "contract:write", "当前角色无合同录入权限");
    if (!String(b.name || "").trim()) throw bad("合同名称为必填项");
    if (!String(b.vendor || "").trim()) throw bad("签约方为必填项");
    if (!(Number(b.amount) > 0)) throw bad("合同金额必须大于 0");
    const id = nextId(db, "contracts", "id", "HT");
    db.prepare("INSERT INTO contracts (id,pid,name,vendor,amount,sign_date,status,remark,created_by,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)")
      .run(id, p.id, b.name, b.vendor, Number(b.amount), b.sign_date || "", b.status || "草稿", b.remark || "", ctx.user.id, now());
    logAudit({ user: ctx.user, module: "筹备管理", action: "合同录入", target: p.id, detail: `${id} ${b.name} / ${b.vendor} / ¥${Number(b.amount).toLocaleString("zh-CN")}`, ip: ctx.ip });
    return { contract: db.prepare("SELECT * FROM contracts WHERE id = ?").get(id), message: `合同 ${id} 已保存` };
  });

  /* ---------------- 付款 ---------------- */
  router.get("/api/payments", async (ctx) => {
    const { sql, params } = scopeFilter(ctx.user);
    const where = [sql];
    const args = [...params];
    if (ctx.query.status) { where.push("y.status = ?"); args.push(ctx.query.status); }
    if (ctx.query.pid) { where.push("y.pid = ?"); args.push(ctx.query.pid); }
    const rows = db.prepare(
      `SELECT y.*, p.name AS pname, p.status AS pstatus FROM payments y JOIN projects p ON p.id = y.pid
       WHERE ${where.join(" AND ")} ORDER BY y.created_at DESC, y.id DESC`
    ).all(...args);
    return { rows, summary: {
      total: rows.length,
      amount: rows.reduce((s, r) => s + r.amount, 0),
      pending: rows.filter((r) => r.status === "待审批").length
    } };
  });

  /** 付款申请 —— 核销是唯一前置门 */
  router.post("/api/payments", async (ctx) => {
    const b = ctx.body || {};
    const p = getProject(b.pid);
    assertProjectVisible(ctx.user, p);
    assertCan(ctx.user, "payment:create", "当前角色无付款申请权限");
    if (!PAYMENT_TYPES.includes(b.type)) throw bad(`付款类型必须是：${PAYMENT_TYPES.join(" / ")}`);
    if (!String(b.payee || "").trim()) throw bad("收款方为必填项");
    if (!(Number(b.amount) > 0)) throw bad("付款金额必须大于 0");
    if (p.status === "已归档") {
      throw conflict("项目已归档，数字卷宗已封存，不可再新增付款", "ARCHIVED", { status: p.status });
    }
    if (!PAYABLE_STATUS.includes(p.status)) {
      throw conflict(
        `付款被拦截：项目「${p.name}」当前状态为「${p.status}」，按制度必须先完成 6 步核销并通过（已核销）才可付款`,
        "VERIFY_GATE",
        { status: p.status, verify: verification(p.id).judged + "/6" }
      );
    }
    const at = now();
    const id = nextId(db, "payments", "id", "PY");
    db.prepare("INSERT INTO payments (id,pid,type,payee,amount,invoice_no,req_user,status,remark,created_by,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
      .run(id, p.id, b.type, b.payee, Number(b.amount), b.invoice_no || "", ctx.user.name, "待审批", b.remark || "", ctx.user.id, at);
    const apId = nextId(db, "approvals", "id", "AP");
    db.prepare("INSERT INTO approvals (id,type,title,pid,ref_id,amount,by_user,sla,status,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)")
      .run(apId, "付款审批", `${b.type} ¥${Number(b.amount).toLocaleString("zh-CN")}`, p.id, id, Number(b.amount), ctx.user.name, "1 个工作日", "待审批", at);
    logAudit({ user: ctx.user, module: "财务结算", action: "付款申请", target: p.id, detail: `${id} ${b.type} ¥${Number(b.amount).toLocaleString("zh-CN")} → ${b.payee}（核销已通过）`, ip: ctx.ip });
    return { payment: db.prepare("SELECT * FROM payments WHERE id = ?").get(id), message: `付款申请 ${id} 已提交，等待财务审批` };
  });

  router.post("/api/payments/:id/approve", async (ctx) => {
    const y = db.prepare("SELECT * FROM payments WHERE id = ?").get(ctx.params.id);
    if (!y) throw notFound("付款单不存在");
    const p = getProject(y.pid);
    assertProjectVisible(ctx.user, p);
    assertCan(ctx.user, "payment:approve", "只有财务与核销（或总管理员）可以审批付款");
    if (y.status !== "待审批") throw conflict(`付款单已是「${y.status}」状态`);
    const approve = ctx.body?.approve !== false;
    const st = approve ? "已审批" : "已驳回";
    db.prepare("UPDATE payments SET status = ? WHERE id = ?").run(st, y.id);
    db.prepare("UPDATE approvals SET status = ?, decided_by = ?, decided_at = ?, comment = ? WHERE ref_id = ? AND type = '付款审批' AND status = '待审批'")
      .run(approve ? "已通过" : "已驳回", ctx.user.name, now(), String(ctx.body?.comment || ""), y.id);
    logAudit({ user: ctx.user, module: "财务结算", action: approve ? "付款审批通过" : "付款驳回", target: p.id, detail: `${y.id} ¥${Number(y.amount).toLocaleString("zh-CN")}`, ip: ctx.ip });
    return { payment: db.prepare("SELECT * FROM payments WHERE id = ?").get(y.id), message: `付款单 ${y.id} ${st}` };
  });

  router.post("/api/payments/:id/pay", async (ctx) => {
    const y = db.prepare("SELECT * FROM payments WHERE id = ?").get(ctx.params.id);
    if (!y) throw notFound("付款单不存在");
    const p = getProject(y.pid);
    assertProjectVisible(ctx.user, p);
    assertCan(ctx.user, "payment:pay", "只有财务与核销（或总管理员）可以执行付款");
    if (y.status !== "已审批") throw conflict(`只有「已审批」的付款单可以付款，当前为「${y.status}」`);
    if (!PAYABLE_STATUS.includes(p.status)) throw conflict("项目核销状态异常，付款已拦截", "VERIFY_GATE");
    db.prepare("UPDATE payments SET status = '已付款', paid_at = ? WHERE id = ?").run(now(), y.id);
    logAudit({ user: ctx.user, module: "财务结算", action: "付款", target: p.id, detail: `${y.id} ${y.type} ¥${Number(y.amount).toLocaleString("zh-CN")} 已提交银行`, ip: ctx.ip });
    return { payment: db.prepare("SELECT * FROM payments WHERE id = ?").get(y.id), message: `${y.id} 已付款` };
  });

  /* ---------------- 审批中心 ---------------- */
  router.get("/api/approvals", async (ctx) => {
    const { sql, params } = scopeFilter(ctx.user);
    const where = [sql];
    const args = [...params];
    if (ctx.query.status) { where.push("a.status = ?"); args.push(ctx.query.status); }
    if (ctx.query.type) { where.push("a.type = ?"); args.push(ctx.query.type); }
    const rows = db.prepare(
      `SELECT a.*, p.name AS pname FROM approvals a LEFT JOIN projects p ON p.id = a.pid
       WHERE ${where.join(" AND ")} ORDER BY CASE a.status WHEN '待审批' THEN 0 ELSE 1 END, a.created_at DESC`
    ).all(...args);
    return { rows, pending: rows.filter((r) => r.status === "待审批").length };
  });

  /** 统一审批入口：按 type 分派 */
  router.post("/api/approvals/:id/decide", async (ctx) => {
    const a = db.prepare("SELECT * FROM approvals WHERE id = ?").get(ctx.params.id);
    if (!a) throw notFound("审批单不存在");
    if (a.status !== "待审批") throw conflict(`该审批单已是「${a.status}」状态`);
    const p = getProject(a.pid);
    assertProjectVisible(ctx.user, p);
    const approve = ctx.body?.approve !== false;
    const comment = String(ctx.body?.comment || "");

    if (a.type === "立项审批") {
      if (!can(ctx.user, "project:approve")) throw forbidden("只有协会管理员（或总管理员）可以审批立项");
      const r = transition(p.id, approve ? "approve" : "reject", ctx.user, { comment }, ctx.ip);
      return { message: r.message, project: r.project };
    }
    if (a.type === "例外单审批") {
      if (!can(ctx.user, "verify:exception_approve")) throw forbidden("只有财务与核销（或总管理员）可以审批例外单");
      const ex = db.prepare("SELECT * FROM exceptions WHERE id = ?").get(a.ref_id);
      if (!ex) throw notFound("例外单不存在");
      const at = now();
      db.prepare("UPDATE exceptions SET status = ?, approved_by = ?, approved_at = ?, comment = ? WHERE id = ?")
        .run(approve ? "已通过" : "已驳回", ctx.user.name, at, comment, ex.id);
      db.prepare("UPDATE approvals SET status = ?, decided_by = ?, decided_at = ?, comment = ? WHERE id = ?")
        .run(approve ? "已通过" : "已驳回", ctx.user.name, at, comment, a.id);
      db.prepare("UPDATE verify_steps SET result = ?, remark = ?, checked_by = ?, checked_at = ? WHERE pid = ? AND step_no = ?")
        .run(approve ? "已解例外" : "不通过", approve ? `例外获批：${ex.reason}` : `例外被驳回：${ex.reason}`, ctx.user.name, at, ex.pid, ex.step_no);
      logAudit({ user: ctx.user, module: "会后核销", action: approve ? "例外通过" : "例外驳回", target: ex.pid, detail: `${ex.id} 第 ${ex.step_no} 步：${ex.reason}`, ip: ctx.ip });
      return { message: `例外单 ${ex.id} ${approve ? "已通过" : "已驳回"}`, verification: verification(ex.pid) };
    }
    if (a.type === "付款审批") {
      if (!can(ctx.user, "payment:approve")) throw forbidden("只有财务与核销（或总管理员）可以审批付款");
      const y = db.prepare("SELECT * FROM payments WHERE id = ?").get(a.ref_id);
      if (!y) throw notFound("付款单不存在");
      db.prepare("UPDATE payments SET status = ? WHERE id = ?").run(approve ? "已审批" : "已驳回", y.id);
      db.prepare("UPDATE approvals SET status = ?, decided_by = ?, decided_at = ?, comment = ? WHERE id = ?")
        .run(approve ? "已通过" : "已驳回", ctx.user.name, now(), comment, a.id);
      logAudit({ user: ctx.user, module: "财务结算", action: approve ? "付款审批通过" : "付款驳回", target: p.id, detail: `${y.id} ¥${Number(y.amount).toLocaleString("zh-CN")}`, ip: ctx.ip });
      return { message: `付款单 ${y.id} ${approve ? "已审批" : "已驳回"}` };
    }
    // 变更审批等
    db.prepare("UPDATE approvals SET status = ?, decided_by = ?, decided_at = ?, comment = ? WHERE id = ?")
      .run(approve ? "已通过" : "已驳回", ctx.user.name, now(), comment, a.id);
    logAudit({ user: ctx.user, module: "项目管理", action: approve ? "审批通过" : "审批驳回", target: p.id, detail: `${a.type}：${a.title}`, ip: ctx.ip });
    return { message: `${a.type} ${approve ? "已通过" : "已驳回"}` };
  });

  /** 变更申请 */
  router.post("/api/projects/:id/change", async (ctx) => {
    const p = getProject(ctx.params.id);
    assertProjectVisible(ctx.user, p);
    if (!["已立项", "筹备中", "执行中"].includes(p.status)) throw conflict(`「${p.status}」项目不可提交变更`);
    const title = String(ctx.body?.title || "").trim();
    if (!title) throw bad("请填写变更内容");
    const id = nextId(db, "approvals", "id", "AP");
    db.prepare("INSERT INTO approvals (id,type,title,pid,ref_id,amount,by_user,sla,status,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)")
      .run(id, "变更审批", title, p.id, p.id, 0, ctx.user.name, "2 个工作日", "待审批", now());
    logAudit({ user: ctx.user, module: "项目管理", action: "变更申请", target: p.id, detail: title, ip: ctx.ip });
    return { message: `变更申请 ${id} 已提交` };
  });

  return router;
}

module.exports = { register, PAYABLE_STATUS };
