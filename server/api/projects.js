"use strict";
const { db } = require("../lib/db");
const { now, nextId, bad, notFound, conflict, forbidden, cents, yuan } = require("../lib/util");
const { assertCan, assertProjectVisible, can, isSuper, scopeFilter, ROLES } = require("../lib/rbac");
const { logAudit } = require("../lib/audit");
const { getProject, verification, materialsStatus, settlementOf, demandSummary, assertNotFrozen, committed, availableActions, transition } = require("../lib/workflow");
const { ASSOCS, FORMS, DEPTS } = require("../lib/constants");
const { readPaging, countOf } = require("../lib/paginate");

const EDITABLE = ["name", "assoc", "form", "date", "days", "budget", "people", "owner", "phone", "dept", "agenda"];

/**
 * 账目基准字段：结算单的 income 直接取 projects.budget，
 * 结算后改预算会让 settlements.income 与 projects.budget 永久对不上。
 * 只列真正进结算的字段，别把 days / people 也算进来（它们不影响金额）。
 */
const MONEY_FIELDS = ["budget"];
const MONEY_LABEL = { budget: "预算" };

/** 字段长度上限（字符数），防止超长文本撑爆列表 / 导出 / 前端渲染 */
const MAX_LEN = { name: 80, assoc: 40, owner: 20, phone: 20, dept: 40, agenda: 2000 };
const LEN_LABEL = { name: "会议名称", assoc: "所属协会", owner: "项目负责人", phone: "联系电话", dept: "承办部门", agenda: "初版议程要点" };

function checkLength(body) {
  for (const [k, max] of Object.entries(MAX_LEN)) {
    if (!(k in body)) continue;
    const v = body[k];
    if (v === undefined || v === null) continue;
    if (String(v).length > max) throw bad(`${LEN_LABEL[k]}不能超过 ${max} 字（当前 ${String(v).length} 字）`);
  }
}

/**
 * 负责人姓名 → 用户 id。
 * 优先认「就是当前操作者」—— 执行人员给自己建项目是最常见的情形，
 * 重名时也不该被绑到别人头上；否则取系统里同名的第一个账号。
 * 查不到（例如负责人填「待定」）返回 null，此时数据范围退回姓名比对。
 */
function resolveOwnerId(name, actor) {
  const n = String(name || "").trim();
  if (!n) return null;
  if (actor && actor.name === n) return actor.id;
  const row = db.prepare("SELECT id FROM users WHERE name = ? ORDER BY id LIMIT 1").get(n);
  return row ? row.id : null;
}

function validate(body, partial = false) {
  const need = { name: "会议名称", assoc: "所属协会", form: "会议形式", date: "会议日期", budget: "预算", owner: "项目负责人", agenda: "初版议程要点" };
  for (const [k, label] of Object.entries(need)) {
    if (partial && !(k in body)) continue;
    const v = body[k];
    if (v === undefined || v === null || String(v).trim() === "") throw bad(`${label}为必填项`);
  }
  checkLength(body);
  if ("budget" in body) {
    const n = Number(body.budget);
    if (!(n > 0)) throw bad("预算必须大于 0");
    if (!Number.isFinite(n)) throw bad("预算必须是数字");
    if (n > 1e9) throw bad("预算不能超过 10 亿元");
    if (Number(n.toFixed(2)) !== n) throw bad("预算最多保留两位小数");
  }
  if ("people" in body && body.people !== "" && body.people !== null && body.people !== undefined) {
    const n = Number(body.people);
    if (!Number.isInteger(n) || n < 0) throw bad("预计参会人数必须是非负整数");
    if (n > 100000) throw bad("预计参会人数不能超过 100000");
  }
  if ("days" in body && body.days !== "" && body.days !== null && body.days !== undefined) {
    const n = Number(body.days);
    if (!Number.isInteger(n) || n < 1) throw bad("会期至少 1 天");
    if (n > 60) throw bad("会期不能超过 60 天");
  }
  if ("assoc" in body && !ASSOCS.includes(body.assoc)) throw bad("所属协会不在可选范围");
  if ("form" in body && !FORMS.includes(body.form)) throw bad("会议形式不合法");
  if ("dept" in body && body.dept && !DEPTS.includes(body.dept)) throw bad("承办部门不合法");
  if ("date" in body) {
    const s = String(body.date);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) throw bad("会议日期格式应为 YYYY-MM-DD");
    const d = new Date(`${s}T00:00:00Z`);
    if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== s) throw bad(`会议日期 ${s} 不是有效日期`);
  }
}

function listProjects(user, { status, q, assoc, stage, page, size } = {}) {
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
  const whereSql = where.join(" AND ");
  const paging = readPaging({ page, size });

  // 未请求分页时保持原样返回数组（旧调用方零影响）
  if (!paging) {
    return db.prepare(
      `SELECT p.*, (SELECT COUNT(*) FROM payments y WHERE y.pid = p.id) AS pay_cnt,
              (SELECT COALESCE(ROUND(SUM(y.amount),2),0) FROM payments y WHERE y.pid = p.id AND y.status='已付款') AS paid_amt,
              (SELECT COUNT(*) FROM verify_steps v WHERE v.pid = p.id AND v.result IN ('通过','已解例外')) AS v_passed,
              (SELECT COUNT(*) FROM exceptions e WHERE e.pid = p.id AND e.status='待审批') AS ex_open,
              (SELECT id FROM settlements s WHERE s.pid = p.id) AS st_id
       FROM projects p WHERE ${whereSql} ORDER BY p.date DESC, p.id`
    ).all(...args);
  }

  // COUNT 只数主表，四个相关子查询不影响行数
  const total = countOf(db.prepare(`SELECT COUNT(*) AS c FROM projects p WHERE ${whereSql}`).get(...args));
  // 预算 / 已付款的全量汇总：分页后前端只拿得到一页，合计必须由后端给
  const agg = db.prepare(
    `SELECT COALESCE(SUM(p.budget),0) AS budget,
            COALESCE(ROUND(SUM((SELECT COALESCE(SUM(y.amount),0) FROM payments y WHERE y.pid = p.id AND y.status='已付款')),2),0) AS paid
     FROM projects p WHERE ${whereSql}`
  ).get(...args);
  const rows = db.prepare(
    `SELECT p.*, (SELECT COUNT(*) FROM payments y WHERE y.pid = p.id) AS pay_cnt,
            (SELECT COALESCE(ROUND(SUM(y.amount),2),0) FROM payments y WHERE y.pid = p.id AND y.status='已付款') AS paid_amt,
            (SELECT COUNT(*) FROM verify_steps v WHERE v.pid = p.id AND v.result IN ('通过','已解例外')) AS v_passed,
            (SELECT COUNT(*) FROM exceptions e WHERE e.pid = p.id AND e.status='待审批') AS ex_open,
            (SELECT id FROM settlements s WHERE s.pid = p.id) AS st_id
     FROM projects p WHERE ${whereSql} ORDER BY p.date DESC, p.id LIMIT ? OFFSET ?`
  ).all(...args, paging.size, paging.offset);

  return {
    rows,
    total,
    page: paging.page,
    size: paging.size,
    pages: Math.max(1, Math.ceil(total / paging.size)),
    paged: true,
    summary: { budget: Number(agg.budget) || 0, paid: Number(agg.paid) || 0 }
  };
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
    // 核销第 3 步的费用对照基准。项目详情页的核销页签读的是这个接口，
    // 之前只在 /verify 里返回，导致同一个第 3 步在两个页面给出不同答案。
    demand: demandSummary(pid),
    actions: availableActions(project, user),
    timeline,
    // 与 /verify 的 paidTotal 必须同口径：裸 reduce 会留浮点尾巴（0.1+0.2 → 0.30000000000000004），
    // 而核销页签第 3 步的「其中已付款」直接显示这个数 —— 两个页面就会给出不同金额。
    paidTotal: yuan(payments.filter((p) => p.status === "已付款").reduce((s, p) => s + Number(p.amount), 0))
  };
}

function register(router) {
  router.get("/api/projects", async (ctx) => {
    const r = listProjects(ctx.user, ctx.query);
    // 未请求分页时 listProjects 返回数组，保持旧返回结构
    if (Array.isArray(r)) return { rows: r, total: r.length };
    return r;
  });

  router.post("/api/projects", async (ctx) => {
    assertCan(ctx.user, "project:create", "只有协会管理员 / 会务执行可以发起立项");
    const b = ctx.body || {};
    validate(b);
    const at = now();
    const id = nextId(db, "projects", "id", "MP");
    db.prepare(
      `INSERT INTO projects (id,name,assoc,form,date,days,budget,people,owner,owner_id,phone,dept,agenda,status,status_at,created_by,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).run(id, b.name, b.assoc, b.form, b.date, Number(b.days) || 1, Number(b.budget), Number(b.people) || 0,
      b.owner, resolveOwnerId(b.owner, ctx.user), b.phone || "", b.dept || "会务部", b.agenda, "草稿", at, ctx.user.id, at, at);
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
    // 资料修改：总管理员恒可；其余需协会管理员及以上，且已结算 / 已归档项目不可改
    if (!isSuper(ctx.user)) {
      if (!["assoc"].includes(ctx.user.role)) throw forbidden("资料修改需要协会管理员或总管理员权限");
      if (p.status === "已归档") throw conflict("已归档项目资料已封存，不可修改");
      // 已结算 = 账目封账，结算单已按当时的预算与合同算完。
      // 此处若不拦，改完预算就和结算单永久对不上了（原来只拦了「已归档」）。
      if (p.status === "已结算") {
        throw conflict("已结算项目账目已封账，不可修改资料；如需纠错请联系总管理员", "FROZEN", { status: p.status });
      }
    }
    const b = ctx.body || {};

    // 超管用 force 越过任何一道账目检查，都必须在审计里能看出来。
    // 只有「真的绕过了检查」才算 force，随手带个 force 标记的正常修改不该被标成纠错。
    let forced = false;

    // 金额类字段是结算单的计算基准，已结算 / 已归档后改动会让账实不符。
    // 保留总管理员的纠错能力，但必须显式带 force，和付款超预算的特批口径一致。
    if (["已结算", "已归档"].includes(p.status)) {
      const touched = MONEY_FIELDS.filter((k) => k in b && Number(b[k]) !== Number(p[k]));
      if (touched.length) {
        if (!(b.force && isSuper(ctx.user))) {
          throw conflict(
            `项目已「${p.status}」，${touched.map((k) => MONEY_LABEL[k] || k).join("、")} 属于账目基准数据，` +
            `改动会与已生成的结算单不一致；如确需纠错，请由总管理员携带 force 标记提交`,
            "FROZEN", { status: p.status, fields: touched }
          );
        }
        forced = true;
      }
    }

    const patch = {};
    for (const k of EDITABLE) if (k in b && String(b[k] ?? "") !== String(p[k] ?? "")) patch[k] = b[k];
    if (!Object.keys(patch).length) return { project: p, message: "没有需要修改的字段" };
    validate({ ...p, ...patch }, true);

    // 预算下调到低于已占用金额（待审批 + 已审批 + 已付款）会让账实直接打架：
    // 结算单 income 取 projects.budget、expense 取已付款，income < expense 就是负结余。
    // 上调不拦（只会更宽松），只有下调且低于已占用才卡；超管可 force 纠错。
    if ("budget" in patch) {
      const next = yuan(patch.budget);
      const used = committed(p.id);
      // 比较走「分」：3580.23 与 3580.2300000000005 在浮点里是「小于」，会误判成下调过低
      if (cents(next) < cents(used)) {
        if (!(b.force && isSuper(ctx.user))) {
          throw conflict(
            `新预算 ¥${next.toLocaleString("zh-CN")} 低于该项目已占用金额 ¥${used.toLocaleString("zh-CN")}` +
            `（含待审批 / 已审批 / 已付款），下调后会与已挂账的付款冲突；` +
            `如确需纠错，请由总管理员携带 force 标记提交`,
            "BUDGET_BELOW_COMMITTED", { budget: next, used }
          );
        }
        forced = true;
      }
    }

    // 负责人改名时同步重算 owner_id，否则数据范围还挂在旧的人身上
    if ("owner" in patch) patch.owner_id = resolveOwnerId(patch.owner, ctx.user);
    const sets = Object.keys(patch).map((k) => `${k} = ?`).join(", ");
    db.prepare(`UPDATE projects SET ${sets}, updated_at = ? WHERE id = ?`)
      .run(...Object.values(patch).map((v, i) => {
        const k = Object.keys(patch)[i];
        return ["days", "budget", "people"].includes(k) ? Number(v) || 0 : v;
      }), now(), p.id);
    logAudit({
      user: ctx.user, module: "项目管理", action: forced ? "资料修改（强制纠错）" : "资料修改", target: p.id,
      detail: Object.entries(patch).map(([k, v]) => `${k}: ${p[k] ?? "空"} → ${v}`).join("；")
        + (forced ? `（${p.status}项目，总管理员 force）` : ""), ip: ctx.ip
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
    // 成员关系直接决定数据范围：结算 / 归档后再加人，
    // 等于让新人凭一次操作就能看到已经封账的项目与封存的卷宗。
    assertNotFrozen(p, "项目成员");
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
