"use strict";
const { db } = require("./db");
const { bad } = require("./util");
function assignedMember(id, assoc) {
  const n = Number(id);
  if (!Number.isSafeInteger(n) || n <= 0) throw bad("请从系统协会成员列表选择负责人");
  const u = db.prepare("SELECT id,name,assoc,role FROM users WHERE id = ? AND active = 1").get(n);
  const platformAdmin=u?.role==="admin";
  if (!u || (!platformAdmin && u.assoc!==assoc &&
    !db.prepare("SELECT 1 FROM user_associations WHERE user_id=? AND assoc=?").get(n,assoc)))
    throw bad("负责人必须是该协会的有效系统成员，且不能选择其他协会成员");
  return u;
}
module.exports = { assignedMember };
