/**
 * 三角色接口矩阵巡检（只读）
 *
 * 用法：ERP_BASE=http://8.134.140.186:8080 node test/api/roles-matrix.js
 *
 * 目的不是复述 RBAC 设计，而是抓两类真故障：
 *   1) 任何 5xx —— 服务端崩了，一律是 bug
 *   2) 该角色应该看得到的接口却 403 —— 角色看不到自己的活儿
 * 权限拒绝（403/404）本身是设计，不算问题，只做记录。
 */
const BASE = process.env.ERP_BASE || "http://127.0.0.1:8080";

const ACCOUNTS = [
  { role: "总管理员", user: process.env.ERP_ADMIN_USER || "13800138000", pass: process.env.ERP_ADMIN_PASS || "keynes1987" },
  { role: "会务执行", user: process.env.ERP_EXEC_USER || "18620867488", pass: process.env.ERP_EXEC_PASS || "keynes1987" },
  { role: "财务", user: process.env.ERP_FIN_USER || "18802080472", pass: process.env.ERP_FIN_PASS || "keynes1987" }
];

/** 每个角色「必须打得开」的接口；其余接口只检查不是 5xx */
const MUST_READ = {
  "总管理员": ["/api/dashboard", "/api/projects", "/api/contracts", "/api/payments", "/api/settlements",
    "/api/materials", "/api/audit?page=1&size=5", "/api/users",
    "/api/project-ledger", "/api/meta"],
  "会务执行": ["/api/dashboard", "/api/projects", "/api/contracts", "/api/materials",
    "/api/demand/MP-2026-001", "/api/meta"],
  "财务": ["/api/dashboard", "/api/projects", "/api/contracts", "/api/payments", "/api/settlements",
    "/api/materials", "/api/meta"]
};

/** 全量探针：任何 5xx 都要报出来 */
const PROBES = [
  "/api/dashboard", "/api/projects?size=50", "/api/projects/MP-2026-001", "/api/contracts?size=50",
  "/api/payments?size=50", "/api/settlements", "/api/materials?size=50",
  "/api/approvals?size=50", "/api/demand/MP-2026-001", "/api/projects/MP-2026-001/verify",
  "/api/projects/MP-2026-001/material-workbench", "/api/audit?page=1&size=5", "/api/users",
  "/api/users/assignable?assoc=" + encodeURIComponent("内分泌分会"), "/api/project-ledger",
  "/api/project-ledger/MP-2026-001", "/api/meta", "/api/exports",
  "/api/health"
];

async function login(user, pass) {
  const r = await fetch(BASE + "/api/auth/login", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: user, password: pass })
  });
  if (r.status !== 200) throw new Error(`登录失败 ${r.status}`);
  const raw = r.headers.getSetCookie ? r.headers.getSetCookie() : [r.headers.get("set-cookie")].filter(Boolean);
  return raw.map((c) => c.split(";")[0]).join("; ");
}

const problems = [];
(async () => {
  for (const a of ACCOUNTS) {
    console.log(`\n════ ${a.role} ════`);
    let cookie;
    try { cookie = await login(a.user, a.pass); }
    catch (e) { problems.push(`[${a.role}] ${e.message}`); continue; }

    const seen = new Map();
    for (const u of PROBES) {
      const r = await fetch(BASE + u, { headers: { cookie } });
      const s = r.status;
      seen.set(u, s);
      if (s >= 500) {
        let body = "";
        try { body = (await r.text()).slice(0, 200); } catch {}
        problems.push(`[${a.role}] 5xx ${s} ${u} ${body}`);
        console.log(`  ✗ 5xx ${u}`);
      } else {
        console.log(`  ${s} ${u}`);
      }
    }
    const byPath = new Map([...seen.entries()].map(([u, s]) => [u.split("?")[0], s]));
    for (const u of MUST_READ[a.role] || []) {
      const s = byPath.get(u.split("?")[0]);
      if (s !== 200) problems.push(`[${a.role}] 应可读却 ${s}：${u}`);
    }
  }

  console.log("\n════ 汇总 ════");
  if (!problems.length) { console.log("没有发现问题"); return; }
  for (const p of problems) console.log("✗ " + p);
  process.exitCode = 1;
})();
