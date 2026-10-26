"use strict";
const { db } = require("../lib/db");
const { now, nextId, bad, notFound, conflict, forbidden } = require("../lib/util");
const { assertCan, assertProjectVisible, isSuper } = require("../lib/rbac");
const { logAudit } = require("../lib/audit");
const { getProject, verification, materialsStatus, settlementOf } = require("../lib/workflow");
const { MATERIAL_KINDS } = require("../lib/constants");
const { readPaging, countOf } = require("../lib/paginate");
const { storage } = require("../lib/storage");

function register(router) {
  /** 核销看板：6 步 + 例外 + 结算 + 材料 */
  router.get("/api/projects/:id/verify", async (ctx) => {
    const p = getProject(ctx.params.id);
    assertProjectVisible(ctx.user, p);
    return {
      project: p,
      verification: verification(p.id),
      materialsStatus: materialsStatus(p.id),
      settlement: settlementOf(p.id)
    };
  });

  /** 单步判定 */
  router.post("/api/projects/:id/verify/steps/:no", async (ctx) => {
    const p = getProject(ctx.params.id);
    assertProjectVisible(ctx.user, p);
    assertCan(ctx.user, "verify:check", "当前角色无核销判定权限");
    const no = Number(ctx.params.no);
    if (!(no >= 1 && no <= 6)) throw bad("步骤编号应为 1~6");
    const settled = settlementOf(p.id);
    if (settled && !isSuper(ctx.user)) throw conflict("结算单已生成，核销结论已冻结，不可修改", "FROZEN");
    if (!["待核销"].includes(p.status) && !(p.status === "已核销" && isSuper(ctx.user))) {
      throw conflict(`当前状态「${p.status}」不可判定核销，只有「待核销」项目可判定`, "ILLEGAL_STATE", { status: p.status });
    }

    const { result, remark } = ctx.body || {};
    if (!["通过", "不通过"].includes(result)) throw bad("判定结果只能是「通过」或「不通过」");
    if (String(remark || "").length > 1000) throw bad(`问题描述不能超过 1000 字（当前 ${String(remark).length} 字）`);
    if (result === "不通过" && !String(remark || "").trim()) throw bad("判定不通过必须填写问题描述");

    const v = verification(p.id);
    const prev = v.steps.filter((s) => s.no < no);
    const unjudged = prev.filter((s) => s.result === "待判定");
    if (unjudged.length) throw conflict(`核销必须按顺序判定，第 ${unjudged[0].no} 步尚未判定`, "OUT_OF_ORDER", { step: unjudged[0].no });

    const def = v.steps.find((s) => s.no === no);
    const at = now();
    db.prepare(
      "INSERT OR REPLACE INTO verify_steps (pid,step_no,name,result,remark,checked_by,checked_at) VALUES (?,?,?,?,?,?,?)"
    ).run(p.id, no, def.name, result, String(remark || ""), ctx.user.name, at);

    let message = `第 ${no} 步「${def.name}」判定：${result}`;
    if (result === "不通过") {
      const exId = nextId(db, "exceptions", "id", "EX");
      db.prepare("INSERT INTO exceptions (id,pid,step_no,reason,status,created_by,created_at) VALUES (?,?,?,?,?,?,?)")
        .run(exId, p.id, no, String(remark).trim(), "待审批", ctx.user.name, at);
      db.prepare(
        "INSERT INTO approvals (id,type,title,pid,ref_id,amount,by_user,sla,status,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)"
      ).run(nextId(db, "approvals", "id", "AP"), "例外单审批", `${exId} ${String(remark).trim().slice(0, 24)}`, p.id, exId, 0,
        ctx.user.name, "2 个工作日", "待审批", at);
      message += `，已生成例外单 ${exId} 待财务审批`;
    }
    logAudit({
      user: ctx.user, module: "会后核销", action: "结论", target: p.id,
      detail: `第 ${no} 步「${def.name}」判定${result}${remark ? "：" + remark : ""}`, ip: ctx.ip
    });
    return { verification: verification(p.id), message };
  });

  /** 提交例外单（补录） */
  router.post("/api/projects/:id/exceptions", async (ctx) => {
    const p = getProject(ctx.params.id);
    assertProjectVisible(ctx.user, p);
    assertCan(ctx.user, "verify:exception", "当前角色无例外单提交权限");
    const { step_no, reason } = ctx.body || {};
    if (["已结算", "已归档"].includes(p.status)) {
      throw conflict(`项目已「${p.status}」，核销结论已冻结，不可再提交例外单`, "FROZEN", { status: p.status });
    }
    const no = Number(step_no);
    if (!(no >= 1 && no <= 6)) throw bad("例外步骤编号应为 1~6");
    if (!String(reason || "").trim()) throw bad("必须说明例外原因");
    if (String(reason).trim().length > 500) throw bad(`例外原因不能超过 500 字（当前 ${String(reason).trim().length} 字）`);
    const at = now();
    const id = nextId(db, "exceptions", "id", "EX");
    db.prepare("INSERT INTO exceptions (id,pid,step_no,reason,status,created_by,created_at) VALUES (?,?,?,?,?,?,?)")
      .run(id, p.id, no, String(reason).trim(), "待审批", ctx.user.name, at);
    db.prepare(
      "INSERT INTO approvals (id,type,title,pid,ref_id,amount,by_user,sla,status,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)"
    ).run(nextId(db, "approvals", "id", "AP"), "例外单审批", `${id} ${String(reason).trim().slice(0, 24)}`, p.id, id, 0,
      ctx.user.name, "2 个工作日", "待审批", at);
    logAudit({ user: ctx.user, module: "会后核销", action: "例外单", target: p.id, detail: `${id}：${reason}`, ip: ctx.ip });
    return { exceptions: verification(p.id).exceptions, message: `例外单 ${id} 已提交，等待财务审批` };
  });

  /** 例外单审批 */
  router.post("/api/exceptions/:id/decide", async (ctx) => {
    const ex = db.prepare("SELECT * FROM exceptions WHERE id = ?").get(ctx.params.id);
    if (!ex) throw notFound("例外单不存在");
    const p = getProject(ex.pid);
    assertProjectVisible(ctx.user, p);
    assertCan(ctx.user, "verify:exception_approve", "只有财务与核销（或总管理员）可以审批例外单");
    if (ex.status !== "待审批") throw conflict(`例外单已是「${ex.status}」状态，不可重复审批`);
    const { approve, comment } = ctx.body || {};
    if (String(comment || "").length > 500) throw bad("审批意见不能超过 500 字");
    const at = now();
    const status = approve ? "已通过" : "已驳回";
    db.prepare("UPDATE exceptions SET status = ?, approved_by = ?, approved_at = ?, comment = ? WHERE id = ?")
      .run(status, ctx.user.name, at, String(comment || ""), ex.id);
    db.prepare("UPDATE approvals SET status = ?, decided_by = ?, decided_at = ?, comment = ? WHERE ref_id = ? AND type = '例外单审批' AND status = '待审批'")
      .run(approve ? "已通过" : "已驳回", ctx.user.name, at, String(comment || ""), ex.id);
    if (approve) {
      db.prepare("UPDATE verify_steps SET result = '已解例外', remark = ? , checked_by = ?, checked_at = ? WHERE pid = ? AND step_no = ?")
        .run(`例外获批：${ex.reason}`, ctx.user.name, at, ex.pid, ex.step_no);
    } else {
      db.prepare("UPDATE verify_steps SET result = '不通过', remark = ? WHERE pid = ? AND step_no = ?")
        .run(`例外被驳回：${ex.reason}`, ex.pid, ex.step_no);
    }
    logAudit({
      user: ctx.user, module: "会后核销", action: approve ? "例外通过" : "例外驳回", target: ex.pid,
      detail: `${ex.id} 第 ${ex.step_no} 步：${ex.reason}${comment ? "；意见：" + comment : ""}`, ip: ctx.ip
    });
    return { verification: verification(ex.pid), message: `例外单 ${ex.id} ${status}` };
  });

  /** 材料总览（跨项目） */
  router.get("/api/materials", async (ctx) => {
    const { sql, params } = require("../lib/rbac").scopeFilter(ctx.user);
    const paging = readPaging(ctx.query);

    const base = `FROM materials m JOIN projects p ON p.id = m.pid WHERE ${sql}`;
    let rows;
    let total;
    if (paging) {
      total = countOf(db.prepare(`SELECT COUNT(*) AS c ${base}`).get(...params));
      rows = db.prepare(
        `SELECT m.*, p.name AS pname, p.status AS pstatus ${base} ORDER BY m.id DESC LIMIT ? OFFSET ?`
      ).all(...params, paging.size, paging.offset);
    } else {
      rows = db.prepare(`SELECT m.*, p.name AS pname, p.status AS pstatus ${base} ORDER BY m.id DESC`).all(...params);
      total = rows.length;
    }

    // 齐备度必须用独立聚合算：分页后的 rows 只是当前页，拿它算会漏掉其它页的材料
    const kindsByPid = new Map();
    for (const r of db.prepare(`SELECT DISTINCT m.pid, m.kind ${base}`).all(...params)) {
      if (!kindsByPid.has(r.pid)) kindsByPid.set(r.pid, []);
      kindsByPid.get(r.pid).push(r.kind);
    }

    // 已归档项目卷宗封存，不再出现在可登记列表
    const projects = db.prepare(
      `SELECT p.id, p.name, p.status FROM projects p WHERE ${sql} AND p.status IN ('筹备中','执行中','待核销','已核销','已结算') ORDER BY p.date DESC`
    ).all(...params).map((p) => {
      const have = kindsByPid.get(p.id) || [];
      return { ...p, have, missing: MATERIAL_KINDS.filter((k) => !have.includes(k)) };
    });

    return {
      rows,
      total,
      page: paging ? paging.page : 1,
      size: paging ? paging.size : total,
      pages: paging ? Math.max(1, Math.ceil(total / paging.size)) : 1,
      paged: !!paging,
      projects,
      kinds: MATERIAL_KINDS
    };
  });

  /** 材料登记（归档 8 类，可选挂一个附件） */
  router.post("/api/projects/:id/materials", async (ctx) => {
    const p = getProject(ctx.params.id);
    assertProjectVisible(ctx.user, p);
    assertCan(ctx.user, "material:write", "当前角色无材料登记权限");
    if (p.status === "已归档") throw conflict("项目已归档，材料清单已封存，不可再登记", "ARCHIVED", { status: p.status });
    const { kind, name, version, file_key, file_name, file_size, file_mime } = ctx.body || {};
    if (!MATERIAL_KINDS.includes(kind)) throw bad(`材料类别必须是：${MATERIAL_KINDS.join(" / ")}`);
    if (!String(name || "").trim()) throw bad("请填写材料名称");
    if (String(name).trim().length > 120) throw bad("材料名称不能超过 120 字");

    // 附件 key 必须是本系统签发的格式，否则等于允许把任意字符串写进库
    let fk = null;
    if (file_key) {
      if (!/^[a-f0-9]{32}\.(jpg|png|webp|gif|pdf)$/.test(String(file_key))) throw bad("附件标识不合法");
      fk = String(file_key);
    }

    db.prepare(
      `INSERT INTO materials (pid,kind,name,version,uploader,created_at,file_key,file_name,file_size,file_mime)
       VALUES (?,?,?,?,?,?,?,?,?,?)`
    ).run(
      p.id, kind, String(name).trim(), version || "v1", ctx.user.name, now(),
      fk, fk ? String(file_name || "").slice(0, 120) : null,
      fk ? Number(file_size) || null : null, fk ? String(file_mime || "").slice(0, 60) : null
    );

    logAudit({
      user: ctx.user, module: "材料中心", action: "上传", target: p.id,
      detail: `${kind}：${name}${fk ? "（含附件）" : ""}`, ip: ctx.ip
    });
    return { materialsStatus: materialsStatus(p.id), message: `${kind} 已登记` };
  });

  router.delete("/api/materials/:id", async (ctx) => {
    const m = db.prepare("SELECT * FROM materials WHERE id = ?").get(Number(ctx.params.id));
    if (!m) throw notFound("材料不存在");
    const p = getProject(m.pid);
    assertProjectVisible(ctx.user, p);
    assertCan(ctx.user, "material:write", "当前角色无材料删除权限");
    if (p.status === "已归档") throw conflict("已归档项目材料不可删除");

    db.prepare("DELETE FROM materials WHERE id = ?").run(m.id);

    // 附件一起删，但要先确认没有别的材料行还引用同一个 key
    if (m.file_key) {
      const still = db.prepare("SELECT COUNT(*) AS c FROM materials WHERE file_key = ?").get(m.file_key);
      if (!(Number(still?.c) > 0)) {
        try { await storage().del(m.file_key); } catch { /* 文件删除失败不回滚记录，避免留下删不掉的条目 */ }
      }
    }

    logAudit({ user: ctx.user, module: "材料中心", action: "删除", target: p.id, detail: `删除 ${m.kind}：${m.name}`, ip: ctx.ip });
    return { materialsStatus: materialsStatus(p.id), message: "已删除" };
  });

  router.get("/api/settlements", async (ctx) => {
    const { sql, params } = require("../lib/rbac").scopeFilter(ctx.user);
    const base = `FROM settlements s JOIN projects p ON p.id = s.pid WHERE ${sql}`;
    const paging = readPaging(ctx.query);
    if (!paging) {
      const rows = db.prepare(`SELECT s.*, p.name, p.assoc, p.status AS pstatus ${base} ORDER BY s.created_at DESC`).all(...params);
      return { rows, total: rows.length };
    }
    const total = countOf(db.prepare(`SELECT COUNT(*) AS c ${base}`).get(...params));
    const rows = db.prepare(
      `SELECT s.*, p.name, p.assoc, p.status AS pstatus ${base} ORDER BY s.created_at DESC LIMIT ? OFFSET ?`
    ).all(...params, paging.size, paging.offset);
    return { rows, total, page: paging.page, size: paging.size, pages: Math.max(1, Math.ceil(total / paging.size)), paged: true };
  });

  return router;
}

module.exports = { register };
