"use strict";
const {test}=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs"),os=require("node:os"),path=require("node:path");
const dir=fs.mkdtempSync(path.join(os.tmpdir(),"erp-assocs-"));
process.env.ERP_DB=path.join(dir,"associations.db");
process.env.ERP_DB_BACKEND="";
const {db,migrate}=require("../server/lib/db");
const catalog=require("../server/lib/associations");
const {assignedMember}=require("../server/lib/member-directory");
migrate();
test("associations: seed and admin catalog changes preserve linked project/user history",()=>{
 const baseline=catalog.list();
 assert.ok(baseline.length>1);
 const name="新增业务协会甲";
 assert.equal(catalog.add(name),name);
 assert.equal(catalog.has(name),true);
 assert.throws(()=>catalog.add(name),e=>e.code==="ASSOCIATION_EXISTS");
 catalog.remove(name);
 assert.equal(catalog.has(name),false);
 catalog.add(name);
 db.prepare("INSERT INTO users(username,name,role,assoc,pass_salt,pass_hash,active,created_at) VALUES (?,?,?,?,?,?,1,?)")
  .run("associationlinked","关联人员","assoc",name,"unused-salt","unused-hash",new Date().toISOString());
 assert.throws(()=>catalog.remove(name),e=>e.code==="ASSOCIATION_IN_USE");
});
test("singleton administrator can be selected as project owner, but cannot bypass normal association directory once members exist",()=>{
 const admin=db.prepare("INSERT INTO users(username,name,role,assoc,pass_salt,pass_hash,active,created_at) VALUES (?,?,?,?,?,?,1,?)")
  .run("singleadmin","唯一管理员","admin",null,"salt","hash",new Date().toISOString());
 // 另一个测试创建的关联人员仍在库里，所以先把它设成禁用。
 db.prepare("UPDATE users SET active=0 WHERE username='associationlinked'").run();
 assert.equal(assignedMember(admin.lastInsertRowid,"华东医学会").name,"唯一管理员");
 db.prepare("INSERT INTO users(username,name,role,assoc,pass_salt,pass_hash,active,created_at) VALUES (?,?,?,?,?,?,1,?)")
  .run("associationmember","协会成员","assoc","华东医学会","salt","hash",new Date().toISOString());
 assert.throws(()=>assignedMember(admin.lastInsertRowid,"华东医学会"),/负责人必须是该协会/);
});
