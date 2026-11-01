"use strict";
const { db } = require("./db");
const { bad } = require("./util");
function assignedMember(id, assoc) {
  const n = Number(id);
  if (!Number.isSafeInteger(n) || n <= 0) throw bad("请从系统协会成员列表选择负责人");
  const u = db.prepare("SELECT id,name,assoc,role FROM users WHERE id = ? AND active = 1").get(n);
  if (!u || (u.role!=="admin" && (!u.assoc || u.assoc!==assoc)))
    throw bad("负责人必须是本协会有效成员或拥有全平台权限的总管理员");
  return u;
}
module.exports = { assignedMember };
