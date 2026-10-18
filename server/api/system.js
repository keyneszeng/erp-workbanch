"use strict";
const { db } = require("../lib/db");
const { now, today, nextId, toCsv, bad, notFound, conflict } = require("../lib/util");
const { assertCan, scopeFilter, isSuper, ROLES, can, STATUSES } = require("../lib/rbac");
const { logAudit } = require("../lib/audit");
const { hashPassword } = require("../lib/auth");
const { listProjects } = require("./projects");
const { VERIFY_STEPS } = require("../lib/constants");

function countsByStatus(user) {
  const { sql, params } = scopeFilter(user);
  const rows = db.prepare(`SELECT p.status, COUNT(*) AS c, COALESCE(SUM(p.budget),0) AS budget FROM projects p WHERE ${sql} GROUP BY p.status`).all(...params);
  const map = Object.fromEntries(STATUSES.map((s) => [s, 0]));
  for (const r of rows) map[r.status] = r.c;
  return { map, rows };
}

function myTodos(user) {
  const { sql, params } = scopeFilter(user);
  const todos = [];
  const pendingAp = db.prepare(
    `SELECT a.*, p.name AS pname FROM approvals a JOIN projects p ON p.id = a.pid
     WHERE a.status = '待审批' AND ${sql} ORDER BY a.created_at DESC LIMIT 20`
  ).all(...params);

  for (const a of pendingAp) {
    const need = a.type === "立项审批" ? can(user, "project:approve")
      : a.type === "例外单审批" ? can(user, "verify:exception_approve")
      : a.type === "付款审批" ? can(user, "payment:approve") : can(user, "project:approve");
    if (need) todos.push({ kind: "审批", title: `${a.type}：${a.title}`, pid: a.pid, pname: a.pname, ref: a.id, sla: a.sla, go: "approvals" });
  }
  if (can(user, "verify:conclude")) {
    const rows = db.prepare(
      `SELECT p.*, (SELECT COUNT(*) FROM verify_steps v WHERE v.pid=p.id AND v.result IN ('通过','已解例外')) AS passed
       FROM projects p WHERE p.status='待核销' AND ${sql}`
    ).all(...params);
    for (const p of rows) todos.push({ kind: "核销", title: `核销待判定（${p.passed}/6 已通过）`, pid: p.id, pname: p.name, ref: p.id, sla: "会期后 5 个工作日", go: "verify" });
  }
  if (can(user, "settle:create")) {
    const rows = db.prepare(
      `SELECT p.* FROM projects p WHERE p.status='已核销' AND ${sql}
       AND NOT EXISTS (SELECT 1 FROM settlements s WHERE s.pid=p.id)`
    ).all(...params);
    for (const p of rows) todos.push({ kind: "结算", title: "核销已通过，待生成结算单", pid: p.id, pname: p.name, ref: p.id, sla: "核销后 3 个工作日", go: "finance" });
  }
  if (can(user, "archive:write")) {
    const rows = db.prepare(
      `SELECT p.* FROM projects p WHERE p.status='已结算' AND ${sql}`
    ).all(...params);
    for (const p of rows) todos.push({ kind: "归档", title: "结算完成，待归档", pid: p.id, pname: p.name, ref: p.id, sla: "结算后 5 个工作日", go: "archive" });
  }
  if (can(user, "payment:pay")) {
    const rows = db.prepare(
      `SELECT y.*, p.name AS pname FROM payments y JOIN projects p ON p.id=y.pid WHERE y.status='已审批' AND ${sql}`
    ).all(...params);
    for (const y of rows) todos.push({ kind: "付款", title: `待付款 ${y.type} ¥${Number(y.amount).toLocaleString("zh-CN")}`, pid: y.pid, pname: y.pname, ref: y.id, sla: "审批后 2 个工作日", go: "finance" });
  }
  return todos;
}

function alerts(user) {
  const { sql, params } = scopeFilter(user);
  const out = [];
  const blocked = db.prepare(
    `SELECT p.*, (SELECT MIN(v.step_no) FROM verify_steps v WHERE v.pid=p.id AND v.result='不通过') AS failed_step
     FROM projects p WHERE p.status='待核销' AND ${sql}`
  ).all(...params);
  for (const p of blocked) {
    if (p.failed_step) out.push({ level: "紧急", pid: p.id, text: `${p.name}：第 ${p.failed_step} 步核销不通过，付款已锁定`, go: "verify" });
  }
  const openEx = db.prepare(
    `SELECT e.*, p.name AS pname FROM exceptions e JOIN projects p ON p.id=e.pid WHERE e.status='待审批' AND ${sql}`
  ).all(...params);
  for (const e of openEx) out.push({ level: "重要", pid: e.pid, text: `${e.pname}：例外单 ${e.id} 待审批`, go: "approvals" });
  const unpaid = db.prepare(
    `SELECT COUNT(*) AS c FROM payments y JOIN projects p ON p.id=y.pid WHERE y.status='待审批' AND ${sql}`
  ).get(...params).c;
  if (unpaid) out.push({ level: "一般", pid: "", text: `有 ${unpaid} 笔付款待审批`, go: "finance" });
  return out;
}

function dashboard(user) {
  const { map, rows } = countsByStatus(user);
  const todos = myTodos(user);
  const { sql, params } = scopeFilter(user);
  const upcoming = db.prepare(
    `SELECT * FROM projects p WHERE ${sql} AND p.date >= ? AND p.status IN ('已立项','筹备中','执行中','待核销')
     ORDER BY p.date ASC LIMIT 6`
  ).all(...params, today());
  const money = db.prepare(
    `SELECT COALESCE(SUM(p.budget),0) AS budget,
            (SELECT COALESCE(SUM(y.amount),0) FROM payments y JOIN projects p2 ON p2.id=y.pid WHERE y.status='已付款' AND ${sql}) AS paid
     FROM projects p WHERE ${sql}`
  ).get(...params, ...params);
  return {
    counts: map,
    statusRows: rows,
    budget: money.budget,
    paid: money.paid,
    todos,
    upcoming,
    alerts: alerts(user),
    recent: db.prepare("SELECT * FROM audit_logs ORDER BY id DESC LIMIT 8").all()
  };
}

/* ---------------- 导出 ---------------- */
const EXPORTS = {
  projects: {
    module: "项目管理", file: "项目清单",
    headers: ["项目编号", "会议名称", "所属协会", "形式", "会期", "预算", "参会人数", "负责人", "状态"],
    sql: (u) => {
      const { sql, params } = scopeFilter(u);
      return {
        sql: `SELECT p.id,p.name,p.assoc,p.form,p.date,p.budget,p.people,p.owner,p.status FROM projects p WHERE ${sql} ORDER BY p.date DESC`,
        params
      };
    },
    map: (r) => [r.id, r.name, r.assoc, r.form, r.date, r.budget, r.people, r.owner, r.status]
  },
  payments: {
    module: "财务结算", file: "付款明细",
    headers: ["付款单号", "项目", "类型", "收款方", "金额", "发票号", "申请人", "状态", "付款时间"],
    sql: (u) => {
      const { sql, params } = scopeFilter(u);
      return {
        sql: `SELECT y.*, p.name AS pname FROM payments y JOIN projects p ON p.id=y.pid WHERE ${sql} ORDER BY y.created_at DESC`,
        params
      };
    },
    map: (r) => [r.id, r.pname, r.type, r.payee, r.amount, r.invoice_no, r.req_user, r.status, r.paid_at || ""]
  },
  contracts: {
    module: "筹备管理", file: "合同台账",
    headers: ["合同编号", "项目", "合同名称", "签约方", "金额", "签署日期", "状态"],
    sql: (u) => {
      const { sql, params } = scopeFilter(u);
      return {
        sql: `SELECT c.*, p.name AS pname FROM contracts c JOIN projects p ON p.id=c.pid WHERE ${sql} ORDER BY c.id`,
        params
      };
    },
    map: (r) => [r.id, r.pname, r.name, r.vendor, r.amount, r.sign_date, r.status]
  },
  verify: {
    module: "会后核销", file: "核销明细",
    headers: ["项目编号", "会议名称", "状态", ...VERIFY_STEPS.map((s) => `${s.no}.${s.name}`), "例外单", "结算单"],
    sql: (u) => {
      const { sql, params } = scopeFilter(u);
      return {
        sql: `SELECT p.id,p.name,p.status,
          (SELECT result FROM verify_steps v WHERE v.pid=p.id AND v.step_no=1) AS s1,
          (SELECT result FROM verify_steps v WHERE v.pid=p.id AND v.step_no=2) AS s2,
          (SELECT result FROM verify_steps v WHERE v.pid=p.id AND v.step_no=3) AS s3,
          (SELECT result FROM verify_steps v WHERE v.pid=p.id AND v.step_no=4) AS s4,
          (SELECT result FROM verify_steps v WHERE v.pid=p.id AND v.step_no=5) AS s5,
          (SELECT result FROM verify_steps v WHERE v.pid=p.id AND v.step_no=6) AS s6,
          (SELECT COUNT(*) FROM exceptions e WHERE e.pid=p.id) AS ex_cnt,
          (SELECT id FROM settlements s WHERE s.pid=p.id) AS st_id
          FROM projects p WHERE ${sql} AND p.status IN ('待核销','已核销','已结算','已归档') ORDER BY p.date DESC`,
        params
      };
    },
    map: (r) => [r.id, r.name, r.status, r.s1 || "待判定", r.s2 || "待判定", r.s3 || "待判定", r.s4 || "待判定", r.s5 || "待判定", r.s6 || "待判定", r.ex_cnt, r.st_id || ""]
  },
  settlements: {
    module: "财务结算", file: "结算汇总",
    headers: ["结算单号", "项目编号", "项目", "收入", "支出", "结余", "状态", "生成时间"],
    sql: (u) => {
      const { sql, params } = scopeFilter(u);
      return {
        sql: `SELECT s.*, p.name AS pname FROM settlements s JOIN projects p ON p.id=s.pid WHERE ${sql} ORDER BY s.created_at DESC`,
        params
      };
    },
    map: (r) => [r.id, r.pid, r.pname, r.income, r.expense, r.profit, r.status, r.created_at]
  },
  audit: {
    module: "审计日志", file: "审计日志",
    headers: ["时间", "操作人", "角色", "模块", "动作", "对象", "详情", "IP"],
    sql: () => ({ sql: "SELECT * FROM audit_logs ORDER BY id DESC LIMIT 2000", params: [] }),
    map: (r) => [r.at, r.user_name, r.role, r.module, r.action, r.target, r.detail, r.ip]
  }
};

function register(router) {
  router.get("/api/dashboard", async (ctx) => dashboard(ctx.user));

  router.get("/api/users", async (ctx) => {
    const rows = db.prepare("SELECT id,username,name,role,assoc,dept,phone,active,created_at FROM users ORDER BY id").all();
    return { rows: rows.map((u) => ({ ...u, role_name: ROLES[u.role]?.name || u.role })) };
  });

  router.post("/api/users", async (ctx) => {
    assertCan(ctx.user, "user:manage", "只有总管理员可以创建账号");
    const b = ctx.body || {};
    if (!/^[a-zA-Z0-9_.-]{3,20}$/.test(String(b.username || ""))) throw bad("账号需 3~20 位字母/数字");
    if (!String(b.name || "").trim()) throw bad("请填写姓名");
    if (!ROLES[b.role]) throw bad("角色不合法");
    if (db.prepare("SELECT 1 FROM users WHERE username = ?").get(b.username)) throw conflict("账号已存在");
    const { salt, hash } = hashPassword(b.password || "123456");
    db.prepare("INSERT INTO users (username,name,role,assoc,dept,phone,pass_salt,pass_hash,active,created_at) VALUES (?,?,?,?,?,?,?,?,1,?)")
      .run(b.username, b.name, b.role, b.assoc || null, b.dept || "", b.phone || "", salt, hash, now());
    const u = db.prepare("SELECT id,username,name,role,assoc FROM users WHERE username = ?").get(b.username);
    logAudit({ user: ctx.user, module: "系统配置", action: "新建用户", target: String(u.id), detail: `${b.name} / ${ROLES[b.role].name}`, ip: ctx.ip });
    return { user: u, message: `账号 ${b.username} 已创建` };
  });

  router.patch("/api/users/:id", async (ctx) => {
    assertCan(ctx.user, "user:manage", "只有总管理员可以修改账号");
    const u = db.prepare("SELECT * FROM users WHERE id = ?").get(Number(ctx.params.id));
    if (!u) throw notFound("用户不存在");
    const b = ctx.body || {};
    const patch = {};
    for (const k of ["name", "role", "assoc", "dept", "phone", "active"]) {
      if (k in b && String(b[k] ?? "") !== String(u[k] ?? "")) patch[k] = b[k];
    }
    if (patch.role && !ROLES[patch.role]) throw bad("角色不合法");
    if (Object.keys(patch).length) {
      db.prepare(`UPDATE users SET ${Object.keys(patch).map((k) => `${k} = ?`).join(", ")} WHERE id = ?`)
        .run(...Object.values(patch), u.id);
      logAudit({ user: ctx.user, module: "系统配置", action: "改角色/资料", target: String(u.id), detail: Object.entries(patch).map(([k, v]) => `${k}: ${u[k] ?? "空"} → ${v}`).join("；"), ip: ctx.ip });
    }
    if (b.password) {
      const { salt, hash } = hashPassword(b.password);
      db.prepare("UPDATE users SET pass_salt = ?, pass_hash = ? WHERE id = ?").run(salt, hash, u.id);
      logAudit({ user: ctx.user, module: "系统配置", action: "重置密码", target: String(u.id), detail: u.name, ip: ctx.ip });
    }
    return { user: db.prepare("SELECT id,username,name,role,assoc,dept,phone,active FROM users WHERE id = ?").get(u.id), message: "已保存" };
  });

  router.get("/api/audit", async (ctx) => {
    if (!can(ctx.user, "audit:read")) {
      // 非审计角色仅可看自己
      const rows = db.prepare("SELECT * FROM audit_logs WHERE user_id = ? ORDER BY id DESC LIMIT 200").all(ctx.user.id);
      return { rows, limited: true };
    }
    const where = [];
    const args = [];
    if (ctx.query.module) { where.push("module = ?"); args.push(ctx.query.module); }
    if (ctx.query.q) { where.push("(detail LIKE ? OR target LIKE ? OR user_name LIKE ?)"); args.push(`%${ctx.query.q}%`, `%${ctx.query.q}%`, `%${ctx.query.q}%`); }
    const rows = db.prepare(
      `SELECT * FROM audit_logs ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY id DESC LIMIT 500`
    ).all(...args);
    return { rows, limited: false };
  });

  router.get("/api/exports", async (ctx) => {
    return { rows: db.prepare("SELECT * FROM exports ORDER BY id DESC LIMIT 50").all() };
  });

  router.get("/api/export/:kind", async (ctx) => {
    const kind = ctx.params.kind.replace(/\.csv$/, "");
    const def = EXPORTS[kind];
    if (!def) throw notFound("不支持的导出类型");
    if (kind !== "audit") assertCan(ctx.user, "export:any", "当前角色无导出权限");
    else if (!can(ctx.user, "audit:read")) throw require("../lib/util").forbidden("当前角色无审计导出权限");
    const q = def.sql(ctx.user);
    const rows = db.prepare(q.sql).all(...q.params);
    const csv = toCsv(def.headers, rows.map(def.map));
    const filename = `${def.file}-${today().replace(/-/g, "")}.csv`;
    db.prepare("INSERT INTO exports (at,user_name,module,filename,rows) VALUES (?,?,?,?,?)")
      .run(now(), ctx.user.name, def.module, filename, rows.length);
    logAudit({ user: ctx.user, module: def.module, action: "导出", target: kind, detail: `导出 ${filename}，${rows.length} 行`, ip: ctx.ip });
    return {
      __csv: csv,
      __filename: filename
    };
  });

  router.get("/api/health", async () => ({ ok: true, at: now(), db: require("../lib/db").DB_FILE }));

  return router;
}

module.exports = { register, dashboard, EXPORTS };
