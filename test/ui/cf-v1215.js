/**
 * V1.2.15 线上验证：审批中心那两条幽灵单已被同步关闭（**只读**，不改生产数据）
 * 运行：node test/ui/cf-v1215.js
 *
 * 老板 2026-10-28 报的两条：AP-2026-012（付款）、AP-2026-013（例外单）。
 * 它们对应的业务单据早就处理完了（付款已在财务结算批过、例外单随改判自动撤销），
 * 审批单只是没同步，所以点「通过」报「不存在」。
 *
 * 部署后应该看到：待审批里没有这两条；全部审批里它们带结论和原因。
 * 这里一条都不点 —— 只读。
 */
const { chromium } = require("playwright");

const BASE = process.env.ERP_BASE || "https://erp.aibuild.work";

let pass = 0, fail = 0;
const check = (name, ok, extra = "") => {
  if (ok) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}  ${extra}`); }
};

(async () => {
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errs = [];
  page.on("pageerror", (e) => errs.push(`[pageerror] ${e.message}`));
  page.on("console", (m) => {
    const t = m.text();
    if (m.type() === "error" && !/Failed to load resource/.test(t)) errs.push(t);
  });

  console.log("\n[1] 总管理员登录 → 审批中心");
  await page.goto(BASE, { waitUntil: "networkidle", timeout: 60000 });
  await page.waitForTimeout(1500);
  await page.fill('input[name="username"]', "admin");
  await page.fill('input[name="password"]', "123456");
  await page.click("#lbtn");
  // 线上有时比本地慢，等壳子出来（右上角「改密码」）再导航，别拿固定 3 秒赌
  await page.waitForSelector("#pwdBtn", { timeout: 40000 });
  await page.goto(`${BASE}/#/approvals`, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForSelector("#body .panel-h", { timeout: 30000 });
  await page.waitForTimeout(800);

  const pendingTxt = (await page.textContent("#content")) || "";
  check("进了审批中心", /审批中心/.test(pendingTxt));

  console.log("\n[2] 待审批里不该再有那两条幽灵单");
  check("AP-2026-012（付款）不在待审批", (await page.locator('tr[data-row="AP-2026-012"]').count()) === 0);
  check("AP-2026-013（例外单）不在待审批", (await page.locator('tr[data-row="AP-2026-013"]').count()) === 0);
  // 待审批计数与行数一致 —— 防止「标签写着 0 条、表里还躺着」
  const hint = (await page.textContent("#body .panel-h")) || "";
  const rowCount = await page.locator("#content tbody tr").count();
  const m = /(\d+)\s*条/.exec(hint);
  if (m) check("待审批计数与行数一致", Number(m[1]) === rowCount, `hint=${hint.trim()} rows=${rowCount}`);

  console.log("\n[3] 全部审批里，两条都带结论和原因");
  await page.click('[data-v="all"]');
  await page.waitForTimeout(1800);
  const row12 = (await page.textContent('tr[data-row="AP-2026-012"]').catch(() => "")) || "";
  const row13 = (await page.textContent('tr[data-row="AP-2026-013"]').catch(() => "")) || "";
  check("AP-2026-012 状态「已通过」", /已通过/.test(row12), row12.replace(/\s+/g, " ").slice(0, 100));
  check("AP-2026-013 状态「已撤销」", /已撤销/.test(row13), row13.replace(/\s+/g, " ").slice(0, 100));
  check("两条都记了处理人和时间", /\d{4}-\d{2}-\d{2}/.test(row12) && /\d{4}-\d{2}-\d{2}/.test(row13),
    `${row12.replace(/\s+/g, " ").slice(-40)} | ${row13.replace(/\s+/g, " ").slice(-40)}`);
  check("不再有待审批状态的这两条", !/待审批/.test(row12) && !/待审批/.test(row13));

  console.log("\n[4] 其余待审批照常可批（没被误伤）");
  const stillPending = await page.locator("#content tbody tr").count();
  const pendingNow = (await page.evaluate(async () => {
    const r = await fetch("/api/approvals?status=待审批", { credentials: "include" });
    return (await r.json()).rows.map((a) => a.id);
  })) || [];
  console.log(`      剩余待审批：${pendingNow.length ? pendingNow.join("、") : "无"}`);
  check("剩余待审批里不含已处理的两条",
    !pendingNow.includes("AP-2026-012") && !pendingNow.includes("AP-2026-013"),
    JSON.stringify(pendingNow));
  check("全部审批列表正常渲染", stillPending > 0, `行数 ${stillPending}`);

  await page.screenshot({ path: "/tmp/cf-v1215.png", fullPage: true });

  console.log("\n[5] 页面错误");
  check("无 JS 报错", errs.length === 0, errs.slice(0, 3).join(" | "));

  await browser.close();
  console.log(`\n=== ${pass} 通过 / ${fail} 失败 ===`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error("脚本异常：", e);
  process.exit(1);
});
