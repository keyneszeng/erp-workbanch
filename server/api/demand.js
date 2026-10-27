"use strict";
const { db, transaction } = require("../lib/db");
const { now, bad, notFound, conflict, yuan, toCsv } = require("../lib/util");
const { assertCan, assertProjectVisible } = require("../lib/rbac");
const { logAudit } = require("../lib/audit");
const { listProjects } = require("./projects");
const { getProject, assertNotFrozen } = require("../lib/workflow");
const { DEMAND_GROUPS, DEMAND_TEMPLATE, DEMAND_NEED_OPTIONS } = require("../lib/constants");

const MAX_LEN = { item: 40, spec: 200, owner: 20, due: 20, note: 120 };

const money2 = (n) => Number(n || 0).toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/**
 * 预算金额只收数字。
 * 「预算归属」改成「预算金额」之后，这一列要能合计、能跟核销的费用构成对照，
 * 混进「会务预算」这种文字就失去意义了。
 * 空值合法（这一项还没定价），非空必须是 ≤2 位小数的非负数。
 */
function parseAmount(v, itemName) {
  const s = String(v === undefined || v === null ? "" : v).trim();
  if (!s) return "";
  if (!/^\d+(\.\d{1,2})?$/.test(s)) {
    throw bad(`「${itemName}」的预算金额只能填数字（最多两位小数），当前填的是「${s}」`);
  }
  if (Number(s) > 1e9) throw bad(`「${itemName}」的预算金额过大`);
  return s;
}

function checkItem(it) {
  if (it.need !== undefined && !DEMAND_NEED_OPTIONS.includes(it.need)) throw bad(`「${it.item || ""}」的「是否需要」取值非法`);
  for (const [k, max] of Object.entries(MAX_LEN)) {
    if (it[k] === undefined || it[k] === null) continue;
    if (String(it[k]).length > max) throw bad(`「${it.item || ""}」的${k}字段不能超过 ${max} 字`);
  }
}

/** 归档后是否允许再改：确认即归档，需求单从此是核销的执行依据 */
function assertNotArchived(sheet) {
  if (sheet && sheet.confirmed) {
    throw conflict(
      "会务需求已归档，不能再修改。如需调整请先「撤销归档」",
      "DEMAND_ARCHIVED",
      { confirmed_by: sheet.confirmed_by || "", confirmed_at: sheet.confirmed_at || "" }
    );
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
        item: r.item, note: r.note, need: r.need, spec: r.spec || "",
        owner: r.owner || "", due: r.due || "", budget: r.budget || ""
      });
    }
  } else {
    // 按模板生成（带默认 需要）
    for (const g of DEMAND_GROUPS) {
      for (const t of (DEMAND_TEMPLATE[g] || [])) {
        groups[g].push({
          item: t.item, note: t.note || "", need: "需要", spec: "", owner: "", due: "", budget: ""
        });
      }
    }
    built = true;
  }
  // 预算合计只算「需要」项：选了不需要的条目，钱不花，不该进合计
  let total = 0;
  for (const g of DEMAND_GROUPS) {
    for (const it of groups[g]) if (it.need === "需要") total += Number(it.budget) || 0;
  }
  return {
    pid,
    confirmed: sheet ? !!sheet.confirmed : false,
    archived: sheet ? !!sheet.confirmed : false,
    confirmed_by: sheet ? sheet.confirmed_by : null,
    confirmed_at: sheet ? sheet.confirmed_at : null,
    groups: DEMAND_GROUPS,
    items: groups,
    needOptions: DEMAND_NEED_OPTIONS,
    budgetTotal: yuan(total),
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
    // 条目名统一 trim 后再算唯一键：否则「台卡」和「台卡 」会被当成两条，
    // 存进库里视觉上完全重复，而 UNIQUE 约束又拦不住（精确比较）。
    const item = String(it.item).trim();
    const key = `${it.grp}@@${item}`;
    if (seen.has(key)) continue;
    seen.add(key);
    // attach / status 已从业务上取消，列保留给旧数据，新写入统一置空
    ins.run(pid, it.grp, item, it.note || "", it.need || "需要", it.spec || "", it.owner || "",
      it.due || "", it.budget || "", "", "未开始", order++, at);
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
              COUNT(*) AS total,
              COALESCE(ROUND(SUM(CASE WHEN need='需要' THEN CAST(budget AS REAL) ELSE 0 END),2),0) AS budget_sum
       FROM demand_items GROUP BY pid`
    ).all();
    const map = {};
    for (const a of agg) map[a.pid] = a;
    const sheetMap = {};
    for (const r of db.prepare("SELECT pid, confirmed, confirmed_by, confirmed_at FROM demand_sheets").all()) {
      sheetMap[r.pid] = r;
    }
    const projects = rows.map((p) => {
      const a = map[p.id];
      const s = sheetMap[p.id];
      return {
        id: p.id, name: p.name, assoc: p.assoc, status: p.status, date: p.date,
        demandBuilt: !!a,
        needCount: a ? a.need_cnt : 0,
        budgetTotal: a ? yuan(a.budget_sum) : 0,
        confirmed: !!(s && s.confirmed),
        confirmedBy: s && s.confirmed ? s.confirmed_by : "",
        confirmedAt: s && s.confirmed ? s.confirmed_at : ""
      };
    });
    return { projects, groups: DEMAND_GROUPS, needOptions: DEMAND_NEED_OPTIONS };
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
    assertNotArchived(db.prepare("SELECT * FROM demand_sheets WHERE pid = ?").get(p.id));
    const b = ctx.body || {};
    if (!Array.isArray(b.items)) throw bad("缺少 items 数组");
    if (b.items.length > 200) throw bad("需求条目过多");
    /**
     * 空数组必须拒绝。
     * 整单替换是「先删后插」，提交 [] 会把条目全删光，而 loadSheet 见库里没条目
     * 就按模板返回 —— 单据从「已建」静默变回「未建单」，列表页 demandBuilt 变 false，
     * 审计却写「更新 0 条需求」。前端有拦截，但接口不能靠前端。
     * 真要清空，走「重置」，那条路有独立的审计和归档/冻结拦截。
     */
    if (b.items.length === 0) throw bad("至少要有一条需求条目；如需清空请用「重置」", "EMPTY_SHEET");
    // demand_items 有 UNIQUE(pid, grp, item)，同一分组内条目名必须唯一。
    // 原来靠 replaceItems 里的 seen 集合静默跳过重复项 —— 用户提交 10 条只存 9 条，
    // 接口返回 200、审计还写「更新 10 条」，账实不符。这里直接拒绝并指出是哪一条。
    const seen = new Set();
    for (const it of b.items) {
      if (!DEMAND_GROUPS.includes(it.grp)) throw bad(`分组「${it.grp || ""}」非法`);
      // 名字统一 trim 后再校验、判重、入库：三处用同一份值，
      // 否则「台卡」与「台卡 」在长度校验上算两个长度，在唯一键上又算同一个
      const name = String(it.item === undefined || it.item === null ? "" : it.item).trim();
      if (!name) throw bad("存在未命名的需求条目");
      it.item = name;
      const key = `${it.grp}@@${name}`;
      if (seen.has(key)) {
        throw bad(`「${it.grp}」分组下存在重复条目「${name}」，同一分组内条目名必须唯一`, "DUPLICATE_ITEM");
      }
      seen.add(key);
      it.budget = parseAmount(it.budget, name);
      checkItem(it);
    }
    const at = ensureSheet(p.id);
    // 事务走 db 层统一入口：Node 用 BEGIN/COMMIT，Cloudflare 用 transactionSync
    transaction(() => replaceItems(p.id, b.items, at));
    const needCnt = b.items.filter((x) => x.need === "需要").length;
    const total = yuan(b.items.filter((x) => x.need === "需要").reduce((s, x) => s + (Number(x.budget) || 0), 0));
    logAudit({
      user: ctx.user, module: "会务需求", action: "保存需求单", target: p.id,
      detail: `更新 ${b.items.length} 条需求（需要 ${needCnt} 项，预算合计 ¥${money2(total)}）`, ip: ctx.ip
    });
    return { sheet: loadSheet(p.id), message: "会务需求已保存" };
  });

  // 确认需求单 = 归档：确认后这份单子就是后续核销的执行依据，不再随手改
  router.post("/api/demand/:id/confirm", async (ctx) => {
    assertCan(ctx.user, "demand:write", "只有协会管理员 / 会务执行可以确认会务需求");
    const p = getProject(ctx.params.id);
    if (!p) throw notFound("会议项目不存在");
    assertProjectVisible(ctx.user, p);
    assertNotFrozen(p, "会务需求");
    const sheetRow = db.prepare("SELECT * FROM demand_sheets WHERE pid = ?").get(p.id);
    if (sheetRow && sheetRow.confirmed) throw conflict("会务需求已归档，无需重复确认", "DEMAND_ARCHIVED");
    const at = now();
    ensureSheet(p.id);
    // 若尚未建条目，先按模板落库再确认
    if (!db.prepare("SELECT 1 FROM demand_items WHERE pid = ?").get(p.id)) {
      replaceItems(p.id, flattenTemplate(), at);
    }
    db.prepare("UPDATE demand_sheets SET confirmed=1, confirmed_by=?, confirmed_at=?, updated_at=? WHERE pid=?")
      .run(ctx.user.name, at, at, p.id);
    const s = loadSheet(p.id);
    const needCnt = Object.values(s.items).flat().filter((x) => x.need === "需要").length;
    logAudit({
      user: ctx.user, module: "会务需求", action: "归档需求单", target: p.id,
      detail: `会务需求确认并归档：需要 ${needCnt} 项，预算合计 ¥${money2(s.budgetTotal)}（后续核销以此为依据）`,
      ip: ctx.ip
    });
    return { sheet: s, message: "已确认并归档会务需求" };
  });

  // 撤销归档：填错了总得能改，但每次撤销都留痕
  router.post("/api/demand/:id/unarchive", async (ctx) => {
    assertCan(ctx.user, "demand:write", "只有协会管理员 / 会务执行可以撤销归档");
    const p = getProject(ctx.params.id);
    if (!p) throw notFound("会议项目不存在");
    assertProjectVisible(ctx.user, p);
    assertNotFrozen(p, "会务需求");
    const sheetRow = db.prepare("SELECT * FROM demand_sheets WHERE pid = ?").get(p.id);
    if (!sheetRow || !sheetRow.confirmed) throw conflict("会务需求尚未归档，无需撤销", "NOT_ARCHIVED");
    const at = now();
    db.prepare("UPDATE demand_sheets SET confirmed=0, confirmed_by=NULL, confirmed_at=NULL, updated_at=? WHERE pid=?")
      .run(at, p.id);
    logAudit({
      user: ctx.user, module: "会务需求", action: "撤销归档", target: p.id,
      detail: `撤销会务需求归档（原确认人 ${sheetRow.confirmed_by || "—"} 于 ${sheetRow.confirmed_at || "—"} 确认）`,
      ip: ctx.ip
    });
    return { sheet: loadSheet(p.id), message: "已撤销归档，需求单回到草稿可编辑" };
  });

  // 重置需求单（清空条目与确认状态，回到模板）
  router.post("/api/demand/:id/reset", async (ctx) => {
    assertCan(ctx.user, "demand:write", "只有协会管理员 / 会务执行可以重置会务需求");
    const p = getProject(ctx.params.id);
    if (!p) throw notFound("会议项目不存在");
    assertProjectVisible(ctx.user, p);
    // 重置会 DELETE 全部条目，冻结后执行等于销毁历史，比「修改」更该拦
    assertNotFrozen(p, "会务需求");
    assertNotArchived(db.prepare("SELECT * FROM demand_sheets WHERE pid = ?").get(p.id));
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
    const headers = ["分组", "项目", "业务提示", "是否需要", "规格数量", "负责人", "交付时间", "预算金额"];
    const rows = [];
    for (const g of DEMAND_GROUPS) {
      for (const it of (sheet.items[g] || [])) {
        rows.push([g, it.item, it.note || "", it.need, it.spec || "", it.owner || "", it.due || "",
          it.budget ? Number(it.budget).toFixed(2) : ""]);
      }
    }
    rows.push(["合计", "", "", "", "", "", "预算合计", Number(sheet.budgetTotal).toFixed(2)]);
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
      out.push({ grp: g, item: t.item, note: t.note || "", need: "需要", spec: "", owner: "", due: "", budget: "", ordering: order++ });
    }
  }
  return out;
}

module.exports = { register, loadSheet };
