"use strict";
/**
 * 材料写入权限回归 —— 会务执行人员必须能登记/删除材料，但不得获得项目归档权限
 * 运行：node --test test/material.test.js
 */
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { can,PERMS,ROLES } = require("../server/lib/rbac");

const PORT = 8805;
const BASE = `http://127.0.0.1:${PORT}`;
const DB = path.join(__dirname, "..", "data", "test5.db");
let proc;

function cleanDb() {
  for (const f of [DB, DB + "-wal", DB + "-shm"]) if (fs.existsSync(f)) fs.renameSync(f, f + ".old");
}
async function waitHealth(timeout = 40000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    try { const r = await fetch(`${BASE}/api/health`); if (r.ok) return; } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("测试服务启动超时");
}
async function login(username, password = "123456") {
  const r = await fetch(`${BASE}/api/auth/login`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password })
  });
  assert.equal(r.status, 200, `${username} 登录应成功`);
  return r.headers.get("set-cookie").split(";")[0];
}
function client(cookie) {
  return async (method, url, body) => {
    const r = await fetch(BASE + url, {
      method, headers: { "Content-Type": "application/json", cookie },
      body: body ? JSON.stringify(body) : undefined
    });
    const text = await r.text();
    let data = null; try { data = JSON.parse(text); } catch { data = text; }
    return { status: r.status, data };
  };
}

before(async () => {
  cleanDb();
  proc = spawn(process.execPath, ["--experimental-sqlite", "server/index.js"], {
    cwd: path.join(__dirname, ".."),
    env: { ...process.env, ERP_PORT: String(PORT), ERP_DB: DB },
    stdio: ["ignore", "pipe", "pipe"]
  });
  proc.stderr.on("data", (d) => {
    const s = d.toString();
    if (!s.includes("ExperimentalWarning") && !s.includes("trace-warnings")) process.stderr.write("[srv] " + s);
  });
  await waitHealth();
});
after(() => { if (proc) proc.kill("SIGTERM"); });

test("角色定义不再带内置材料权限，总管理员仍始终拥有全部权限", () => {
  for(const role of ["assoc","exec","finance","user"]){
    assert.deepEqual(ROLES[role].modules,[],"普通角色不能内置模块："+role);
  }
  assert.deepEqual(PERMS["material:write"],[]);
  assert.deepEqual(PERMS["archive:write"],[]);
  assert.equal(can({role:"admin"},"material:write"),true);
  assert.equal(can({role:"admin"},"archive:write"),true);
});

test("exec 登录后 /me 权限包含 material:write 且不含 archive:write", async () => {
  const exec = client(await login("exec"));
  const me = await exec("GET", "/api/auth/me");
  assert.equal(me.status, 200);
  assert.ok(me.data.perms.includes("material:write"), "应含 material:write");
  assert.ok(!me.data.perms.includes("archive:write"), "不应含 archive:write");
});

test("exec 可登记并删除材料", async () => {
  const exec = client(await login("exec"));
  const list = await exec("GET", "/api/projects");
  const p = list.data.rows.find((x) => x.status !== "已归档");
  assert.ok(p, "exec 应有可见且未归档的项目");

  const add = await exec("POST", `/api/projects/${p.id}/materials`, { kind: "现场照片", name: "巡检测试材料.jpg" });
  assert.equal(add.status, 200, `exec 登记材料应成功，实际 ${add.status} ${JSON.stringify(add.data)}`);

  const all = await exec("GET", "/api/materials");
  const row = all.data.rows.find((m) => m.pid === p.id && m.kind === "现场照片" && m.name === "巡检测试材料.jpg");
  assert.ok(row, "应能查到刚登记的材料");

  const del = await exec("DELETE", `/api/materials/${row.id}`);
  assert.equal(del.status, 200, "exec 删除材料应成功");
  assert.ok(del.data.materialsStatus, "软删后服务器应重新计算有效材料总量");

  const archive = await exec("GET", `/api/projects/${p.id}`);
  assert.equal(archive.status, 200);
  assert.ok(Array.isArray(archive.data.materials), "会议项目详情应返回归档材料列表");
  assert.ok(!archive.data.materials.some((m) => Number(m.id) === Number(row.id)),
    "已经删除的材料不得再出现在会议项目→归档材料接口，即使重新打开页面");
  const materialList = await exec("GET", "/api/materials");
  assert.equal(materialList.status, 200);
  assert.ok(!materialList.data.rows.some((m) => Number(m.id) === Number(row.id)),
    "材料中心也不得再展示已删除原件");
  const repeated = await exec("DELETE", `/api/materials/${row.id}`);
  assert.equal(repeated.status, 409, "软删历史记录必须存在，且不允许重复删除");
  assert.equal(repeated.data.error.code, "ALREADY_DELETED");
});

test("材料收集项目目录包含归档项目，按项目编号筛选详情且分页不会串会议",async()=>{
 const admin=client(await login("admin"));
 const all=await admin("GET","/api/materials");
 assert.equal(all.status,200);
 assert.ok(all.data.projects.some(p=>p.status==="已归档"),"归档项目必须保留在目录内供只读查阅");
 const target=all.data.projects.find(p=>p.count>0)||all.data.projects[0];
 assert.ok(target,"项目目录不应为空");
 const subset=all.data.rows.filter(m=>m.pid===target.id);
 const pid=encodeURIComponent(target.id);
 const filtered=await admin("GET","/api/materials?pid="+pid+"&page=1&size=1");
 assert.equal(filtered.status,200);
 assert.equal(filtered.data.total,subset.length,"只计当前项目的材料记录");
 assert.equal(filtered.data.projects.length,all.data.projects.length,"打开目录不应丢失其他项目");
 assert.ok(filtered.data.rows.every(m=>m.pid===target.id),"不得混入其他项目的材料");
 assert.equal(filtered.data.rows.length,Math.min(1,subset.length));
 const allForProject=await admin("GET","/api/materials?pid="+pid);
 assert.equal(allForProject.status,200);
 assert.equal(allForProject.data.rows.length,subset.length);
 assert.ok(allForProject.data.rows.every(m=>m.pid===target.id));
 assert.equal((await admin("GET","/api/materials?pid="+"x".repeat(81))).status,400);
});

test("guest 登记材料返回 403", async () => {
  const guest = client(await login("guest"));
  const list = await guest("GET", "/api/projects");
  const p = list.data.rows[0];
  if (!p) return; // guest 可能无可见项目
  const r = await guest("POST", `/api/projects/${p.id}/materials`, { kind: "现场照片", name: "x.jpg" });
  assert.equal(r.status, 403);
});

test("assoc 仍可登记材料（回归）", async () => {
  const assoc = client(await login("assoc"));
  const list = await assoc("GET", "/api/projects");
  const p = list.data.rows.find((x) => x.status !== "已归档");
  const r = await assoc("POST", `/api/projects/${p.id}/materials`, { kind: "签到表", name: "回归测试.pdf" });
  assert.equal(r.status, 200);
});

test("劳务收集表类别退役：新上传规范为劳务表，旧原件仍可按劳务表查看并用于第5项核销",async()=>{
  const {MATERIAL_KINDS,MATERIAL_MODULE_KINDS}=require("../server/lib/constants");
  const {DatabaseSync}=require("node:sqlite");
  const {laborSheetInfo}=require("../server/lib/labor-sop");
  assert.ok(MATERIAL_KINDS.includes("劳务表"));
  assert.ok(!MATERIAL_KINDS.includes("劳务收集表"));
  assert.ok(MATERIAL_MODULE_KINDS.includes("劳务表"));
  assert.ok(!MATERIAL_MODULE_KINDS.includes("劳务收集表"));
  const exec=client(await login("exec"));
  const projects=await exec("GET","/api/projects");
  const p=projects.data.rows.find(x=>!["已结算","已归档"].includes(x.status));
  assert.ok(p,"应有可登记材料的项目");
  const list=await exec("GET","/api/materials");
  assert.equal(list.status,200);
  assert.ok(list.data.kinds.includes("劳务表"));
  assert.ok(!list.data.kinds.includes("劳务收集表"));
  // Old mini clients can still submit the retired name; no new duplicate kind is created.
  const saved=await exec("POST","/api/projects/"+p.id+"/materials",
    {kind:"劳务收集表",name:"旧客户端兼容劳务材料"});
  assert.equal(saved.status,200,JSON.stringify(saved.data));
  const after=await exec("GET","/api/materials");
  const row=after.data.rows.find(x=>x.pid===p.id&&x.name==="旧客户端兼容劳务材料");
  assert.equal(row.kind,"劳务表","新写入应规范为唯一类别");
  // Simulate an older persisted record without rewriting its legal/audit history.
  const db=new DatabaseSync(DB);
  db.prepare("UPDATE materials SET kind='劳务收集表',file_key=?,file_name=? WHERE id=?")
    .run("f".repeat(32)+".pdf","旧版专家劳务表.pdf",row.id);
  assert.equal(laborSheetInfo(db,p.id).required,true,"旧分类原件仍应触发核销第5项");
  const moduleBefore=db.prepare("SELECT enabled FROM meeting_material_modules WHERE pid=? AND kind='劳务表'").get(p.id);
  assert.equal(moduleBefore,undefined);
  db.prepare("INSERT INTO meeting_material_modules(pid,kind,enabled,updated_at) VALUES (?,'劳务收集表',0,?) "+
    "ON CONFLICT(pid,kind) DO UPDATE SET enabled=0,updated_at=excluded.updated_at")
    .run(p.id,new Date().toISOString());
  db.close();
  const workbench=await exec("GET","/api/projects/"+p.id+"/material-workbench");
  assert.equal(workbench.status,200,JSON.stringify(workbench.data));
  assert.ok(workbench.data.kinds.includes("劳务表"));
  assert.ok(!workbench.data.kinds.includes("劳务收集表"));
  assert.ok(workbench.data.modules.some(x=>x.kind==="劳务表"&&x.enabled===0),
    "历史停用开关在新名称下仍有效");
  assert.ok(workbench.data.materials.some(x=>x.id===row.id&&x.kind==="劳务表"&&
    x.filename==="旧版专家劳务表.pdf"),"历史文件不从小程序消失，也不重复显示旧类别");
  const stopped=await exec("POST","/api/projects/"+p.id+"/materials",
    {kind:"劳务收集表",name:"停用后不可上传"});
  assert.equal(stopped.status,409,"旧模块已停用时，旧名称提交亦不能绕过服务端门禁");
  const admin=client(await login("admin"));
  const enabled=await admin("POST","/api/projects/"+p.id+"/material-workbench/modules",
    {kind:"劳务表",enabled:true});
  assert.equal(enabled.status,200,JSON.stringify(enabled.data));
  const resumed=await exec("POST","/api/projects/"+p.id+"/materials",
    {kind:"劳务表",name:"新名称重新启用成功"});
  assert.equal(resumed.status,200,JSON.stringify(resumed.data));
});
