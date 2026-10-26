"use strict";
const { db, transaction } = require("../lib/db");
const { now } = require("../lib/util");
const { bad, notFound, forbidden, conflict } = require("../lib/util");
const { assertCan, assertProjectVisible, scopeFilter, ROLES } = require("../lib/rbac");
const { logAudit } = require("../lib/audit");
const { listProjects } = require("./projects");
const { getProject, assertNotFrozen } = require("../lib/workflow");
const { DEMAND_GROUPS, DEMAND_TEMPLATE, DEMAND_NEED_OPTIONS, DEMAND_STATUS_OPTIONS } = require("../lib/constants");
const { toCsv } = require("../lib/util");

const MAX_LEN = { spec: 200, owner: 20, due: 20, budget: 40, attach: 120, status: 20, need: 20, note: 120 };

function checkItem(it) {
  if (it.need !== undefined && !DEMAND_NEED_OPTIONS.includes(it.need)) throw bad(`「${it.item || ""}」的「是否需要」取值非法`);
  if (it.status !== undefined && !DEMAND_STATUS_OPTIONS.includes(it.status)) throw bad(`「${it.item || ""}」的「执行状态」取值非法`);
  for (const [k, max] of Object.entries(MAX_LEN)) {
    if (it[k] === undefined || it[k] === null) continue;
    if (String(it[k]).length > max) throw bad(`「${it.item || ""}」的${k}字段不能超过 ${max} 字`);
  }
}

/** 读取某项目的需求单；若尚未建单，按模板生成（不落库，供前端首次编辑） */
function loadSheet(pid) {
  const rows = db.prepare("SELECT * FROM demand_items WHERE pid = ? ORDER BY ordering, id").all(pid);
  const sheet = db.prepare("SELECT * FROM demand_sheets WHERE pid = ?").get(pid);
  const groups = {};
  for (const g of DEMAND_GROUPS) groups[g] = [];
  let built = false;
  if (rows.length) {
    for (const r of rows) {
      if (!groups[r.grp]) groups[r.grp] = [];
      groups[r.grp].push({
        item: r.item, note: r.note, need: r.need, spec: r.spec || "", owner: r.owner || "",
        due: r.due || "", budget: r.budget || "", attach: r.attach || "", status: r.status
      });
    }
  } else {
    // 按模板生成（带默认 需要 / 未开始）
    let order = 0;
    for (const g of DEMAND_GROUPS) {
      for (const t of (DEMAND_TEMPLATE[g] || [])) {
        groups[g].push({
          item: t.item, note: t.note || "", need: "需要", spec: "", owner: "", due: "",
          budget: "", attach: "", status: "未开始"
        });
        order++;
      }
    }
    built = true;
  }
  return {
    pid,
    confirmed: sheet ? !!sheet.confirmed : false,
    confirmed_by: sheet ? sheet.confirmed_by : null,
    confirmed_at: sheet ? sheet.confirmed_at : null,
    groups: DEMAND_GROUPS,
    items: groups,
    needOptions: DEMAND_NEED_OPTIONS,
    statusOptions: DEMAND_STATUS_OPTIONS,
    isTemplate: built
  };
}

function ensureSheet(pid) {
  const at = now();
  db.prepare(
    `INSERT OR IGNORE INTO demand_sheets (pid, confirmed, created_at, updated_at)
     VALUES (?, 0, ?, ?)`
  ).run(pid, at, at);
  return at;
}

function replaceItems(pid, items, at) {
  db.prepare("DELETE FROM demand_items WHERE pid = ?").run(pid);
  const ins = db.prepare(
    `INSERT OR REPLACE INTO demand_items (pid, grp, item, note, need, spec, owner, due, budget, attach, status, ordering, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`
  );
  let order = 0;
  const seen = new Set();
  for (const it of items) {
    const key = `${it.grp}@@${it.item}`;
    if (seen.has(key)) continue;
    seen.add(key);
    ins.run(pid, it.grp, it.item, it.note || "", it.need || "需要", it.spec || "", it.owner || "",
      it.due || "", it.budget || "", it.attach || "", it.status || "未开始", order++, at);
  }
  db.prepare("UPDATE demand_sheets SET updated_at = ? WHERE pid = ?").run(at, pid);
}

function register(router) {
  // 列表：按数据范围列出会议 + 各会议需求单汇总
  router.get("/api/demand", async (ctx) => {
    const rows = listProjects(ctx.user, {});
    const agg = db.prepare(
      `SELECT pid,
              SUM(CASE WHEN need='需要' THEN 1 ELSE 0 END) AS need_cnt,
              SUM(CASE WHEN need='需要' AND status='已完成' THEN 1 ELSE 0 END) AS done_cnt,
              COUNT(*) AS total
       FROM demand_items GROUP BY pid`
    ).all();
    const map = {};
    for (const a of agg) map[a.pid] = a;
    const confirmedSet = new Set(
      db.prepare("SELECT pid FROM demand_sheets WHERE confirmed=1").all().map((r) => r.pid)
    );
    const projects = rows.map((p) => {
      const a = map[p.id];
      return {
        id: p.id, name: p.name, assoc: p.assoc, status: p.status, date: p.date,
        demandBuilt: !!a,
        needCount: a ? a.need_cnt : 0,
        doneCount: a ? a.done_cnt : 0,
        confirmed: confirmedSet.has(p.id)
      };
    });
    return { projects, groups: DEMAND_GROUPS, needOptions: DEMAND_NEED_OPTIONS, statusOptions: DEMAND_STATUS_OPTIONS };
  });

  // 详情：单项目的需求单（首次打开返回模板）
  router.get("/api/demand/:id", async (ctx) => {
    const p = getProject(ctx.params.id);
    if (!p) throw notFound("会议项目不存在");
    assertProjectVisible(ctx.user, p);
    const sheet = loadSheet(p.id);
    sheet.projectName = p.name;
    return sheet;
  });

  // 保存：整单替换（协会管理员 / 会务执行可写）
  router.patch("/api/demand/:id", async (ctx) => {
    assertCan(ctx.user, "demand:write", "只有协会管理员 / 会务执行可以维护会务需求");
    const p = getProject(ctx.params.id);
    if (!p) throw notFound("会议项目不存在");
    assertProjectVisible(ctx.user, p);
    // 结算后需求单是执行依据的原始记录，归档后更属封存卷宗，都不该再改
    assertNotFrozen(p, "会务需求");
    const b = ctx.body || {};
    if (!Array.isArray(b.items)) throw bad("缺少 items 数组");
    if (b.items.length > 200) throw bad("需求条目过多");
    for (const it of b.items) {
      if (!DEMAND_GROUPS.includes(it.grp)) throw bad(`分组「${it.grp || ""}」非法`);
      if (!it.item || !String(it.item).trim()) throw bad("存在未命名的需求条目");
      checkItem(it);
    }
    const at = ensureSheet(p.id);
    // 事务走 db 层统一入口：Node 用 BEGIN/COMMIT，Cloudflare 用 transactionSync
    transaction(() => replaceItems(p.id, b.items, at));
    logAudit({
      user: ctx.user, module: "会务需求", action: "保存需求单", target: p.id,
      detail: `更新 ${b.items.length} 条需求（需要 ${b.items.filter((x) => x.need === "需要").length} 项）`, ip: ctx.ip
    });
    return { sheet: loadSheet(p.id), message: "会务需求已保存" };
  });

  // 确认需求单
  router.post("/api/demand/:id/confirm", async (ctx) => {
    assertCan(ctx.user, "demand:write", "只有协会管理员 / 会务执行可以确认会务需求");
    const p = getProject(ctx.params.id);
    if (!p) throw notFound("会议项目不存在");
    assertProjectVisible(ctx.user, p);
    assertNotFrozen(p, "会务需求");
    const at = now();
    ensureSheet(p.id);
    // 若尚未建条目，先按模板落库再确认
    if (!db.prepare("SELECT 1 FROM demand_items WHERE pid = ?").get(p.id)) {
      replaceItems(p.id, flattenTemplate(), at);
    }
    db.prepare("UPDATE demand_sheets SET confirmed=1, confirmed_by=?, confirmed_at=?, updated_at=? WHERE pid=?")
      .run(ctx.user.name, at, at, p.id);
    logAudit({ user: ctx.user, module: "会务需求", action: "确认需求单", target: p.id, detail: "会务需求确认完毕", ip: ctx.ip });
    return { sheet: loadSheet(p.id), message: "已确认会务需求" };
  });

  // 重置需求单（清空条目与确认状态，回到模板）
  router.post("/api/demand/:id/reset", async (ctx) => {
    assertCan(ctx.user, "demand:write", "只有协会管理员 / 会务执行可以重置会务需求");
    const p = getProject(ctx.params.id);
    if (!p) throw notFound("会议项目不存在");
    assertProjectVisible(ctx.user, p);
    // 重置会 DELETE 全部条目，冻结后执行等于销毁历史，比「修改」更该拦
    assertNotFrozen(p, "会务需求");
    db.prepare("DELETE FROM demand_items WHERE pid = ?").run(p.id);
    db.prepare("DELETE FROM demand_sheets WHERE pid = ?").run(p.id);
    logAudit({ user: ctx.user, module: "会务需求", action: "重置需求单", target: p.id, detail: "清空需求明细与确认状态", ip: ctx.ip });
    return { sheet: loadSheet(p.id), message: "已重置为模板" };
  });

  // 导出 CSV
  router.get("/api/demand/:id/export", async (ctx) => {
    const p = getProject(ctx.params.id);
    if (!p) throw notFound("会议项目不存在");
    assertProjectVisible(ctx.user, p);
    const sheet = loadSheet(p.id);
    const headers = ["分组", "项目", "业务提示", "是否需要", "规格数量", "负责人", "交付时间", "预算归属", "附件", "执行状态"];
    const rows = [];
    for (const g of DEMAND_GROUPS) {
      for (const it of (sheet.items[g] || [])) {
        rows.push([g, it.item, it.note || "", it.need, it.spec || "", it.owner || "", it.due || "", it.budget || "", it.attach || "", it.status]);
      }
    }
    const csv = toCsv(headers, rows);
    return { __csv: csv, __filename: `会务需求_${p.id}.csv` };
  });

  return router;
}

function flattenTemplate() {
  const out = [];
  let order = 0;
  for (const g of DEMAND_GROUPS) {
    for (const t of (DEMAND_TEMPLATE[g] || [])) {
      out.push({ grp: g, item: t.item, note: t.note || "", need: "需要", spec: "", owner: "", due: "", budget: "", attach: "", status: "未开始", ordering: order++ });
    }
  }
  return out;
}

module.exports = { register, loadSheet };
