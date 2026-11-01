"use strict";
/** Dynamic association catalog, seeded exactly once. Removing an association never deletes its history. */
const {db}=require("./db");
const {ASSOCS}=require("./constants");
const {bad,conflict}=require("./util");
function ensure(){
 const initialized=db.prepare("SELECT v FROM settings WHERE k='associations_initialized'").get();
 if(!initialized){
  for(const name of ASSOCS) db.prepare("INSERT OR IGNORE INTO associations(name,active) VALUES (?,1)").run(name);
  db.prepare("INSERT OR REPLACE INTO settings(k,v) VALUES ('associations_initialized','1')").run();
 }
}
function list(){ensure();return db.prepare("SELECT name FROM associations WHERE active=1 ORDER BY id").all().map(x=>x.name);}
function has(name){return list().includes(String(name||"").trim());}
function add(name){
 ensure();
 const n=String(name||"").trim().replace(/\s+/g," ");
 if(n.length<2||n.length>40)throw bad("协会名称应为 2 至 40 字");
 const exists=db.prepare("SELECT * FROM associations WHERE name=?").get(n);
 if(exists?.active)throw conflict("协会已经存在","ASSOCIATION_EXISTS");
 if(exists) db.prepare("UPDATE associations SET active=1 WHERE name=?").run(n);
 else db.prepare("INSERT INTO associations(name,active) VALUES (?,1)").run(n);
 return n;
}
function remove(name){
 ensure();
 if(!has(name))throw bad("协会不存在或已停用");
 if(list().length<=1)throw conflict("至少保留一个有效协会","ASSOCIATION_LAST");
 const linked=db.prepare("SELECT (SELECT COUNT(*) FROM projects WHERE assoc=?) + (SELECT COUNT(*) FROM users WHERE assoc=?) AS n").get(name,name).n;
 if(linked)throw conflict("协会下仍存在项目或账号，不能删除；请先完成数据迁移","ASSOCIATION_IN_USE");
 db.prepare("UPDATE associations SET active=0 WHERE name=?").run(name);
}
module.exports={list,has,add,remove};
