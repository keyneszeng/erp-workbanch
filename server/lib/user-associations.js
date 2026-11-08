"use strict";
const {db}=require("./db");
const {bad}=require("./util");

/** Multi-association access is explicitly assigned by super-admin, never by self-service users. */
function validateAssociations(value, fallback) {
  const given=value===undefined ? (fallback ? [fallback] : []) : value;
  if(!Array.isArray(given))throw bad("所属协会必须为数组");
  const names=[...new Set(given.map(s=>String(s||"").trim()).filter(Boolean))];
  if(names.length>20)throw bad("单个用户最多关联20个协会");
  const associations=require("./associations");
  for(const assoc of names)if(!associations.has(assoc))throw bad("无效或已停用协会："+assoc);
  return names;
}
function listForUser(id,legacy) {
  const rows=db.prepare("SELECT assoc FROM user_associations WHERE user_id=? ORDER BY assoc").all(id);
  const names=rows.map(r=>r.assoc);
  if(legacy && !names.includes(legacy))names.unshift(legacy);
  return [...new Set(names)];
}
function updateForUser(id,names) {
  db.prepare("DELETE FROM user_associations WHERE user_id=?").run(id);
  const stmt=db.prepare("INSERT INTO user_associations(user_id,assoc) VALUES (?,?)");
  for(const name of names)stmt.run(id,name);
}
module.exports={validateAssociations,listForUser,updateForUser};
