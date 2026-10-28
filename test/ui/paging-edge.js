/**
 * 分页越界回归（真实 Chrome）
 * 运行：node test/ui/paging-edge.js
 *
 * 场景：用户停在第 2 页 → 数据变少只剩 1 页 → 再回到列表。
 * 修复前：分页条只显示「共 N 条」，没有任何按钮，列表空白，只能刷新。
 * 修复后：提示「当前页已超出范围」并给出「回到第 1 页」按钮。
 */
const { chromium } = require("playwright");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..", "..");
const PORT = Number(process.env.ERP_PORT || 8813);
const BASE = process.env.ERP_BASE || `http://127.0.0.1:${PORT}`;
const SELF_HOSTED = !process.env.ERP_BASE;
const DB = path.join(ROOT, "data", "ui-paging.db");
const UP = path.join(ROOT, "data", "ui-paging-uploads");

let pass = 0, fail = 0;
const check = (name, ok, extra = "") => {
  if (ok) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}  ${extra}`); }
};

function clean() {
  for (const f of [DB, DB + "-wal", DB + "-shm"]) if (fs.existsSync(f)) fs.unlinkSync(f);
  if (fs.existsSync(UP)) fs.rmSync(UP, { recursive: true, force: true });
}
async function waitHealth(t = 20000) {
  const t0 = Date.now();
  while (Date.now() - t0 < t) {
    try { const r = await fetch(`${BASE}/api/health`); if (r.ok) return; } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("服务启动超时");
}
async function loginApi(u, p = "123456") {
  const r = await fetch(`${BASE}/api/auth/login`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: u, password: p })
  });
  if (!r.ok) throw new Error(`${u} 登录失败`);
  return r.headers.get("set-cookie").split(";")[0];
}
function cli(cookie) {
  return async (m, u, b) => {
    const r = await fetch(BASE + u, {
      method: m, headers: { "Content-Type": "application/json", cookie },
      body: b === undefined ? undefined : JSON.stringify(b)
    });
    const t = await r.text();
    let d = null; try { d = JSON.parse(t); } catch { d = t; }
    return { status: r.status, data: d };
  };
}

let proc = null;

(async () => {
  if (SELF_HOSTED) {
    clean();
    proc = spawn(process.execPath, ["--experimental-sqlite", "server/index.js"], {
      cwd: ROOT,
      env: { ...process.env, ERP_PORT: String(PORT), ERP_DB: DB, ERP_UPLOAD_DIR: UP },
      stdio: ["ignore", "pipe", "pipe"]
    });
    proc.stderr.on("data", (d) => {
      const s = d.toString();
      if (!s.includes("ExperimentalWarning") && !s.includes("trace-warnings")) process.stderr.write("[srv] " + s);
    });
    await waitHealth();
  }

  // ---- 造 60 条材料（PAGE_SIZE=50，正好 2 页）----
  const cookie = await loginApi("admin");
  const c = cli(cookie);
  const projects = (await c("GET", "/api/projects")).data.rows;
  const p = projects.find((x) => !["已归档", "已结算"].includes(x.status));
  if (!p) throw new Error("找不到可写项目");

  const made = [];
  for (let i = 1; i <= 60; i++) {
    const r = await c("POST", `/api/projects/${p.id}/materials`, { kind: "发票", name: `批量材料-${String(i).padStart(2, "0")}.pdf` });
    if (r.status !== 200) throw new Error(`造材料失败 ${r.status}`);
    made.push(r);
  }
  console.log(`\n已为 ${p.id} 造 60 条材料`);

  /**
   * 页数按实际总数算，不写死。
   * V1.2.19 起种子给 8 个项目各备了 8 类材料（核销前置），材料总数会随种子调整而变，
   * 写死「2 页」的断言迟早会飘 —— 这里只关心「多页 → 删到 1 页 → 页码越界」这条逻辑。
   */
  const totalBefore = (await c("GET", "/api/materials")).data.rows.length;
  const PAGES = Math.max(2, Math.ceil(totalBefore / 50));
  console.log(`  当前材料总数 ${totalBefore}，共 ${PAGES} 页`);

  const browser = await chromium.launch({ channel: "chrome", headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errs = [];
  page.on("pageerror", (e) => errs.push(`[pageerror] ${e.message}`));
  page.on("console", (m) => { if (m.type() === "error") errs.push(m.text()); });

  console.log("\n[1] 登录并进入材料中心");
  await page.goto(BASE, { waitUntil: "networkidle" });
  await page.waitForTimeout(800);
  for (let i = 0; i < 3; i++) {
    await page.fill('input[name="username"]', "admin");
    await page.fill('input[name="password"]', "123456");
    if (await page.inputValue('input[name="username"]') === "admin") break;
    await page.waitForTimeout(400);
  }
  await page.click("#lbtn");
  await page.waitForTimeout(2500);
  check("登录成功", !!(await page.$("#pwdBtn")));

  await page.goto(`${BASE}/#/materials`, { waitUntil: "networkidle" });
  await page.waitForTimeout(1800);
  const pg1 = (await page.textContent(".pager").catch(() => "")) || "";
  check(`第 1 页：显示 ${PAGES} 页`, new RegExp(`第 1 / ${PAGES} 页`).test(pg1), pg1.replace(/\s+/g, " ").slice(0, 80));

  console.log(`\n[2] 翻到最后一页（第 ${PAGES} 页）`);
  const btnLast = await page.$(`[data-pg="${PAGES}"]`);
  check(`有第 ${PAGES} 页按钮`, !!btnLast);
  if (btnLast) {
    await btnLast.click();
    await page.waitForTimeout(1500);
    const pg2 = (await page.textContent(".pager").catch(() => "")) || "";
    check(`第 ${PAGES} 页：显示 ${PAGES}/${PAGES}`,
      new RegExp(`第 ${PAGES} / ${PAGES} 页`).test(pg2), pg2.replace(/\s+/g, " ").slice(0, 80));
  }

  /**
   * 删到只剩 1 页 —— 只有 pages<=1 时前端才会给出「当前页已超出范围 + 回到第 1 页」。
   *
   * 不能只删自己造的 60 条：V1.2.19 起种子给 8 个项目各备了 8 类材料，
   * 光种子就 69 条、本来就超过 1 页。这里是 self-hosted 独立库，跑完即弃，
   * 所以允许把种子材料也删掉（已结算/已归档项目的材料删不动，跳过即可）。
   */
  console.log("\n[3] 删到 1 页以内（先删自己造的，不够再删种子可删的）");
  const all = (await c("GET", "/api/materials")).data.rows;
  const mineFirst = [
    ...all.filter((m) => (m.name || "").startsWith("批量材料-")),
    ...all.filter((m) => !(m.name || "").startsWith("批量材料-"))
  ];
  let deleted = 0;
  let left = all.length;
  for (const m of mineFirst) {
    if (left <= 45) break;
    const r = await c("DELETE", `/api/materials/${m.id}`);
    if (r.status === 200) { deleted++; left--; }
  }
  check(`已删到 1 页以内（删了 ${deleted} 条）`, left <= 45, `剩 ${left} 条`);

  console.log("\n[4] 离开再回到材料中心（curPage 仍为 2）");
  await page.goto(`${BASE}/#/projects`, { waitUntil: "networkidle" });
  await page.waitForTimeout(1200);
  await page.goto(`${BASE}/#/materials`, { waitUntil: "networkidle" });
  await page.waitForTimeout(1800);

  const pg3 = (await page.textContent(".pager").catch(() => "")) || "";
  const rows3 = (await page.$$("tbody tr")).length;
  check("提示当前页已超出范围", /当前页已超出范围/.test(pg3), pg3.replace(/\s+/g, " ").slice(0, 90));
  // 必须按文案找，不能用 [data-pg="1"]——正常分页里的页码 1 也是这个选择器
  const backBtn = await page.$('.pager button:has-text("回到第 1 页")');
  check("提供「回到第 1 页」按钮", !!backBtn, `rows=${rows3}`);
  await page.screenshot({ path: "/tmp/erp-contract-test/paging-overflow.png" });

  console.log("\n[5] 点「回到第 1 页」");
  if (backBtn) {
    await backBtn.click();
    await page.waitForTimeout(1800);
    const pg4 = (await page.textContent(".pager").catch(() => "")) || "";
    check("不再提示越界", !/当前页已超出范围/.test(pg4), pg4.replace(/\s+/g, " ").slice(0, 80));
    // 回到第 1 页后列表要真的有数据；不盯具体文件名 —— 为了造「1 页」场景删过一批，
    // 写死某一条会被自己删掉，断言就成了自伤
    const body = (await page.textContent("#content")) || "";
    const rowCount = await page.$$eval("tbody tr", (rs) => rs.length);
    check("列表恢复显示数据", rowCount > 0 && !/暂无材料/.test(body), `rows=${rowCount}`);
  }

  console.log("\n[6] 控制台");
  check("无 JS 报错", errs.length === 0, errs.slice(0, 3).join(" | "));

  await browser.close();
  if (proc) proc.kill("SIGTERM");
  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error("脚本异常：", e);
  if (proc) proc.kill("SIGTERM");
  process.exit(2);
});
