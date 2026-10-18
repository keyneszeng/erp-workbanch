"use strict";
const { db } = require("../lib/db");
const { now, nextId, bad, notFound, conflict, forbidden } = require("../lib/util");
const { assertCan, assertProjectVisible, isSuper } = require("../lib/rbac");
const { logAudit } = require("../lib/audit");
const { getProject, verification, materialsStatus, settlementOf } = require("../lib/workflow");
const { MATERIAL_KINDS } = require("../lib/constants");

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
    const no = Number(step_no);
    if (!(no >= 1 && no <= 6)) throw bad("例外步骤编号应为 1~6");
    if (!String(reason || "").trim()) throw bad("必须说明例外原因");
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
    const rows = db.prepare(
      `SELECT m.*, p.name AS pname, p.status AS pstatus FROM materials m JOIN projects p ON p.id = m.pid
       WHERE ${sql} ORDER BY m.id DESC`
    ).all(...params);
    const projects = db.prepare(
      `SELECT p.id, p.name, p.status FROM projects p WHERE ${sql} AND p.status IN ('筹备中','执行中','待核销','已核销','已结算','已归档') ORDER BY p.date DESC`
    ).all(...params).map((p) => {
      const have = [...new Set(rows.filter((r) => r.pid === p.id).map((r) => r.kind))];
      return { ...p, have, missing: MATERIAL_KINDS.filter((k) => !have.includes(k)) };
    });
    return { rows, projects, kinds: MATERIAL_KINDS };
  });

  /** 材料登记（归档 8 类） */
  router.post("/api/projects/:id/materials", async (ctx) => {
    const p = getProject(ctx.params.id);
    assertProjectVisible(ctx.user, p);
    assertCan(ctx.user, "archive:write", "当前角色无材料登记权限");
    const { kind, name, version } = ctx.body || {};
    if (!MATERIAL_KINDS.includes(kind)) throw bad(`材料类别必须是：${MATERIAL_KINDS.join(" / ")}`);
    if (!String(name || "").trim()) throw bad("请填写材料名称");
    db.prepare("INSERT INTO materials (pid,kind,name,version,uploader,created_at) VALUES (?,?,?,?,?,?)")
      .run(p.id, kind, String(name).trim(), version || "v1", ctx.user.name, now());
    logAudit({ user: ctx.user, module: "材料中心", action: "上传", target: p.id, detail: `${kind}：${name}`, ip: ctx.ip });
    return { materialsStatus: materialsStatus(p.id), message: `${kind} 已登记` };
  });

  router.delete("/api/materials/:id", async (ctx) => {
    const m = db.prepare("SELECT * FROM materials WHERE id = ?").get(Number(ctx.params.id));
    if (!m) throw notFound("材料不存在");
    const p = getProject(m.pid);
    assertProjectVisible(ctx.user, p);
    assertCan(ctx.user, "archive:write", "当前角色无材料删除权限");
    if (p.status === "已归档") throw conflict("已归档项目材料不可删除");
    db.prepare("DELETE FROM materials WHERE id = ?").run(m.id);
    logAudit({ user: ctx.user, module: "材料中心", action: "删除", target: p.id, detail: `删除 ${m.kind}：${m.name}`, ip: ctx.ip });
    return { materialsStatus: materialsStatus(p.id), message: "已删除" };
  });

  router.get("/api/settlements", async (ctx) => {
    const { sql, params } = require("../lib/rbac").scopeFilter(ctx.user);
    const rows = db.prepare(
      `SELECT s.*, p.name, p.assoc, p.status AS pstatus FROM settlements s JOIN projects p ON p.id = s.pid
       WHERE ${sql} ORDER BY s.created_at DESC`
    ).all(...params);
    return { rows };
  });

  return router;
}

module.exports = { register };
