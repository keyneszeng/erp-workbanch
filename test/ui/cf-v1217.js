/**
 * V1.2.17 线上验证：测试报告 11 项缺陷的修复是否真的生效（**只读**）
 * 运行：node test/ui/cf-v1217.js
 *
 * 所有请求要么是 GET，要么是「预期被拒绝」的写请求（403/400/405），
 * 不会在生产环境留下任何数据。
 */
const BASE = process.env.ERP_BASE || "https://erp.aibuild.work";

let pass = 0, fail = 0;
const check = (name, ok, extra = "") => {
  if (ok) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}  ${extra}`); }
};

async function login(username, password = "123456", headers = {}) {
  const r = await fetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify({ username, password })
  });
  if (r.status !== 200) throw new Error(`${username} 登录失败：${r.status}`);
  return { cookie: (r.headers.get("set-cookie") || "").split(";")[0], raw: r.headers.get("set-cookie") || "" };
}

function client(cookie) {
  return async (method, url, body, headers = {}) => {
    const r = await fetch(BASE + url, {
      method,
      headers: { "Content-Type": "application/json", cookie, ...headers },
      body: body ? JSON.stringify(body) : undefined
    });
    const text = await r.text();
    let data = null; try { data = JSON.parse(text); } catch { data = text; }
    return { status: r.status, data, headers: r.headers };
  };
}

(async () => {
  console.log("\n[1] SEC-03 安全响应头");
  const h = await fetch(`${BASE}/api/health`);
  check("HSTS 已下发", /max-age=\d+/.test(h.headers.get("strict-transport-security") || ""),
    h.headers.get("strict-transport-security") || "");
  check("X-Content-Type-Options: nosniff", h.headers.get("x-content-type-options") === "nosniff");
  check("X-Frame-Options: SAMEORIGIN（不是 DENY，否则合同详情内嵌 PDF 会挂）",
    h.headers.get("x-frame-options") === "SAMEORIGIN", h.headers.get("x-frame-options") || "");
  check("Referrer-Policy 已下发", h.headers.get("referrer-policy") === "same-origin");
  check("CSP 先 Report-Only", !!h.headers.get("content-security-policy-report-only"));

  const httpsLogin = await login("admin", "123456", { "x-forwarded-proto": "https" });
  check("https 登录的 Cookie 带 Secure", /;\s*Secure/i.test(httpsLogin.raw), httpsLogin.raw);

  const admin = client((await login("admin")).cookie);
  const guest = client((await login("guest")).cookie);
  const assoc = client((await login("assoc")).cookie);

  console.log("\n[2] SEC-01 账号目录");
  for (const [name, c] of [["guest", guest], ["assoc", assoc]]) {
    const r = await c("GET", "/api/users");
    check(`${name} 访问账号目录 403`, r.status === 403, `实际 ${r.status}`);
  }
  const users = await admin("GET", "/api/users");
  check("admin 仍能拿到账号目录", users.status === 200 && users.data.rows.length > 0);
  const pick = await assoc("GET", "/api/users/pickable");
  check("选人接口可用且只回最小字段",
    pick.status === 200 && Object.keys(pick.data.rows[0]).sort().join(",") === "id,name,role,role_name",
    JSON.stringify(pick.data.rows?.[0] || {}));
  check("guest 访问选人接口 403", (await guest("GET", "/api/users/pickable")).status === 403);

  console.log("\n[3] SEC-02 列表接口与导出同口径");
  const lists = ["/api/contracts", "/api/demand", "/api/materials", "/api/payments", "/api/settlements", "/api/audit"];
  for (const u of lists) {
    const r = await guest("GET", u);
    check(`guest ${u} → 403`, r.status === 403, `实际 ${r.status}`);
  }
  check("guest 导出同样 403（两套口径一致）", (await guest("GET", "/api/export/contracts")).status === 403);
  check("assoc 合同台账仍可读", (await assoc("GET", "/api/contracts")).status === 200);
  check("assoc 审计仍可读", (await assoc("GET", "/api/audit")).status === 200);

  console.log("\n[4] BUG-01 普通用户数据范围补负责人");
  const gp = await guest("GET", "/api/projects");
  const ids = (gp.data.rows || []).map((p) => p.id).sort();
  check("guest 可见项目 = 成员 + 负责人 + 创建人（3 场）",
    ids.join(",") === "MP-2026-002,MP-2026-005,MP-2026-011", `实际 ${ids.join(",")}`);
  check("负责人项目详情可进", (await guest("GET", "/api/projects/MP-2026-011")).status === 200);
  const dash = await guest("GET", "/api/dashboard");
  const total = Object.values(dash.data.counts || {}).reduce((a, b) => a + Number(b || 0), 0);
  check("工作台在管会议 = 3 场", total === 3, `实际 ${total}`);

  console.log("\n[5] SEC-04 口令策略（弱口令被拒，不会建出账号）");
  const weak = await admin("POST", "/api/users", { username: "qa_weak_probe", name: "弱口令探针", role: "user", password: "123" });
  check("建号 password=123 → 400", weak.status === 400, `实际 ${weak.status} ${JSON.stringify(weak.data)}`);
  const noPwd = await admin("POST", "/api/users", { username: "qa_weak_probe", name: "无密码探针", role: "user" });
  check("不传密码 → 400（不再默认 123456）", noPwd.status === 400, `实际 ${noPwd.status}`);

  console.log("\n[6] BUG-02 鉴权顺序");
  const order = await guest("POST", "/api/approvals/AP-2026-010/decide", { approve: true });
  check("零权限审批已通过单 → 403（不是 409 暴露状态）", order.status === 403,
    `实际 ${order.status} ${JSON.stringify(order.data)}`);

  console.log("\n[7] API-01 REST 语义");
  const put = await admin("PUT", "/api/projects", {});
  check("PUT /api/projects → 405", put.status === 405, `实际 ${put.status}`);
  check("405 带 Allow 头", !!put.headers.get("allow"), put.headers.get("allow") || "");
  const badJson = await fetch(`${BASE}/api/auth/login`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: "{bad json"
  });
  const bd = await badJson.json();
  check("非法 JSON → 400 BAD_JSON", badJson.status === 400 && bd.error.code === "BAD_JSON",
    `${badJson.status} ${JSON.stringify(bd)}`);

  console.log("\n[8] 前端资源已更新到本版本");
  // 登录页是 JS 渲染的，直接抓 index.html 看不到版本号，要抓模块文件本身
  const js = await fetch(`${BASE}/assets/js/pages/login.js`).then((r) => r.text());
  check("login.js 里的版本号已更新", /生产版 v1\.2\.1[7-9]/.test(js),
    js.slice(0, 120).replace(/\s+/g, " "));

  console.log(`\n=== ${pass} 通过 / ${fail} 失败 ===`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error("脚本异常：", e);
  process.exit(1);
});
