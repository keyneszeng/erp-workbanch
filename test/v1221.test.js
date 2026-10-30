"use strict";
/**
 * V1.2.21 回归：演示数据重置
 * 运行：node --experimental-sqlite --test test/v1221.test.js
 *
 * 老板 2026-10-28：「系统里的测试数据有点乱，把所有测试数据都删除了」。
 *
 * 线上是 Cloudflare Durable Object，没有 SQL 控制台，所以给 `seed({ reset: true })`
 * 加了一个受控的 HTTP 入口。这个文件盯的就是「受控」两个字：
 *   · 谁能调（只有总管理员）
 *   · 怎么调（必须显式 confirm）
 *   · 调完什么样（回到出厂规模，脏数据没了，审计记得清空前有多少）
 */
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const PORT = 8829;
const BASE = `http://127.0.0.1:${PORT}`;
const DB = path.join(__dirname, "..", "data", "test29.db");
const UP = path.join(__dirname, "..", "data", "test29-uploads");
let proc;
let admin, assoc, exec, finance, guest;

function clean() {
  for (const f of [DB, DB + "-wal", DB + "-shm"]) if (fs.existsSync(f)) fs.renameSync(f, f + ".old");
  if (fs.existsSync(UP)) fs.rmSync(UP, { recursive: true, force: true });
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
  assert.equal(r.status, 200, `${username} 登录失败`);
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
  clean();
  proc = spawn(process.execPath, ["--experimental-sqlite", "server/index.js"], {
    cwd: path.join(__dirname, ".."),
    env: { ...process.env, ERP_PORT: String(PORT), ERP_DB: DB, ERP_UPLOAD_DIR: UP },
    stdio: ["ignore", "pipe", "pipe"]
  });
  proc.stderr.on("data", (d) => {
    const s = d.toString();
    if (!s.includes("ExperimentalWarning") && !s.includes("trace-warnings")) process.stderr.write("[srv] " + s);
  });
  await waitHealth();
  admin = client(await login("admin"));
  assoc = client(await login("assoc"));
  exec = client(await login("exec"));
  finance = client(await login("finance"));
  guest = client(await login("guest"));
});

after(() => { if (proc) proc.kill("SIGTERM"); });

test("只有总管理员能重置，其他角色一律 403", async () => {
  for (const [name, c] of [["assoc", assoc], ["exec", exec], ["finance", finance], ["guest", guest]]) {
    const r = await c("POST", "/api/admin/reset", { confirm: "RESET-ALL-DATA" });
    assert.equal(r.status, 403, `${name} 应 403，实际 ${r.status}`);
    assert.equal(r.data.error.code, "FORBIDDEN");
  }
});

test("不传 confirm 一律拒绝，防止手滑", async () => {
  for (const body of [{}, { confirm: "yes" }, { confirm: "RESET" }, { confirm: "reset-all-data" }]) {
    const r = await admin("POST", "/api/admin/reset", body);
    assert.equal(r.status, 400, `${JSON.stringify(body)} 应 400，实际 ${r.status}`);
    assert.equal(r.data.error.code, "CONFIRM_REQUIRED");
  }
});

test("重置预览：只有总管理员能看，且数量与实际一致", async () => {
  const deny = await assoc("GET", "/api/admin/reset-preview");
  assert.equal(deny.status, 403, `assoc 应 403，实际 ${deny.status}`);

  const a = client(await login("admin"));
  const r = await a("GET", "/api/admin/reset-preview");
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.rows.length, 22, "预览应列出实际被重置的全部22张表（包括微信绑定与短信挑战表）");
  const sum = r.data.rows.reduce((acc, x) => acc + x.count, 0);
  assert.equal(r.data.total, sum, "total 应等于各行之和");

  // 预览的数字必须和真删的一致（同一个 resetSnapshot，防两处口径漂移）
  const projects = await a("GET", "/api/projects?size=200");
  const row = r.data.rows.find((x) => x.key === "projects");
  assert.equal(row.count, projects.data.rows.length, "预览的项目数应等于实际项目数");
  assert.ok(r.data.rows.every((x) => typeof x.label === "string" && x.label.length > 0), "每行都要有中文名");
});

test("重置：脏数据被清空，回到出厂规模", async () => {
  // 造一批「测试残留」：项目、账号、付款、合同
  const p = await admin("POST", "/api/projects", {
    name: "残留项目-重置用例", assoc: "华东医学会", form: "线下",
    date: "2027-07-07", budget: 5000, owner: "王敏", agenda: "09:00 开场"
  });
  assert.equal(p.status, 200);
  const u = await admin("POST", "/api/users", {
    username: "qa_leftover", name: "残留账号", role: "user", password: "Init1234"
  });
  assert.equal(u.status, 200);

  const before = await admin("GET", "/api/projects?size=200");
  const beforeUsers = await admin("GET", "/api/users");
  assert.ok(before.data.rows.some((x) => x.name.includes("残留项目")), "前置：脏项目应已存在");

  const r = await admin("POST", "/api/admin/reset", { confirm: "RESET-ALL-DATA" });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.ok(r.data.before.projects >= 19, `应报告清空前的项目数，实际 ${r.data.before.projects}`);

  // 重新登录（sessions 被清空，旧 Cookie 可能仍因签名有效，但拿新的更稳）
  const admin2 = client(await login("admin"));
  const after = await admin2("GET", "/api/projects?size=200");
  const afterUsers = await admin2("GET", "/api/users");

  assert.equal(after.data.rows.length, 18, `出厂应为 18 个项目，实际 ${after.data.rows.length}`);
  assert.equal(afterUsers.data.rows.length, 8, `出厂应为 8 个账号，实际 ${afterUsers.data.rows.length}`);
  assert.ok(!after.data.rows.some((x) => x.name.includes("残留项目")), "脏项目应已删除");
  assert.ok(!afterUsers.data.rows.some((x) => x.username === "qa_leftover"), "脏账号应已删除");

  /**
   * 重置会清空 sessions 表 —— 所有人当场掉线，必须重新登录。
   * 这是预期行为（不是 bug），所以断言它确实发生了，而不是绕过去。
   */
  const stale = await admin("GET", "/api/projects");
  assert.equal(stale.status, 401, `旧 Cookie 应失效，实际 ${stale.status}`);
});

test("重置会写审计，记下清空前的规模", async () => {
  const a = client(await login("admin")); // 重置后必须重新登录
  const r = await a("GET", "/api/audit?size=50");
  assert.equal(r.status, 200);
  const row = r.data.rows.find((x) => x.action === "重置演示数据");
  assert.ok(row, "应有一条「重置演示数据」审计");
  assert.match(row.detail, /清空前：项目 \d+/);
  assert.match(row.detail, /账号 \d+/);
});

test("重置后系统可正常使用：能建项目、能登录、数据范围正常", async () => {
  const a = client(await login("admin"));
  const c = await a("POST", "/api/projects", {
    name: "重置后可用性验证", assoc: "华东医学会", form: "线下",
    date: "2027-08-08", budget: 8000, owner: "王敏", agenda: "09:00 开场"
  });
  assert.equal(c.status, 200, JSON.stringify(c.data));

  const g = client(await login("guest"));
  const gp = await g("GET", "/api/projects");
  assert.equal(gp.status, 200);
  assert.deepEqual(gp.data.rows.map((x) => x.id).sort(), ["MP-2026-002", "MP-2026-005", "MP-2026-011"],
    "重置后 guest 的数据范围应回到种子状态");

  // 种子材料仍是 8/8（核销前置门要求），付款与结算也都在
  const p17 = await a("GET", "/api/projects/MP-2026-017");
  assert.equal(p17.data.materialsStatus.ok, true, "种子项目材料应齐备");
  const pays = await a("GET", "/api/payments?size=100");
  assert.equal(pays.data.rows.length, 14, `出厂应有 14 笔付款，实际 ${pays.data.rows.length}`);
  const sts = await a("GET", "/api/settlements");
  assert.equal(sts.data.rows.length, 4, `出厂应有 4 张结算单，实际 ${sts.data.rows.length}`);
});
