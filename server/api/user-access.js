"use strict";
/** 按账号显式授权，仅总管理员能进行授权和撤销。 */
const {db,transaction}=require("../lib/db");
const {PERMS,MODULES,isSuper}=require("../lib/rbac");
const {bad,notFound,forbidden,conflict}=require("../lib/util");
const {logAudit}=require("../lib/audit");
const ALL_MODULES=MODULES.map(m=>m.k),ALL_PERMS=Object.keys(PERMS);
function granted(id){
 return {modules:db.prepare("SELECT module FROM user_module_grants WHERE user_id=? ORDER BY module").all(id).map(x=>x.module),
 permissions:db.prepare("SELECT permission FROM user_permission_grants WHERE user_id=? ORDER BY permission").all(id).map(x=>x.permission)};
}
function requireAdmin(user){if(!isSuper(user))throw forbidden("仅总管理员可授予或撤销功能权限");}
function validate(xs,allow,label){
 if(!Array.isArray(xs)||xs.length>allow.length||xs.some(x=>typeof x!=="string"||!allow.includes(x))||
    new Set(xs).size!==xs.length)throw bad(label+"需是有效且不重复的权限列表");
 return xs;
}
function account(id){
 const u=db.prepare("SELECT id,name,role,active FROM users WHERE id=?").get(Number(id));
 if(!u)throw notFound("账号不存在");
 return u;
}
function register(router){
 router.get("/api/users/:id/access",async ctx=>{
  requireAdmin(ctx.user);
  const u=account(ctx.params.id);
  return {user:u,immutable:isSuper(u),
    access:isSuper(u)?{modules:ALL_MODULES,permissions:ALL_PERMS}:granted(u.id),
    available_modules:MODULES,available_permissions:ALL_PERMS};
 });
 router.patch("/api/users/:id/access",async ctx=>{
  requireAdmin(ctx.user);
  const u=account(ctx.params.id);
  if(isSuper(u))throw conflict("总管理员恒有全部权限，不可修改","SUPER_IMMUTABLE");
  const modules=validate(ctx.body?.modules,ALL_MODULES,"模块权限");
  const permissions=validate(ctx.body?.permissions,ALL_PERMS,"功能权限");
  const old=granted(u.id);
  transaction(()=>{
   db.prepare("DELETE FROM user_module_grants WHERE user_id=?").run(u.id);
   db.prepare("DELETE FROM user_permission_grants WHERE user_id=?").run(u.id);
   const im=db.prepare("INSERT INTO user_module_grants(user_id,module) VALUES (?,?)");
   const ip=db.prepare("INSERT INTO user_permission_grants(user_id,permission) VALUES (?,?)");
   for(const x of modules)im.run(u.id,x);
   for(const x of permissions)ip.run(u.id,x);
   db.prepare("UPDATE users SET material_file_replace=?,token_ver=token_ver+1 WHERE id=?")
     .run(permissions.includes("material:file:replace")?1:0,u.id);
   db.prepare("DELETE FROM sessions WHERE user_id=?").run(u.id);
  });
  logAudit({user:ctx.user,module:"系统配置",action:"修改账号授权",target:String(u.id),
    detail:"用户："+u.name+"；模块："+old.modules.join(",")+" → "+modules.join(",")+
     "；操作："+old.permissions.join(",")+" → "+permissions.join(","),ip:ctx.ip});
  return {user:u,access:granted(u.id),message:"权限已保存；原登录会话已失效，请目标用户重新登录"};
 });
 return router;
}
module.exports={register,granted};
