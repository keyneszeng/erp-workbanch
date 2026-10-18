"use strict";
const { db } = require("../lib/db");
const { now, nextId, bad, notFound, conflict, forbidden } = require("../lib/util");
const { assertCan, assertProjectVisible, can, isSuper, scopeFilter, ROLES } = require("../lib/rbac");
const { logAudit } = require("../lib/audit");
const { getProject, verification, materialsStatus, settlementOf, availableActions, transition } = require("../lib/workflow");
const { ASSOCS, FORMS, DEPTS } = require("../lib/constants");

const EDITABLE = ["name", "assoc", "form", "date", "days", "budget", "people", "owner", "phone", "dept", "agenda"];

function validate(body, partial = false) {
  const need = { name: "会议名称", assoc: "所属协会", form: "会议形式", date: "会议日期", budget: "预算", owner: "项目负责人", agenda: "初版议程要点" };
  for (const [k, label] of Object.entries(need)) {
    if (partial && !(k in body)) continue;
    const v = body[k];
    if (v === undefined || v === null || String(v).trim() === "") throw bad(`${label}为必填项`);
  }
  if ("budget" in body && !(Number(body.budget) > 0)) throw bad("预算必须大于 0");
  if ("assoc" in body && !ASSOCS.includes(body.assoc)) throw bad("所属协会不在可选范围");
  if ("form" in body && !FORMS.includes(body.form)) throw bad("会议形式不合法");
  if ("dept" in body && body.dept && !DEPTS.includes(body.dept)) throw bad("承办部门不合法");
  if ("date" in body && !/^\d{4}-\d{2}-\d{2}$/.test(String(body.date))) throw bad("会议日期格式应为 YYYY-MM-DD");
}

function listProjects(user, { status, q, assoc, stage } = {}) {
  const { sql, params } = scopeFilter(user);
  const where = [sql];
  const args = [...params];
  if (status) { where.push("p.status = ?"); args.push(status); }
  if (assoc) { where.push("p.assoc = ?"); args.push(assoc); }
  if (q) { where.push("(p.name LIKE ? OR p.id LIKE ? OR p.owner LIKE ?)"); args.push(`%${q}%`, `%${q}%`, `%${q}%`); }
  if (stage) {
    const map = {
      draft: ["草稿", "待审批"], prep: ["已立项", "筹备中"],
      exec: ["执行中"], verify: ["待核销"], done: ["已核销", "已结算", "已归档"]
    };
    const arr = map[stage] || [];
    if (arr.length) { where.push(`p.status IN (${arr.map(() => "?").join(",")})`); args.push(...arr); }
  }
  const rows = db.prepare(
    `SELECT p.*, (SELECT COUNT(*) FROM payments y WHERE y.pid = p.id) AS pay_cnt,
            (SELECT COALESCE(SUM(y.amount),0) FROM payments y WHERE y.pid = p.id AND y.status='已付款') AS paid_amt
     FROM projects p WHERE ${where.join(" AND ")} ORDER BY p.date DESC, p.id`
  ).all(...args);
  return rows;
}

function detail(project, user) {
  const pid = project.id;
  const members = db.prepare(
    `SELECT u.id, u.name, u.username, u.role, m.role AS member_role FROM project_members m
     JOIN users u ON u.id = m.user_id WHERE m.project_id = ?`
  ).all(pid);
  const approvals = db.prepare("SELECT * FROM approvals WHERE pid = ? ORDER BY created_at DESC, id DESC").all(pid);
  const contracts = db.prepare("SELECT * FROM contracts WHERE pid = ? ORDER BY id").all(pid);
  const payments = db.prepare("SELECT * FROM payments WHERE pid = ? ORDER BY created_at DESC, id DESC").all(pid);
  const guests = db.prepare("SELECT * FROM guests WHERE pid = ? ORDER BY id").all(pid);
  const tasks = db.prepare("SELECT * FROM tasks WHERE pid = ? ORDER BY id").all(pid);
  const issues = db.prepare("SELECT * FROM issues WHERE pid = ? ORDER BY id").all(pid);
  const materials = db.prepare("SELECT * FROM materials WHERE pid = ? ORDER BY id").all(pid);
  const timeline = db.prepare(
    "SELECT at, user_name, role, action, detail FROM audit_logs WHERE target = ? ORDER BY id DESC LIMIT 30"
  ).all(pid);

  return {
    project,
    members,
    approvals,
    contracts,
    payments,
    guests,
    tasks,
    issues,
    materials,
    verification: verification(pid),
    materialsStatus: materialsStatus(pid),
    settlement: settlementOf(pid),
    actions: availableActions(project, user),
    timeline,
    paidTotal: payments.filter((p) => p.status === "已付款").reduce((s, p) => s + p.amount, 0)
  };
}

function register(router) {
  router.get("/api/projects", async (ctx) => {
    const rows = listProjects(ctx.user, ctx.query);
    return { rows, total: rows.length };
  });

  router.post("/api/projects", async (ctx) => {
    assertCan(ctx.user, "project:create", "只有协会管理员 / 会务执行可以发起立项");
    const b = ctx.body || {};
    validate(b);
    const at = now();
    const id = nextId(db, "projects", "id", "MP");
    db.prepare(
      `INSERT INTO projects (id,name,assoc,form,date,days,budget,people,owner,phone,dept,agenda,status,status_at,created_by,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).run(id, b.name, b.assoc, b.form, b.date, Number(b.days) || 1, Number(b.budget), Number(b.people) || 0,
      b.owner, b.phone || "", b.dept || "会务部", b.agenda, "草稿", at, ctx.user.id, at, at);
    db.prepare("INSERT OR IGNORE INTO project_members (project_id,user_id,role) VALUES (?,?,?)").run(id, ctx.user.id, "创建人");
    logAudit({
      user: ctx.user, module: "项目管理", action: "立项申请", target: id,
      detail: `新建「${b.name}」，预算 ¥${Number(b.budget).toLocaleString("zh-CN")}，状态：草稿`, ip: ctx.ip
    });
    return { project: getProject(id), message: `已创建 ${id}，可提交立项审批` };
  });

  router.get("/api/projects/:id", async (ctx) => {
    const p = getProject(ctx.params.id);
    assertProjectVisible(ctx.user, p);
    return detail(p, ctx.user);
  });

  router.patch("/api/projects/:id", async (ctx) => {
    const p = getProject(ctx.params.id);
    assertProjectVisible(ctx.user, p);
    // 资料修改：总管理员恒可；其余需协会管理员及以上，且已归档项目不可改
    if (!isSuper(ctx.user)) {
      if (!["assoc"].includes(ctx.user.role)) throw forbidden("资料修改需要协会管理员或总管理员权限");
      if (p.status === "已归档") throw conflict("已归档项目资料已封存，不可修改");
    }
    const b = ctx.body || {};
    const patch = {};
    for (const k of EDITABLE) if (k in b && String(b[k] ?? "") !== String(p[k] ?? "")) patch[k] = b[k];
    if (!Object.keys(patch).length) return { project: p, message: "没有需要修改的字段" };
    validate({ ...p, ...patch }, true);
    const sets = Object.keys(patch).map((k) => `${k} = ?`).join(", ");
    db.prepare(`UPDATE projects SET ${sets}, updated_at = ? WHERE id = ?`)
      .run(...Object.values(patch).map((v, i) => {
        const k = Object.keys(patch)[i];
        return ["days", "budget", "people"].includes(k) ? Number(v) || 0 : v;
      }), now(), p.id);
    logAudit({
      user: ctx.user, module: "项目管理", action: "资料修改", target: p.id,
      detail: Object.entries(patch).map(([k, v]) => `${k}: ${p[k] ?? "空"} → ${v}`).join("；"), ip: ctx.ip
    });
    return { project: getProject(p.id), message: "资料已更新" };
  });

  router.post("/api/projects/:id/transition", async (ctx) => {
    const p = getProject(ctx.params.id);
    assertProjectVisible(ctx.user, p);
    const { action, comment } = ctx.body || {};
    if (!action) throw bad("缺少 action");
    const r = transition(p.id, action, ctx.user, { comment }, ctx.ip);
    return r;
  });

  router.post("/api/projects/:id/members", async (ctx) => {
    const p = getProject(ctx.params.id);
    assertProjectVisible(ctx.user, p);
    assertCan(ctx.user, "project:member", "只有协会管理员或总管理员可以调整项目成员");
    const { user_id, remove } = ctx.body || {};
    const u = db.prepare("SELECT * FROM users WHERE id = ?").get(Number(user_id));
    if (!u) throw notFound("用户不存在");
    if (remove) {
      db.prepare("DELETE FROM project_members WHERE project_id = ? AND user_id = ?").run(p.id, u.id);
      logAudit({ user: ctx.user, module: "项目管理", action: "移出成员", target: p.id, detail: `移出 ${u.name}`, ip: ctx.ip });
      return { members: db.prepare("SELECT u.id,u.name,u.role FROM project_members m JOIN users u ON u.id=m.user_id WHERE m.project_id=?").all(p.id), message: `已移出 ${u.name}` };
    }
    db.prepare("INSERT OR IGNORE INTO project_members (project_id,user_id,role) VALUES (?,?,?)").run(p.id, u.id, "成员");
    logAudit({ user: ctx.user, module: "项目管理", action: "增加成员", target: p.id, detail: `增加 ${u.name}（${ROLES[u.role].name}）`, ip: ctx.ip });
    return { members: db.prepare("SELECT u.id,u.name,u.role FROM project_members m JOIN users u ON u.id=m.user_id WHERE m.project_id=?").all(p.id), message: `已加入 ${u.name}` };
  });

  router.get("/api/projects/:id/timeline", async (ctx) => {
    const p = getProject(ctx.params.id);
    assertProjectVisible(ctx.user, p);
    return { rows: db.prepare("SELECT * FROM audit_logs WHERE target = ? ORDER BY id DESC").all(p.id) };
  });

  return router;
}

module.exports = { register, listProjects, detail };
