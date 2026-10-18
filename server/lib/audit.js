"use strict";
const { db } = require("./db");
const { now } = require("./util");
const { ROLES } = require("./rbac");

/** 全量操作留痕：4W（Who / When / What / Which） */
function logAudit({ user, module, action, target = "", detail = "", ip = "" }) {
  db.prepare(
    "INSERT INTO audit_logs (at, user_id, user_name, role, module, action, target, detail, ip) VALUES (?,?,?,?,?,?,?,?,?)"
  ).run(
    now(),
    user ? user.id : null,
    user ? user.name : "system",
    user ? ROLES[user.role]?.name || user.role : "系统",
    module,
    action,
    target,
    detail,
    ip
  );
}

function recentAudit(limit = 50) {
  return db.prepare("SELECT * FROM audit_logs ORDER BY id DESC LIMIT ?").all(limit);
}

module.exports = { logAudit, recentAudit };
