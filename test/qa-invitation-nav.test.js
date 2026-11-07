"use strict";
const {test}=require("node:test"),assert=require("node:assert/strict");
const {readFileSync}=require("node:fs"),{join}=require("node:path");
const {ROLES,PERMS,canVisitNav}=require("../server/lib/rbac");
test("邀请函和合同不再从业务角色自动获得权限",()=>{
 for(const role of ["assoc","exec","finance","user"]){
  assert.deepEqual(ROLES[role].modules,[],role);
 }
 assert.deepEqual(PERMS["invite:manage"],[]);
 assert.deepEqual(PERMS["contract:write"],[]);
 assert.equal(canVisitNav({role:"admin"},"prep-invitations"),true);
 assert.equal(canVisitNav({role:"admin"},"contracts"),true);
});
test("服务端侧栏判断必须验证独立模块与功能权限",()=>{
 const source=readFileSync(join(__dirname,"../server/lib/rbac.js"),"utf8");
 assert.match(source,/hasModule\(user,need\)/);
 assert.match(source,/can\(user, "invite:manage"\)/);
});
test("浏览器邀请导航也必须检查独立动作授权",()=>{
 const source=readFileSync(join(__dirname,"../web/assets/js/lib/nav.js"),"utf8");
 assert.match(source,/k: "prep-invitations"[^\n]*can\("invite:manage"\)/);
 assert.doesNotMatch(source,/k: "prep-invitations"[^\n]*modules\.includes\("prep"\)/);
});
