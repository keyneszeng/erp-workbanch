"use strict";
const { db } = require("../lib/db");
const { now, today, nextId, bad, notFound, conflict, forbidden, cents, yuan } = require("../lib/util");
const { assertCan, assertProjectVisible, scopeFilter, can, isSuper } = require("../lib/rbac");
const { logAudit } = require("../lib/audit");
const { getProject, verification, committed } = require("../lib/workflow");
const { PAYMENT_TYPES, CONTRACT_CATEGORIES, guessContractCategory } = require("../lib/constants");
const { readPaging, countOf } = require("../lib/paginate");
const { transition } = require("../lib/workflow");

// 只有「已核销」可新增付款：结算后账目已封账，归档后卷宗已封存，均不得再挂账
const PAYABLE_STATUS = ["已核销"];

/** 与 server/api/files.js 生成的 key 格式保持一致，避免任意字符串被写进 file_key */
const FILE_KEY_RE = /^[a-f0-9]{32}\.(jpg|png|webp|gif|pdf)$/;

/**
 * 合同状态白名单。
 * 前端录入弹窗只给这三个选项，台账 KPI「已签署金额」也按 "已签署" 精确匹配，
 * 后端不校验的话，任意字符串都能进库 —— 既不进任何统计，也会渲染成未知色标签。
 */
const CONTRACT_STATUS = ["草稿", "待签署", "已签署"];

/** 合同文本字段长度上限，防止超长内容撑爆台账与 CSV 导出 */
const CONTRACT_MAX = { name: 80, vendor: 80, remark: 500, sign_date: 10 };

/** 校验 YYYY-MM-DD 且必须是真实存在的日期（2026-02-30 这类要拦掉） */
function checkDate(s, label) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) throw bad(`${label}格式应为 YYYY-MM-DD`);
  const d = new Date(`${s}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== s) throw bad(`${label} ${s} 不是有效日期`);
}

/** 已占用预算：待审批 + 已审批 + 已付款（驳回的不占） */
// 实现已上移到 lib/workflow.js —— 改预算与付款申请必须共用同一套口径

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
    if (String(b.name).length > CONTRACT_MAX.name) throw bad(`合同名称不能超过 ${CONTRACT_MAX.name} 字`);
    if (!String(b.vendor || "").trim()) throw bad("签约方为必填项");
    if (String(b.vendor).length > CONTRACT_MAX.vendor) throw bad(`签约方不能超过 ${CONTRACT_MAX.vendor} 字`);
    const amount = Number(b.amount);
    if (!Number.isFinite(amount) || !(amount > 0)) throw bad("合同金额必须大于 0");
    if (amount > 1e9) throw bad("合同金额不能超过 10 亿元");
    if (Number(amount.toFixed(2)) !== amount) throw bad("合同金额最多保留两位小数");

    // 状态必须是白名单内的值，否则「已签署金额」KPI 会漏算，badge 也会渲染成未知态
    const st = String(b.status || "草稿").trim();
    if (!CONTRACT_STATUS.includes(st)) throw bad(`合同状态必须是：${CONTRACT_STATUS.join(" / ")}`);

    // 签署日期可以为空（草稿尚未签），一旦填了就必须是合法日期
    const signDate = String(b.sign_date || "").trim();
    if (signDate) checkDate(signDate, "签署日期");
    // 「已签署」却拿不出签署日期，是台账里最常见的脏数据：核销第 6 步要拿签署日期对发票，
    // 到时候只能靠人回忆。宁可这里拒掉，让人补一个日期。
    if (st === "已签署" && !signDate) throw bad("状态为「已签署」时必须填写签署日期（不确定可先存为「待签署」）");

    const remark = String(b.remark || "");
    if (remark.length > CONTRACT_MAX.remark) throw bad(`备注不能超过 ${CONTRACT_MAX.remark} 字`);

    // 合同类别：决定核销第 5 步「劳务与专家费核对」列出哪几份。
    // 不强制选 —— 填表时硬猜类别只会逼人随便选一个；没选就按名称推断，之后可在台账改。
    let category = String(b.category || "").trim();
    if (category && !CONTRACT_CATEGORIES.includes(category)) {
      throw bad(`合同类别必须是：${CONTRACT_CATEGORIES.join(" / ")}`);
    }
    if (!category) category = guessContractCategory(b.name);

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
    db.prepare("INSERT INTO contracts (id,pid,name,vendor,amount,sign_date,status,category,remark,created_by,created_at,file_key,file_name,file_size,file_mime) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
      .run(id, p.id, b.name, b.vendor, amount, signDate, st, category, remark, ctx.user.id, now(), fk, fname, fsize, fmime);
    logAudit({
      user: ctx.user, module: "筹备管理", action: "合同录入", target: p.id,
      detail: `${id} ${b.name} / ${b.vendor} / ${category} / ¥${amount.toLocaleString("zh-CN")}${fk ? "（含原件）" : ""}`, ip: ctx.ip
    });

    // 合同总额超预算是要预警的业务事实（不是错误，可能确需超支）。
    // 硬拦会让人没法录真实合同，所以只回一个 warning 让前端提示，不阻断。
    const contractSum = Number(db.prepare("SELECT COALESCE(SUM(amount),0) AS s FROM contracts WHERE pid = ?").get(p.id).s) || 0;
    const budget = Number(p.budget) || 0;
    let warning = "";
    if (budget > 0 && contractSum > budget) {
      warning = `合同总额 ¥${contractSum.toLocaleString("zh-CN")} 已超项目预算 ¥${budget.toLocaleString("zh-CN")} ` +
        `¥${(contractSum - budget).toLocaleString("zh-CN")}，请确认是否需要走变更审批`;
    }

    return {
      contract: db.prepare("SELECT * FROM contracts WHERE id = ?").get(id),
      message: `合同 ${id} 已保存`,
      warning
    };
  });

  /**
   * 合同状态流转：草稿 → 待签署 → 已签署。
   *
   * 老板 2026-10-27 拍板要「提交签署 → 确认签署」两步。原来状态只能录入时选一次，
   * 之后再也改不了 —— 合同签没签只能靠人记，台账上的「已签署金额」也就没法信。
   *
   * 两步分给两个权限：
   *   提交签署 contract:write（协会 / 执行，录入人自己提交）
   *   确认签署 contract:approve（协会管理员，代表协会落章）
   * 这样「谁提交的、谁确认的」在审计里分得清，也符合合同的实际流程。
   */
  const CONTRACT_FLOW = [
    { from: "草稿", action: "submit", to: "待签署", label: "提交签署", perm: "contract:write" },
    { from: "待签署", action: "sign", to: "已签署", label: "确认签署", perm: "contract:approve" }
  ];

  router.post("/api/contracts/:id/transition", async (ctx) => {
    const c = db.prepare("SELECT * FROM contracts WHERE id = ?").get(ctx.params.id);
    if (!c) throw notFound("合同不存在");
    const p = getProject(c.pid);
    assertProjectVisible(ctx.user, p);
    if (["已结算", "已归档"].includes(p.status)) {
      throw conflict(`项目已「${p.status}」，合同台账已封存，不可再流转状态`, "FROZEN", { status: p.status });
    }

    const action = String(ctx.body?.action || "").trim();
    const flow = CONTRACT_FLOW.find((f) => f.from === c.status && f.action === action);
    if (!flow) {
      const allowed = CONTRACT_FLOW.filter((f) => f.from === c.status).map((f) => f.action);
      throw conflict(
        allowed.length
          ? `合同 ${c.id} 当前是「${c.status}」，不能执行该操作；可执行：${CONTRACT_FLOW.filter((f) => f.from === c.status).map((f) => f.label).join(" / ")}`
          : `合同 ${c.id} 已是「${c.status}」，没有可继续的流转`,
        "ILLEGAL_TRANSITION", { status: c.status, allowed }
      );
    }
    assertCan(ctx.user, flow.perm, `需要「${flow.perm === "contract:approve" ? "协会管理员" : "合同录入"}」权限才能${flow.label}`);

    // 确认签署时补签署日期（默认今天），这样台账上的日期一定来自「确认」这个动作
    let signDate = null;
    if (action === "sign") {
      signDate = String(ctx.body?.sign_date || today()).trim();
      checkDate(signDate, "签署日期");
    }

    db.prepare("UPDATE contracts SET status = ?, sign_date = COALESCE(?, sign_date) WHERE id = ?")
      .run(flow.to, signDate, c.id);
    logAudit({
      user: ctx.user, module: "筹备管理", action: flow.label, target: p.id,
      detail: `${c.id} ${c.name}：${c.status} → ${flow.to}${signDate ? `（签署日期 ${signDate}）` : ""}`, ip: ctx.ip
    });
    return {
      contract: db.prepare("SELECT * FROM contracts WHERE id = ?").get(c.id),
      message: `合同 ${c.id} ${flow.label}成功，状态 → ${flow.to}`
    };
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
    // 金额一律 ROUND(...,2)，否则合计会带 3580.2300000000005 这种浮点尾巴
    const agg = db.prepare(
      `SELECT COUNT(*) AS n,
              COALESCE(ROUND(SUM(y.amount),2),0) AS s,
              COALESCE(SUM(CASE WHEN y.status = '待审批' THEN 1 ELSE 0 END),0) AS n_pending,
              COALESCE(SUM(CASE WHEN y.status = '已审批' THEN 1 ELSE 0 END),0) AS n_approved,
              COALESCE(SUM(CASE WHEN y.status = '已付款' THEN 1 ELSE 0 END),0) AS n_paid,
              COALESCE(ROUND(SUM(CASE WHEN y.status = '待审批' THEN y.amount ELSE 0 END),2),0) AS a_pending,
              COALESCE(ROUND(SUM(CASE WHEN y.status = '已审批' THEN y.amount ELSE 0 END),2),0) AS a_approved,
              COALESCE(ROUND(SUM(CASE WHEN y.status = '已付款' THEN y.amount ELSE 0 END),2),0) AS a_paid
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
    const payee = String(b.payee || "").trim();
    if (!payee) throw bad("收款方为必填项");
    if (payee.length > 60) throw bad("收款方不能超过 60 字");
    const invoiceNo = String(b.invoice_no || "").trim();
    if (invoiceNo.length > 40) throw bad("发票号不能超过 40 字");
    const remark = String(b.remark || "");
    if (remark.length > 300) throw bad("付款说明不能超过 300 字");
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
    // 比较走「分」，否则 2789.69 + 2600.09 = 5389.780000000001 > 预算 5389.78，
    // 明明正好用尽却报「超预算 ¥0.0000000000000009」。
    const used = committed(p.id);
    const budget = yuan(p.budget);
    const force = !!b.force && isSuper(ctx.user);
    const overCents = cents(used) + cents(amount) - cents(budget);
    if (!force && overCents > 0) {
      const over = overCents / 100;
      throw conflict(
        `付款被拦截：项目预算 ¥${budget.toLocaleString("zh-CN")}，已占用 ¥${used.toLocaleString("zh-CN")}，` +
        `本笔 ¥${amount.toLocaleString("zh-CN")} 将超预算 ¥${over.toLocaleString("zh-CN")}；` +
        `如需特批请由总管理员携带 force 标记提交`,
        "OVER_BUDGET",
        { budget, used, amount, over }
      );
    }
    const at = now();

    // 一票一付：同项目 + 同收款方 + 同发票号 已有有效付款单，说明这张票已经报过账。
    // 只按发票号拦会误伤（不同收款方各自开票，号段可能撞），所以三个条件一起判。
    if (invoiceNo) {
      const dup = db.prepare(
        "SELECT id FROM payments WHERE pid = ? AND invoice_no = ? AND payee = ? AND status <> '已驳回'"
      ).get(p.id, invoiceNo, payee);
      if (dup) {
        throw conflict(
          `发票号 ${invoiceNo} 已用于付款单 ${dup.id}（同项目、同收款方），不可重复挂账`,
          "DUPLICATE_INVOICE", { payment: dup.id }
        );
      }
    }

    const id = nextId(db, "payments", "id", "PY");
    db.prepare("INSERT INTO payments (id,pid,type,payee,amount,invoice_no,req_user,status,remark,created_by,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
      .run(id, p.id, b.type, payee, amount, invoiceNo, ctx.user.name, "待审批", remark, ctx.user.id, at);
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
    // 变更审批：与立项同权（project:approve）。
    // 原来这里没有任何权限判断 —— 任何能看见该项目的角色都能把变更批了，
    // 与审批中心按钮的显隐规则（can("project:approve")）对不上，接口裸奔。
    if (a.type === "变更审批" && !can(ctx.user, "project:approve")) {
      throw forbidden("只有协会管理员（或总管理员）可以审批变更");
    }
    db.prepare("UPDATE approvals SET status = ?, decided_by = ?, decided_at = ?, comment = ? WHERE id = ?")
      .run(approve ? "已通过" : "已驳回", ctx.user.name, now(), comment, a.id);
    logAudit({ user: ctx.user, module: "项目管理", action: approve ? "审批通过" : "审批驳回", target: p.id, detail: `${a.type}：${a.title}`, ip: ctx.ip });
    return { message: `${a.type} ${approve ? "已通过" : "已驳回"}${a.type === "变更审批" && approve ? "，待另一人执行落账后生效" : ""}` };
  });

  /**
   * 变更申请。
   *
   * 变更单可以带「变更后预算」（存进 approvals.amount，0 表示只改内容不涉金额）。
   * 注意：审批通过**不改项目任何字段** —— 见下面的 /execute。
   */
  router.post("/api/projects/:id/change", async (ctx) => {
    const p = getProject(ctx.params.id);
    assertProjectVisible(ctx.user, p);
    // 变更申请会生成待审批单，属于写操作，必须过权限；原来只查了数据范围，
    // 结果是项目成员里的「普通用户 / 嘉宾」也能提交变更并进审批中心。
    assertCan(ctx.user, "project:change", "只有协会管理员 / 会务执行可以提交变更申请");
    if (!["已立项", "筹备中", "执行中"].includes(p.status)) throw conflict(`「${p.status}」项目不可提交变更`);
    const title = String(ctx.body?.title || "").trim();
    if (!title) throw bad("请填写变更内容");
    if (title.length > 500) throw bad("变更内容不能超过 500 字");
    // 同一项目堆一屏待审批变更单没有意义，也容易让人漏看真正要批的那张
    const pending = db.prepare(
      "SELECT COUNT(*) AS c FROM approvals WHERE pid = ? AND type = '变更审批' AND status = '待审批'"
    ).get(p.id).c;
    if (pending >= 3) throw conflict(`该项目已有 ${pending} 张待审批的变更单，请先处理完再提交`, "TOO_MANY_PENDING");
    // 已批未落账的变更单也不能堆 —— 两张都批了、都改预算，谁后落账谁生效，账就说不清了。
    // 只拦「涉及金额」的那种（amount > 0）：只改内容的变更（amount = 0）没有钱要落，
    // 和新变更的预算打不起来，拦它只会让项目被一张陈年内容变更永久锁死。
    const approved = db.prepare(
      "SELECT id FROM approvals WHERE pid = ? AND type = '变更审批' AND status = '已通过'" +
      " AND executed_at IS NULL AND COALESCE(amount, 0) > 0 LIMIT 1"
    ).get(p.id);
    if (approved) {
      throw conflict(
        `该项目有 1 张已审批但还没落账的「预算变更」（${approved.id}），请先执行落账再提交新的变更`,
        "CHANGE_PENDING_EXECUTE", { approval: approved.id }
      );
    }

    // 变更后预算：可选。填了就必须是合法的钱数，且不能低于已占用
    let newBudget = 0;
    if (ctx.body?.budget !== undefined && ctx.body?.budget !== null && String(ctx.body.budget) !== "") {
      const n = Number(ctx.body.budget);
      if (!Number.isFinite(n) || !(n > 0)) throw bad("变更后预算必须大于 0（不涉及金额请留空）");
      if (n > 1e9) throw bad("变更后预算不能超过 10 亿元");
      if (Number(n.toFixed(2)) !== n) throw bad("变更后预算最多保留两位小数");
      const used = committed(p.id);
      if (cents(n) < cents(used)) {
        throw conflict(
          `变更后预算 ¥${yuan(n).toLocaleString("zh-CN")} 低于该项目已占用金额 ¥${used.toLocaleString("zh-CN")}` +
          `（含待审批 / 已审批 / 已付款），落账后会与已挂账的付款冲突`,
          "BUDGET_BELOW_COMMITTED", { budget: yuan(n), used }
        );
      }
      newBudget = yuan(n);
    }

    const id = nextId(db, "approvals", "id", "AP");
    db.prepare("INSERT INTO approvals (id,type,title,pid,ref_id,amount,by_user,sla,status,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)")
      .run(id, "变更审批", title, p.id, p.id, newBudget, ctx.user.name, "2 个工作日", "待审批", now());
    logAudit({
      user: ctx.user, module: "项目管理", action: "变更申请", target: p.id,
      detail: title + (newBudget ? `；申请预算 ¥${Number(p.budget).toLocaleString("zh-CN")} → ¥${newBudget.toLocaleString("zh-CN")}` : ""),
      ip: ctx.ip
    });
    return { message: `变更申请 ${id} 已提交${newBudget ? "（含预算调整）" : ""}`, approval: { id, amount: newBudget } };
  });

  /**
   * 变更落账 —— 双人复核。
   *
   * 老板 2026-10-27 拍板：变更审批通过后**不自动改预算**，必须人工再改一次，
   * 且执行人不能是审批人（也不能是申请人）。
   * 理由：审批和落账是两件事。一个人既批又改，等于没有复核；
   * 系统留痕也只能证明「同一个人做了两次决定」，证明不了有人核对过。
   *
   * 因此：审批通过 → status='已通过'，项目一个字段都不动；
   * 落账 → 另一人调这个接口，才真正写 projects.budget，status='已执行'。
   */
  router.post("/api/approvals/:id/execute", async (ctx) => {
    const a = db.prepare("SELECT * FROM approvals WHERE id = ?").get(ctx.params.id);
    if (!a) throw notFound("审批单不存在");
    if (a.type !== "变更审批") throw bad(`${a.type} 审批通过即生效，不需要执行落账`);
    if (a.status === "待审批") throw conflict("该变更单还没审批，不能执行落账", "NOT_APPROVED");
    if (a.status === "已驳回") throw conflict("该变更单已被驳回，无需执行落账", "REJECTED");
    if (a.executed_at || a.status === "已执行") {
      throw conflict(`该变更单已由 ${a.executed_by || "他人"} 于 ${a.executed_at || ""} 执行落账，不可重复执行`, "ALREADY_EXECUTED");
    }

    const p = getProject(a.pid);
    assertProjectVisible(ctx.user, p);
    assertCan(ctx.user, "change:execute", "变更落账需要协会管理员 / 会务执行 / 财务权限");

    // 双人复核：批的人不落账，落账的人不批；自己提的也不能自己落
    const me = ctx.user.name;
    if (a.decided_by && me === a.decided_by) {
      throw conflict(
        `变更单 ${a.id} 由你审批，落账必须由另一人执行（双人复核）；请让其他有权限的同事操作`,
        "NEED_SECOND_PERSON", { decided_by: a.decided_by }
      );
    }
    if (a.by_user && me === a.by_user) {
      throw conflict(
        `变更单 ${a.id} 由你提交，落账必须由另一人执行（双人复核）；请让其他有权限的同事操作`,
        "NEED_SECOND_PERSON", { by_user: a.by_user }
      );
    }

    // 已结算 / 已归档 = 账目已封，改预算会与结算单对不上
    if (["已结算", "已归档"].includes(p.status)) {
      throw conflict(`项目已「${p.status}」，账目已封，变更不可再落账`, "FROZEN", { status: p.status });
    }

    let detail = `${a.id}：${a.title}`;
    let budgetInfo = null;
    const newBudget = yuan(a.amount);
    if (newBudget > 0) {
      const used = committed(p.id);
      if (cents(newBudget) < cents(used)) {
        throw conflict(
          `变更后预算 ¥${newBudget.toLocaleString("zh-CN")} 低于已占用金额 ¥${used.toLocaleString("zh-CN")}，落账会让账实不符`,
          "BUDGET_BELOW_COMMITTED", { budget: newBudget, used }
        );
      }
      budgetInfo = { from: yuan(p.budget), to: newBudget };
      db.prepare("UPDATE projects SET budget = ?, updated_at = ? WHERE id = ?").run(newBudget, now(), p.id);
      detail += `；预算 ¥${Number(p.budget).toLocaleString("zh-CN")} → ¥${newBudget.toLocaleString("zh-CN")}`;
    }

    const at = now();
    db.prepare("UPDATE approvals SET status = '已执行', executed_by = ?, executed_at = ? WHERE id = ?")
      .run(me, at, a.id);
    logAudit({ user: ctx.user, module: "项目管理", action: "变更落账", target: p.id, detail, ip: ctx.ip });
    return {
      message: `变更 ${a.id} 已落账${budgetInfo ? `，预算已调整为 ¥${budgetInfo.to.toLocaleString("zh-CN")}` : ""}`,
      project: getProject(p.id),
      approval: db.prepare("SELECT * FROM approvals WHERE id = ?").get(a.id),
      budget: budgetInfo
    };
  });

  return router;
}

module.exports = { register, PAYABLE_STATUS };
