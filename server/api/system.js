"use strict";
const { db } = require("../lib/db");
const { now, today, nextId, toCsv, bad, notFound, conflict } = require("../lib/util");
const { assertCan, scopeFilter, isSuper, ROLES, can, canVisitNav, STATUSES } = require("../lib/rbac");
const { logAudit } = require("../lib/audit");
const { hashPassword, validatePassword } = require("../lib/auth");
const { listProjects } = require("./projects");
const { VERIFY_STEPS } = require("../lib/constants");
const { readPaging, countOf } = require("../lib/paginate");

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
  /**
   * 注意：这里不能加 LIMIT。
   * 待审批列表是「先按状态取一批，再按角色过滤」，如果 LIMIT 加在 SQL 上，
   * 被截掉的可能全是别的角色该处理的单子，本角色的待办就会凭空少几条，
   * 而工作台显示的「N 项」看起来又像全量 —— 用户会以为没事了。
   * 数据量由「待审批」这个状态本身兜住，不会无限增长。
   */
  const pendingAp = db.prepare(
    `SELECT a.*, p.name AS pname FROM approvals a JOIN projects p ON p.id = a.pid
     WHERE a.status = '待审批' AND ${sql} ORDER BY a.created_at DESC`
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
  /**
   * 变更落账（双人复核的第二步）。
   *
   * 审批通过 ≠ 生效，得由另一个人把它落进项目。这条待办是「第二个人」唯一会被通知到的地方 ——
   * 没有它，变更批完就静静躺在项目详情里，谁也不知道还有一笔没生效，预算永远是旧的。
   *
   * 双人复核的两个人不推给他自己：自己提的、自己批的，点进去按钮也是灰的，
   * 推了只会让人以为系统坏了。
   */
  if (can(user, "change:execute") && canVisitNav(user, "projects")) {
    const rows = db.prepare(
      `SELECT a.*, p.name AS pname FROM approvals a JOIN projects p ON p.id = a.pid
       WHERE a.type='变更审批' AND a.status='已通过' AND a.executed_at IS NULL AND ${sql}
       ORDER BY a.decided_at DESC`
    ).all(...params);
    for (const a of rows) {
      if (a.by_user === user.name || a.decided_by === user.name) continue;
      const amtNote = Number(a.amount) > 0 ? `（预算 → ¥${Number(a.amount).toLocaleString("zh-CN")}）` : "（不涉金额）";
      todos.push({
        kind: "变更落账", title: `变更已批准，待落账：${a.title}${amtNote}`,
        pid: a.pid, pname: a.pname, ref: a.id, sla: "审批后 2 个工作日", go: "projects"
      });
    }
  }
  return todos;
}

/**
 * 异常预警 —— 每一条都必须是「当前角色点进去就能动手」的。
 *
 * 原来只按数据范围过滤：会务执行能看到「有 3 笔付款待审批」和「例外单待审批」，
 * 但这两个动作的权限（payment:approve / verify:exception_approve）他都没有，
 * 模块里也没有财务结算和审批中心 —— 点「去处理」直接被路由守卫弹回工作台，
 * 表现就是「按钮点了没反应」。所以每条预警先问两个问题：
 *   1. 这个动作是不是归你管（权限）
 *   2. 目标页面你进不进得去（模块）
 * 两个都过才生成。预警面板写的是「N 条需要处理」，不能放处理不了的进来。
 */
function alerts(user) {
  const { sql, params } = scopeFilter(user);
  const out = [];
  if (can(user, "verify:check") && canVisitNav(user, "verify")) {
    const blocked = db.prepare(
      `SELECT p.*, (SELECT MIN(v.step_no) FROM verify_steps v WHERE v.pid=p.id AND v.result='不通过') AS failed_step
       FROM projects p WHERE p.status='待核销' AND ${sql}`
    ).all(...params);
    for (const p of blocked) {
      if (p.failed_step) out.push({ level: "紧急", pid: p.id, text: `${p.name}：第 ${p.failed_step} 步核销不通过，付款已锁定`, go: "verify" });
    }
  }
  if (can(user, "verify:exception_approve") && canVisitNav(user, "approvals")) {
    const openEx = db.prepare(
      `SELECT e.*, p.name AS pname FROM exceptions e JOIN projects p ON p.id=e.pid WHERE e.status='待审批' AND ${sql}`
    ).all(...params);
    for (const e of openEx) out.push({ level: "重要", pid: e.pid, text: `${e.pname}：例外单 ${e.id} 待审批`, go: "approvals" });
  }
  if (can(user, "payment:approve") && canVisitNav(user, "finance")) {
    const unpaid = db.prepare(
      `SELECT COUNT(*) AS c FROM payments y JOIN projects p ON p.id=y.pid WHERE y.status='待审批' AND ${sql}`
    ).get(...params).c;
    if (unpaid) out.push({ level: "一般", pid: "", text: `有 ${unpaid} 笔付款待审批`, go: "finance" });
  }
  return out;
}

/**
 * 工作台「最近动态」。
 * 审计日志的 target 可能是项目编号，也可能是用户 id（系统配置类）。
 * 非超管只能看到自己数据范围内项目的记录，系统级审计不给看 ——
 * 这和 GET /api/audit 对非 audit:read 角色只返回本人记录是同一个口径。
 */
function recentAudits(user) {
  if (isSuper(user)) return db.prepare("SELECT * FROM audit_logs ORDER BY id DESC LIMIT 8").all();
  const { sql, params } = scopeFilter(user);
  return db.prepare(
    `SELECT a.* FROM audit_logs a JOIN projects p ON p.id = a.target WHERE ${sql} ORDER BY a.id DESC LIMIT 8`
  ).all(...params);
}

/**
 * 本角色可见的项目号集合。null 表示超管，全部可见。
 * 只给审计日志用：日志按设计是全量留痕，但里面的项目号得先判可见性，
 * 否则页面上会出现一批点进去 403 的链接。
 */
function visibleProjectIds(user) {
  if (isSuper(user)) return null;
  const { sql, params } = scopeFilter(user);
  return new Set(db.prepare(`SELECT p.id FROM projects p WHERE ${sql}`).all(...params).map((r) => r.id));
}

/** 给审计行标「这个项目号当前角色点得开吗」；非项目号（用户 id 等）恒为 1 */
function markTargets(rows, vis) {
  return rows.map((r) => {
    const t = String(r.target || "");
    const isProject = t.startsWith("MP-");
    return { ...r, target_visible: !isProject || !vis || vis.has(t) ? 1 : 0 };
  });
}

function dashboard(user) {
  const { map, rows } = countsByStatus(user);
  const todos = myTodos(user);
  const { sql, params } = scopeFilter(user);
  const upcoming = db.prepare(
    `SELECT * FROM projects p WHERE ${sql} AND p.date >= ? AND p.status IN ('已立项','筹备中','执行中','待核销')
     ORDER BY p.date ASC LIMIT 6`
  ).all(...params, today());

  // 预算与已付款必须各自独立聚合。
  // 原来把已付款写成 SELECT 列表里的标量子查询，子查询里 JOIN 用的是 p2 别名、
  // 而数据范围条件用的是 p. —— SQLite 把 p 当成外层引用，条件恒真，
  // 于是协会管理员看到的是全平台已付款（实测 ¥698,600 vs 本协会 ¥364,000）。
  const budget = Number(db.prepare(
    `SELECT COALESCE(ROUND(SUM(p.budget),2),0) AS v FROM projects p WHERE ${sql}`
  ).get(...params).v) || 0;
  const paid = Number(db.prepare(
    `SELECT COALESCE(ROUND(SUM(y.amount),2),0) AS v FROM payments y JOIN projects p ON p.id = y.pid
     WHERE y.status = '已付款' AND ${sql}`
  ).get(...params).v) || 0;

  return {
    counts: map,
    statusRows: rows,
    budget,
    paid,
    todos,
    upcoming,
    alerts: alerts(user),
    recent: recentAudits(user)
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
    headers: ["合同编号", "项目", "合同名称", "类别", "签约方", "金额", "签署日期", "状态"],
    sql: (u) => {
      const { sql, params } = scopeFilter(u);
      return {
        sql: `SELECT c.*, p.name AS pname FROM contracts c JOIN projects p ON p.id=c.pid WHERE ${sql} ORDER BY c.id`,
        params
      };
    },
    map: (r) => [r.id, r.pname, r.name, r.category || "", r.vendor, r.amount, r.sign_date, r.status]
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

/* ---------------- 账号 ---------------- */

/** 账号资料字段长度上限：通讯录会渲染到列表与成员选择器，超长文本会把布局撑坏 */
const USER_MAX = { name: 30, dept: 40, phone: 20 };
const USER_LABEL = { name: "姓名", dept: "部门", phone: "联系电话" };
function checkUserLen(b) {
  for (const [k, max] of Object.entries(USER_MAX)) {
    if (!(k in b) || b[k] === undefined || b[k] === null) continue;
    if (String(b[k]).length > max) throw bad(`${USER_LABEL[k]}不能超过 ${max} 字（当前 ${String(b[k]).length} 字）`);
  }
}

/**
 * 0/1 开关字段归一化。
 * JSON 客户端很自然会传 `{ active: false }`，但 node:sqlite 不接受布尔绑定，
 * 会抛 "Provided value cannot be bound to SQLite parameter 1"，最终变成 500 并把
 * 这句内部实现细节透给用户。凡是布尔语义的字段一律先归一成 0/1 再落库。
 */
function toFlag(v) {
  if (v === true || v === 1 || v === "1" || v === "true") return 1;
  if (v === false || v === 0 || v === "0" || v === "false") return 0;
  return null;
}

function register(router) {
  router.get("/api/dashboard", async (ctx) => dashboard(ctx.user));

  router.get("/api/users", async (ctx) => {
    /**
     * V1.2.17 SEC-01：整本通讯录只给能管理账号的人。
     *
     * 测试报告指出的问题：guest 请求这个接口返回 200，拿到全平台 9 名员工的姓名与角色；
     * assoc 与 admin 返回的字节数还完全一样（1770）—— 字段裁剪做了，模块级鉴权没做。
     * 员工名单可用于社工与撞库定位，不是「演示数据」能带过的。
     *
     * 「项目增加成员」改用下面的 /api/users/pickable（只要 project:member），
     * 它只回 id / 姓名 / 角色，不含账号、手机、协会、部门。
     */
    assertCan(ctx.user, "user:manage", "只有总管理员可以查看账号目录");
    const rows = db.prepare("SELECT * FROM users ORDER BY id").all();
    return {
      rows: rows.map((u) => ({
        id: u.id, username: u.username, name: u.name, role: u.role, assoc: u.assoc, dept: u.dept,
        phone: u.phone, active: u.active, created_at: u.created_at, role_name: ROLES[u.role]?.name || u.role
      })),
      limited: false
    };
  });

  /**
   * 选人接口 —— 只服务于「把某人加进项目」。
   * 最小字段：id / 姓名 / 角色名（前端下拉就这三样），不泄露账号与联系方式。
   */
  router.get("/api/users/pickable", async (ctx) => {
    if (!can(ctx.user, "project:member") && !can(ctx.user, "user:manage")) {
      throw require("../lib/util").forbidden("当前角色无权选择项目成员");
    }
    const rows = db.prepare("SELECT id, name, role FROM users WHERE active = 1 ORDER BY id").all();
    return {
      rows: rows.map((u) => ({ id: u.id, name: u.name, role: u.role, role_name: ROLES[u.role]?.name || u.role }))
    };
  });

  router.post("/api/users", async (ctx) => {
    assertCan(ctx.user, "user:manage", "只有总管理员可以创建账号");
    const b = ctx.body || {};
    if (!/^[a-zA-Z0-9_.-]{3,20}$/.test(String(b.username || ""))) throw bad("账号需 3~20 位字母/数字");
    if (!String(b.name || "").trim()) throw bad("请填写姓名");
    if (!ROLES[b.role]) throw bad("角色不合法");
    checkUserLen(b);
    if (db.prepare("SELECT 1 FROM users WHERE username = ?").get(b.username)) throw conflict("账号已存在");
    // V1.2.17 SEC-04：不再给默认口令 123456，也不接受弱口令 —— 与自助改密同一份策略
    const pwd = validatePassword(b.password, { label: "初始密码" });
    const { salt, hash } = hashPassword(pwd);
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
    // active 先归一成 0/1，否则 `{ active: false }` 会在绑定参数时抛 500
    if ("active" in b) {
      const flag = toFlag(b.active);
      if (flag === null) throw bad("账号状态只能是启用或停用");
      b.active = flag;
    }
    const patch = {};
    for (const k of ["name", "role", "assoc", "dept", "phone", "active"]) {
      if (k in b && String(b[k] ?? "") !== String(u[k] ?? "")) patch[k] = b[k];
    }
    if (patch.role && !ROLES[patch.role]) throw bad("角色不合法");
    checkUserLen(patch);
    if (u.id === ctx.user.id) {
      if ("active" in patch && !Number(patch.active)) throw bad("不能停用当前登录的账号");
      if ("role" in patch && patch.role !== u.role) throw bad("不能修改自己的角色，请由其他总管理员操作");
    }
    if (Object.keys(patch).length) {
      db.prepare(`UPDATE users SET ${Object.keys(patch).map((k) => `${k} = ?`).join(", ")} WHERE id = ?`)
        .run(...Object.values(patch), u.id);
      logAudit({ user: ctx.user, module: "系统配置", action: "改角色/资料", target: String(u.id), detail: Object.entries(patch).map(([k, v]) => `${k}: ${u[k] ?? "空"} → ${v}`).join("；"), ip: ctx.ip });
    }
    if (b.password) {
      // 重置密码同样走统一策略（原来是「至少 6 位」，比自助改密还松）
      validatePassword(b.password, { label: "新密码" });
      const { salt, hash } = hashPassword(b.password);
      db.prepare("UPDATE users SET pass_salt = ?, pass_hash = ?, token_ver = token_ver + 1 WHERE id = ?").run(salt, hash, u.id);
      // 改密后立即吊销该账号的其它会话（保留操作者自己的当前会话，避免把自己踢下线）
      const killed = db.prepare("DELETE FROM sessions WHERE user_id = ? AND token <> ?").run(u.id, ctx.token || "");
      logAudit({
        user: ctx.user, module: "系统配置", action: "重置密码", target: String(u.id),
        detail: `${u.name}（已吊销 ${killed.changes} 个旧会话）`, ip: ctx.ip
      });
    }
    return { user: db.prepare("SELECT id,username,name,role,assoc,dept,phone,active FROM users WHERE id = ?").get(u.id), message: "已保存" };
  });

  router.get("/api/audit", async (ctx) => {
    // V1.2.17 SEC-02：审计日志按模块白名单。原来非审计角色还能查「自己那部分」，
    // 但侧栏里根本没有这个入口 —— 等于留了一个界面上看不见、接口却通着的口子。
    require("../lib/rbac").assertModule(ctx.user, "audit");
    /**
     * 审计日志里的项目号不是每个角色都点得开。
     * 协会管理员有 audit:read，看到的是全平台留痕（审计的意义就在这，不能按协会切），
     * 但点别家协会的项目号会 403「该项目不在你的数据范围内」——
     * 页面上就是一个死链。所以给每行打一个 target_visible，
     * 前端只对可见的项目号渲染成链接，不可见的显示成纯文本。
     */
    const vis = visibleProjectIds(ctx.user);
    if (!can(ctx.user, "audit:read")) {
      // 非审计角色仅可看自己
      const rows = db.prepare("SELECT * FROM audit_logs WHERE user_id = ? ORDER BY id DESC LIMIT 200").all(ctx.user.id);
      return { rows: markTargets(rows, vis), total: rows.length, limited: true, paged: false };
    }
    const where = [];
    const args = [];
    if (ctx.query.module) { where.push("module = ?"); args.push(ctx.query.module); }
    if (ctx.query.q) { where.push("(detail LIKE ? OR target LIKE ? OR user_name LIKE ?)"); args.push(`%${ctx.query.q}%`, `%${ctx.query.q}%`, `%${ctx.query.q}%`); }
    const whereSql = where.length ? "WHERE " + where.join(" AND ") : "";
    const paging = readPaging(ctx.query);

    if (!paging) {
      const rows = db.prepare(
        `SELECT * FROM audit_logs ${whereSql} ORDER BY id DESC LIMIT 500`
      ).all(...args);
      return { rows: markTargets(rows, vis), total: rows.length, limited: false, paged: false };
    }
    const total = countOf(db.prepare(`SELECT COUNT(*) AS c FROM audit_logs ${whereSql}`).get(...args));
    const rows = db.prepare(
      `SELECT * FROM audit_logs ${whereSql} ORDER BY id DESC LIMIT ? OFFSET ?`
    ).all(...args, paging.size, paging.offset);
    return {
      rows: markTargets(rows, vis),
      total,
      page: paging.page,
      size: paging.size,
      pages: Math.max(1, Math.ceil(total / paging.size)),
      limited: false,
      paged: true
    };
  });

  router.get("/api/exports", async (ctx) => {
    // 导出记录含他人文件名与操作人，仅审计角色 / 可导出角色可见
    if (!can(ctx.user, "export:any") && !can(ctx.user, "audit:read")) {
      throw require("../lib/util").forbidden("当前角色无导出记录查看权限");
    }
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

  // 健康检查：公开接口，只回存活状态，不暴露数据库路径等内部信息
  router.get("/api/health", async () => ({ ok: true, at: now() }));

  return router;
}

module.exports = { register, dashboard, EXPORTS };
