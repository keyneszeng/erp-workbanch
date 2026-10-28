"use strict";
const { db } = require("../lib/db");
const { getProject } = require("../lib/workflow");
const { forbidden, conflict } = require("../lib/util");
const { storage } = require("../lib/storage");
const { logAudit } = require("../lib/audit");
const { buildArchivePdf } = require("../lib/archive-pdf");

/**
 * 资料下载仅总管理员、项目所属协会管理员使用；会务执行、财务和嘉宾不可下载。
 * 鉴权在服务端执行，隐藏按钮不能代替服务端身份验证。
 */
function assertArchiveDownloadAccess(user, project) {
  if (user.role === "admin") return;
  if (user.role !== "assoc" || !user.assoc || user.assoc !== project.assoc) {
    throw forbidden("只有总管理员或该会议所属协会管理员可以下载核销资料");
  }
}

function register(router) {
  router.get("/api/projects/:id/archive-pdf", async (ctx) => {
    const p = getProject(ctx.params.id);
    assertArchiveDownloadAccess(ctx.user, p);
    if (p.status !== "已归档") {
      throw conflict("会议尚未归档，核销资料不能下载", "ARCHIVE_REQUIRED", { status: p.status });
    }
    const pid = p.id;
    // 从持久化数据生成只读快照；文件、账目和核销记录均不能从前端传入。
    const snapshot = {
      project: p,
      verifySteps: db.prepare("SELECT * FROM verify_steps WHERE pid=? ORDER BY step_no").all(pid),
      exceptions: db.prepare("SELECT * FROM exceptions WHERE pid=? ORDER BY created_at, id").all(pid),
      materials: db.prepare("SELECT * FROM materials WHERE pid=? ORDER BY kind, id").all(pid),
      contracts: db.prepare("SELECT * FROM contracts WHERE pid=? ORDER BY id").all(pid),
      payments: db.prepare("SELECT * FROM payments WHERE pid=? ORDER BY created_at, id").all(pid),
      settlement: db.prepare("SELECT * FROM settlements WHERE pid=?").get(pid) || null,
      demandSheet: db.prepare("SELECT * FROM demand_sheets WHERE pid=?").get(pid) || null,
      demandItems: db.prepare("SELECT * FROM demand_items WHERE pid=? ORDER BY ordering, id").all(pid),
      approvals: db.prepare("SELECT * FROM approvals WHERE pid=? ORDER BY created_at, id").all(pid),
      auditLogs: db.prepare("SELECT * FROM audit_logs WHERE target=? ORDER BY at, id").all(pid)
    };
    const pdf = await buildArchivePdf(snapshot, storage());
    logAudit({
      user: ctx.user, module: "档案中心", action: "下载核销资料PDF",
      target: pid, detail: "已归档核销资料打包下载（只读）", ip: ctx.ip
    });
    return {
      __file: {
        buffer: pdf,
        mime: "application/pdf",
        name: "核销全部资料_" + pid + ".pdf",
        download: true,
        cache: "no-store"
      }
    };
  });
  return router;
}

module.exports = { register, assertArchiveDownloadAccess };
