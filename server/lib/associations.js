"use strict";
/** Association catalog; codes identify new meetings, names remain historical business labels. */
const {db,transaction}=require("./db");
const {ASSOCS}=require("./constants");
const {bad,conflict}=require("./util");

// Compatibility defaults for the ten initial associations, not an automatic
// pinyin guess for organizations added by an administrator.
const BUILTIN_CODES={
 "华东医学会":"HDYX","京津冀医学会":"JJJYX","护理协会":"HLXH",
 "外科分会":"WKFH","全科医学分会":"QKYXFH","消化病分会":"XHBFH",
 "肿瘤分会":"ZLFH","心血管分会":"XXGFH","内分泌分会":"NFMFH",
 "呼吸病分会":"HXBFH"
};
function ensure(){
 const initialized=db.prepare("SELECT v FROM settings WHERE k='associations_initialized'").get();
 if(!initialized){
  for(const name of ASSOCS)
   db.prepare("INSERT OR IGNORE INTO associations(name,code,active) VALUES (?,?,1)")
    .run(name,BUILTIN_CODES[name]||null);
  db.prepare("INSERT OR REPLACE INTO settings(k,v) VALUES ('associations_initialized','1')").run();
 }
 // Once-only upgrade for existing catalog rows; no existing user/project ID is rewritten.
 if(!db.prepare("SELECT 1 FROM settings WHERE k='association_codes_seed_v1'").get()){
  for(const [name,code] of Object.entries(BUILTIN_CODES)){
   const taken=db.prepare("SELECT name FROM associations WHERE code=?").get(code);
   if(!taken||taken.name===name)
    db.prepare("UPDATE associations SET code=? WHERE name=? AND (code IS NULL OR code='')")
      .run(code,name);
  }
  db.prepare("INSERT OR REPLACE INTO settings(k,v) VALUES (?,?)")
   .run("association_codes_seed_v1","done");
 }
}
function list(){
 ensure();
 return db.prepare("SELECT name FROM associations WHERE active=1 ORDER BY id").all().map(x=>x.name);
}
function details(){
 ensure();
 return db.prepare("SELECT name,COALESCE(code,'') AS code FROM associations WHERE active=1 ORDER BY id").all();
}
function has(name){return list().includes(String(name||"").trim());}
function getCode(name){
 ensure();
 const row=db.prepare("SELECT code FROM associations WHERE name=? AND active=1").get(String(name||"").trim());
 if(!row)throw bad("所属协会不存在或已停用");
 if(!row.code)throw conflict("该协会尚未配置字母简写，请总管理员先在系统配置→协会分类管理中设置","ASSOCIATION_CODE_REQUIRED");
 return row.code;
}
function normalizeCode(raw){
 const code=String(raw??"").trim().toUpperCase();
 if(!/^[A-Z]{2,10}$/.test(code))throw bad("协会字母简写须为2至10位英文字母（不含数字和符号）");
 return code;
}
function ensureUnique(code,name){
 const used=db.prepare("SELECT name FROM associations WHERE code=?").get(code);
 if(used&&used.name!==name)throw conflict("协会字母简写已被「"+used.name+"」使用，请设置不同简写","ASSOCIATION_CODE_EXISTS");
}
function add(name,rawCode){
 ensure();
 const n=String(name||"").trim().replace(/\s+/g," ");
 if(n.length<2||n.length>40)throw bad("协会名称应为 2 至 40 字");
 const code=normalizeCode(rawCode);
 ensureUnique(code,n);
 const exists=db.prepare("SELECT * FROM associations WHERE name=?").get(n);
 if(exists?.active)throw conflict("协会已经存在","ASSOCIATION_EXISTS");
 // Reopening an inactive association with historical meeting codes must not
 // repurpose it under a different prefix.
 if(exists?.code&&exists.code!==code){
  const used=db.prepare("SELECT 1 FROM projects WHERE assoc=? AND id LIKE ? LIMIT 1")
   .get(n,exists.code+"-%");
  if(used)throw conflict("该协会已有按原简写编制的会议，不能变更简写","ASSOCIATION_CODE_LOCKED");
 }
 if(exists)db.prepare("UPDATE associations SET active=1,code=? WHERE name=?").run(code,n);
 else db.prepare("INSERT INTO associations(name,code,active) VALUES (?,?,1)").run(n,code);
 return n;
}
function updateCode(name,rawCode){
 ensure();
 const n=String(name||"").trim();
 const current=db.prepare("SELECT name,code FROM associations WHERE name=? AND active=1").get(n);
 if(!current)throw bad("协会不存在或已停用");
 const code=normalizeCode(rawCode);
 ensureUnique(code,n);
 if(current.code===code)return {name:n,code};
 if(current.code){
  const hasIssued=db.prepare("SELECT 1 FROM meeting_code_sequences WHERE code=? LIMIT 1").get(current.code);
  const historical=db.prepare("SELECT 1 FROM projects WHERE assoc=? AND id LIKE ? LIMIT 1").get(n,current.code+"-%");
  if(hasIssued||historical)
   throw conflict("该简写已用于会议编号，为保留历史编码不可修改","ASSOCIATION_CODE_LOCKED");
 }
 db.prepare("UPDATE associations SET code=? WHERE name=?").run(code,n);
 return {name:n,code};
}
function remove(name){
 ensure();
 if(!has(name))throw bad("协会不存在或已停用");
 if(list().length<=1)throw conflict("至少保留一个有效协会","ASSOCIATION_LAST");
 const linked=db.prepare("SELECT (SELECT COUNT(*) FROM projects WHERE assoc=?) + (SELECT COUNT(*) FROM users WHERE assoc=?) AS n").get(name,name).n;
 if(linked)throw conflict("协会下仍存在项目或账号，不能删除；请先完成数据迁移","ASSOCIATION_IN_USE");
 db.prepare("UPDATE associations SET active=0 WHERE name=?").run(name);
}
module.exports={list,details,has,getCode,normalizeCode,add,updateCode,remove};
