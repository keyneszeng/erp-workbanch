"use strict";
const { db } = require("../lib/db");
const { now, nextId, bad, notFound, conflict, forbidden } = require("../lib/util");
const { assertCan, assertProjectVisible, scopeFilter, can, isSuper } = require("../lib/rbac");
const { logAudit } = require("../lib/audit");
const { getProject, verification } = require("../lib/workflow");
const { PAYMENT_TYPES } = require("../lib/constants");
const { readPaging, countOf } = require("../lib/paginate");
const { transition } = require("../lib/workflow");

// 只有「已核销」可新增付款：结算后账目已封账，归档后卷宗已封存，均不得再挂账
const PAYABLE_STATUS = ["已核销"];

/** 与 server/api/files.js 生成的 key 格式保持一致，避免任意字符串被写进 file_key */
const FILE_KEY_RE = /^[a-f0-9]{32}\.(jpg|png|webp|gif|pdf)$/;

/** 已占用预算：待审批 + 已审批 + 已付款（驳回的不占） */
function committed(pid) {
  return Number(db.prepare(
    "SELECT COALESCE(SUM(amount),0) AS s FROM payments WHERE pid = ? AND status IN ('待审批','已审批','已付款')"
  ).get(pid).s) || 0;
}

function register(router) {
  /* ---------------- 合同 ---------------- */
  router.get("/api/contracts", async (ctx) => {
    const { sql, params } = scopeFilter(ctx.user);
    const where = [sql];
    const args = [...params];
    if (ctx.query.pid) { where.push("c.pid = ?"); args.push(ctx.query.pid); }
    const whereSql = where.join(" AND ");
    const base = `FROM contracts c JOIN projects p ON p.id = c.pid WHERE ${whereSql}`;
    const paging = readPaging(ctx.query);

    if (!paging) {
      const rows = db.prepare(`SELECT c.*, p.name AS pname ${base} ORDER BY c.id DESC`).all(...args);
      return { rows, total: rows.length };
    }
    const total = countOf(db.prepare(`SELECT COUNT(*) AS c ${base}`).get(...args));
    const rows = db.prepare(
      `SELECT c.*, p.name AS pname ${base} ORDER BY c.id DESC LIMIT ? OFFSET ?`
    ).all(...args, paging.size, paging.offset);
    return { rows, total, page: paging.page, size: paging.size, pages: Math.max(1, Math.ceil(total / paging.size)), paged: true };
  });

  router.post("/api/contracts", async (ctx) => {
    const b = ctx.body || {};
    const p = getProject(b.pid);
    assertProjectVisible(ctx.user, p);
    assertCan(ctx.user, "contract:write", "当前角色无合同录入权限");
    if (p.status === "已归档") throw conflict("项目已归档，合同台账已封存，不可再录入合同", "ARCHIVED", { status: p.status });
    if (p.status === "已结算") throw conflict("项目已结算，合同台账已封账，不可再录入合同", "FROZEN", { status: p.status });
    if (!String(b.name || "").trim()) throw bad("合同名称为必填项");
    if (String(b.name).length > 80) throw bad("合同名称不能超过 80 字");
    if (!String(b.vendor || "").trim()) throw bad("签约方为必填项");
    if (String(b.vendor).length > 80) throw bad("签约方不能超过 80 字");
    const amount = Number(b.amount);
    if (!Number.isFinite(amount) || !(amount > 0)) throw bad("合同金额必须大于 0");
    if (amount > 1e9) throw bad("合同金额不能超过 10 亿元");
    if (Number(amount.toFixed(2)) !== amount) throw bad("合同金额最多保留两位小数");

    // 合同原件（扫描件 PDF / 拍照件）：只接受上传接口发下来的 key 格式，
    // 防止把任意字符串写进 file_key 后拼到下载 URL 上。
    let fk = null, fname = null, fsize = null, fmime = null;
    if (b.file_key) {
      if (!FILE_KEY_RE.test(String(b.file_key))) throw bad("附件标识不合法");
      fk = String(b.file_key);
      fname = String(b.file_name || "").slice(0, 120) || fk;
      fsize = Number(b.file_size) || null;
      fmime = String(b.file_mime || "").slice(0, 60) || null;
    }

    const id = nextId(db, "contracts", "id", "HT");
    db.prepare("INSERT INTO contracts (id,pid,name,vendor,amount,sign_date,status,remark,created_by,created_at,file_key,file_name,file_size,file_mime) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
      .run(id, p.id, b.name, b.vendor, amount, b.sign_date || "", b.status || "草稿", b.remark || "", ctx.user.id, now(), fk, fname, fsize, fmime);
    logAudit({
      user: ctx.user, module: "筹备管理", action: "合同录入", target: p.id,
      detail: `${id} ${b.name} / ${b.vendor} / ¥${amount.toLocaleString("zh-CN")}${fk ? "（含原件）" : ""}`, ip: ctx.ip
    });
    return { contract: db.prepare("SELECT * FROM contracts WHERE id = ?").get(id), message: `合同 ${id} 已保存` };
  });

  /* ---------------- 付款 ---------------- */
  router.get("/api/payments", async (ctx) => {
    const { sql, params } = scopeFilter(ctx.user);
    const where = [sql];
    const args = [...params];
    if (ctx.query.status) { where.push("y.status = ?"); args.push(ctx.query.status); }
    if (ctx.query.pid) { where.push("y.pid = ?"); args.push(ctx.query.pid); }
    const whereSql = where.join(" AND ");
    const base = `FROM payments y JOIN projects p ON p.id = y.pid WHERE ${whereSql}`;
    const paging = readPaging(ctx.query);

    let rows;
    let total;
    if (paging) {
      total = countOf(db.prepare(`SELECT COUNT(*) AS c ${base}`).get(...args));
      rows = db.prepare(
        `SELECT y.*, p.name AS pname, p.status AS pstatus ${base} ORDER BY y.created_at DESC, y.id DESC LIMIT ? OFFSET ?`
      ).all(...args, paging.size, paging.offset);
    } else {
      rows = db.prepare(
        `SELECT y.*, p.name AS pname, p.status AS pstatus ${base} ORDER BY y.created_at DESC, y.id DESC`
      ).all(...args);
      total = rows.length;
    }

    // 汇总必须独立聚合：拿当前页的 rows 去 reduce，分页后金额就只剩一页的数
    const agg = db.prepare(
      `SELECT COUNT(*) AS n,
              COALESCE(SUM(y.amount),0) AS s,
              COALESCE(SUM(CASE WHEN y.status = '待审批' THEN 1 ELSE 0 END),0) AS n_pending,
              COALESCE(SUM(CASE WHEN y.status = '已审批' THEN 1 ELSE 0 END),0) AS n_approved,
              COALESCE(SUM(CASE WHEN y.status = '已付款' THEN 1 ELSE 0 END),0) AS n_paid,
              COALESCE(SUM(CASE WHEN y.status = '待审批' THEN y.amount ELSE 0 END),0) AS a_pending,
              COALESCE(SUM(CASE WHEN y.status = '已审批' THEN y.amount ELSE 0 END),0) AS a_approved,
              COALESCE(SUM(CASE WHEN y.status = '已付款' THEN y.amount ELSE 0 END),0) AS a_paid
       ${base}`
    ).get(...args);

    return {
      rows,
      total,
      page: paging ? paging.page : 1,
      size: paging ? paging.size : total,
      pages: paging ? Math.max(1, Math.ceil(total / paging.size)) : 1,
      paged: !!paging,
      summary: {
        total: Number(agg.n) || 0,
        amount: Number(agg.s) || 0,
        pending: Number(agg.n_pending) || 0,
        approved: Number(agg.n_approved) || 0,
        paid: Number(agg.n_paid) || 0,
        pendingAmount: Number(agg.a_pending) || 0,
        approvedAmount: Number(agg.a_approved) || 0,
        paidAmount: Number(agg.a_paid) || 0
      }
    };
  });

  /** 付款申请 —— 核销是唯一前置门 */
  router.post("/api/payments", async (ctx) => {
    const b = ctx.body || {};
    const p = getProject(b.pid);
    assertProjectVisible(ctx.user, p);
    assertCan(ctx.user, "payment:create", "当前角色无付款申请权限");
    if (!PAYMENT_TYPES.includes(b.type)) throw bad(`付款类型必须是：${PAYMENT_TYPES.join(" / ")}`);
    if (!String(b.payee || "").trim()) throw bad("收款方为必填项");
    const amount = Number(b.amount);
    if (!Number.isFinite(amount) || !(amount > 0)) throw bad("付款金额必须大于 0");
    if (amount > 1e9) throw bad("单笔付款金额不能超过 10 亿元");
    if (Number(amount.toFixed(2)) !== amount) throw bad("付款金额最多保留两位小数（精确到分）");
    if (p.status === "已归档") {
      throw conflict("项目已归档，数字卷宗已封存，不可再新增付款", "ARCHIVED", { status: p.status });
    }
    if (p.status === "已结算") {
      throw conflict("项目已生成结算单，账目已封账，不可再新增付款（如需补付请走线下流程并说明）", "SETTLED", { status: p.status });
    }
    if (!PAYABLE_STATUS.includes(p.status)) {
      throw conflict(
        `付款被拦截：项目「${p.name}」当前状态为「${p.status}」，按制度必须先完成 6 步核销并通过（已核销）才可付款`,
        "VERIFY_GATE",
        { status: p.status, verify: verification(p.id).judged + "/6" }
      );
    }
    // 超预算硬门禁：总管理员可显式 force 特批
    const used = committed(p.id);
    const budget = Number(p.budget) || 0;
    const force = !!b.force && isSuper(ctx.user);
    if (!force && used + amount > budget) {
      throw conflict(
        `付款被拦截：项目预算 ¥${budget.toLocaleString("zh-CN")}，已占用 ¥${used.toLocaleString("zh-CN")}，` +
        `本笔 ¥${amount.toLocaleString("zh-CN")} 将超预算 ¥${(used + amount - budget).toLocaleString("zh-CN")}；` +
        `如需特批请由总管理员携带 force 标记提交`,
        "OVER_BUDGET",
        { budget, used, amount, over: used + amount - budget }
      );
    }
    const at = now();
    const id = nextId(db, "payments", "id", "PY");
    db.prepare("INSERT INTO payments (id,pid,type,payee,amount,invoice_no,req_user,status,remark,created_by,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
      .run(id, p.id, b.type, b.payee, amount, b.invoice_no || "", ctx.user.name, "待审批", b.remark || "", ctx.user.id, at);
    const apId = nextId(db, "approvals", "id", "AP");
    db.prepare("INSERT INTO approvals (id,type,title,pid,ref_id,amount,by_user,sla,status,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)")
      .run(apId, "付款审批", `${b.type} ¥${amount.toLocaleString("zh-CN")}`, p.id, id, amount, ctx.user.name, "1 个工作日", "待审批", at);
    logAudit({
      user: ctx.user, module: "财务结算", action: "付款申请", target: p.id,
      detail: `${id} ${b.type} ¥${amount.toLocaleString("zh-CN")} → ${b.payee}（核销已通过${force ? "；超预算特批" : ""}）`,
      ip: ctx.ip
    });
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
