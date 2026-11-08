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
test("前端 NAV 里每个 can(...) 条件，服务端 canVisitNav 都要有对应判断",()=>{
 // 全站巡检发现：前端「邀请函上线配置」要求 setting:write，服务端漏了这条，
 // 结果两张表漂移。这个用例把两边绑在一起，以后加菜单时改一边就会红。
 const nav=readFileSync(join(__dirname,"../web/assets/js/lib/nav.js"),"utf8");
 const rbac=readFileSync(join(__dirname,"../server/lib/rbac.js"),"utf8");
 const perms=[...new Set([...nav.matchAll(/need:\s*\(\)\s*=>\s*can\("([^"]+)"\)/g)].map(m=>m[1]))];
 assert.ok(perms.length>=4,"至少应解析出 invite/manage 等动作条件");
 for(const p of perms){
  const quoted=new RegExp(`can\\(user,\\s*"${p.replace(/[.*+?^${}()|[\]\\]/g,"\\$&")}"\\)`);
  assert.match(rbac,quoted,`服务端 canVisitNav 缺少前端动作条件：${p}`);
 }
 assert.equal(canVisitNav({role:"admin"},"invitation-config"),true,"超管仍应可达");
 assert.equal(canVisitNav({role:"nobody"},"invitation-config"),false,"未知角色不可达");
});
