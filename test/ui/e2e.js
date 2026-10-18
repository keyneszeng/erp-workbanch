let chromium;
try { ({ chromium } = require("playwright")); }
catch { ({ chromium } = require("/Users/mac/node_modules/playwright")); }
const BASE = process.env.ERP_BASE || `http://127.0.0.1:${process.env.ERP_PORT || 8787}`;
const assert = require("node:assert/strict");
const fs = require("node:fs");


async function login(page, user) {
  await page.goto(BASE, { waitUntil: "networkidle" });
  if (await page.$("#lform")) {
    await page.fill('input[name="username"]', user);
    await page.fill('input[name="password"]', "123456");
    await page.click("#lbtn");
  }
  await page.waitForSelector(".layout:not([hidden])", { timeout: 10000 });
  await page.waitForTimeout(500);
}

(async () => {
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 960 }, acceptDownloads: true });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push("PAGEERROR " + e.message));
  page.on("console", (m) => { if (m.type() === "error") errors.push("CONSOLE " + m.text()); });

  /* ---------- 1. 嘉宾视角：导航裁剪 ---------- */
  await login(page, "guest");
  const guestNav = await page.$$eval("#nav .ni", (els) => els.map((e) => e.innerText.trim()));
  console.log("1) 嘉宾导航：", guestNav.join(" | "));
  assert.ok(guestNav.some((n) => n.includes("项目管理") || n.includes("会议项目")));
  assert.ok(!guestNav.some((n) => n.includes("系统配置")), "嘉宾不应看到系统配置");
  assert.ok(!guestNav.some((n) => n.includes("审计日志")), "嘉宾不应看到审计日志");
  assert.ok(!guestNav.some((n) => n.includes("审批中心")), "嘉宾不应看到审批中心");
  assert.ok(!guestNav.some((n) => n.includes("合同台账")), "嘉宾不应看到合同台账");
  await page.evaluate(() => (location.hash = "#/projects"));
  await page.waitForSelector("#list", { timeout: 8000 });
  await page.waitForTimeout(400);
  const guestRows = await page.$$eval("#list tbody tr", (r) => r.length);
  console.log("   嘉宾可见项目数：", guestRows);
  await page.screenshot({ path: "/tmp/e2e-guest.png" });

  /* ---------- 2. 协会管理员：新建立项 → 提交 → 审批 ---------- */
  await page.click("#logoutBtn");
  await page.waitForSelector("#lform");
  await login(page, "assoc");
  await page.evaluate(() => (location.hash = "#/projects"));
  await page.waitForTimeout(500);
  await page.click("#newBtn");
  await page.waitForSelector("#modal.open");
  const name = "E2E 联调会议 " + Date.now().toString().slice(-5);
  await page.fill('[name="name"]', name);
  await page.selectOption('[name="assoc"]', "华东医学会");
  await page.selectOption('[name="form"]', "线下");
  await page.fill('[name="date"]', "2026-12-28");
  await page.fill('[name="budget"]', "88000");
  await page.fill('[name="people"]', "60");
  await page.fill('[name="owner"]', "王敏");
  await page.fill('[name="agenda"]', "09:00 开幕 / 10:00 主题报告 / 14:00 圆桌");
  await page.click('[data-a="submit"]');
  await page.waitForTimeout(900);
  const detailTitle = await page.innerText(".phead h2");
  console.log("2) 立项后进入详情：", detailTitle.replace(/\s+/g, " "));
  const pid = (await page.innerText(".crumb .mono")).trim();
  console.log("   项目编号：", pid);
  assert.match(detailTitle, /待审批/);

  // 审批通过
  await page.click('[data-act="approve"]');
  await page.waitForTimeout(300);
  const hasConfirm = await page.$("#modal.open");
  if (hasConfirm) await page.click('#modal [data-x="1"]');
  await page.waitForTimeout(900);
  const afterApprove = await page.innerText(".phead h2");
  console.log("   审批后：", afterApprove.replace(/\s+/g, " "));
  assert.match(afterApprove, /已立项/);

  // 通过界面把执行与财务加入项目（测试成员授权 + 数据范围）
  await page.click('[data-tab="team"]');
  await page.waitForTimeout(500);
  for (const nm of ["张伟", "陈静"]) {
    await page.click("#addMem");
    await page.waitForSelector("#modal.open");
    const opts = await page.$$eval('#modal select option', (os) => os.map((o) => o.textContent));
    const idx = opts.findIndex((o) => o.includes(nm));
    assert.ok(idx >= 0, `应能在成员列表中找到 ${nm}`);
    await page.selectOption('#modal select', { index: idx });
    await page.click('#modal [data-x="1"]');
    await page.waitForTimeout(600);
  }
  const members = await page.innerText("#tabbody");
  console.log("   项目成员：", members.replace(/\s+/g, " ").slice(0, 90));

  /* ---------- 3. 推进到待核销 ---------- */
  for (const act of ["prep", "exec", "request_verify"]) {
    await page.click(`[data-act="${act}"]`);
    await page.waitForTimeout(700);
  }
  const st = await page.innerText(".phead h2");
  console.log("3) 推进后状态：", st.replace(/\s+/g, " "));
  assert.match(st, /待核销/);
  await page.screenshot({ path: "/tmp/e2e-detail-verify.png" });

  /* ---------- 4. 付款门禁（待核销时） ---------- */
  await page.click('[data-tab="payments"]');
  await page.waitForTimeout(500);
  const gateText = await page.innerText("#tabbody .gate");
  console.log("4) 付款门禁提示：", gateText.replace(/\s+/g, " ").slice(0, 80));
  const payBtnDisabled = await page.$eval("#addPay", (b) => b.disabled).catch(() => true);
  console.log("   付款申请按钮 disabled =", payBtnDisabled);
  assert.equal(payBtnDisabled, true);

  /* ---------- 5. 核销判定（不通过 → 例外单） ---------- */
  await page.click('[data-tab="verify"]');
  await page.waitForTimeout(400);
  for (const no of [1, 2, 3]) {
    await page.click(`[data-judge="${no}"]`);
    await page.waitForSelector("#modal.open");
    await page.click('#modal [data-x="1"]');
    await page.waitForTimeout(600);
  }
  await page.click('[data-judge="4"]');
  await page.waitForSelector("#modal.open");
  await page.selectOption('#modal [name="result"]', "不通过");
  await page.fill('#modal [name="remark"]', "课件与议程课题不一致（E2E）");
  await page.click('#modal [data-x="1"]');
  await page.waitForTimeout(800);
  const exText = await page.innerText("#tabbody");
  console.log("5) 例外单生成：", /EX-2026-\d+/.exec(exText)?.[0] || "未生成");
  assert.match(exText, /待审批/);
  await page.screenshot({ path: "/tmp/e2e-exception.png" });

  /* ---------- 6. 财务：例外审批 + 核销通过 + 付款 ---------- */
  await page.click("#logoutBtn");
  await page.waitForSelector("#lform");
  await login(page, "finance");
  await page.evaluate((p) => (location.hash = `#/verify/${p}`), pid);
  await page.waitForTimeout(900);
  const exBtn = await page.$("[data-ex]");
  assert.ok(exBtn, "财务应看到例外审批按钮");
  await exBtn.click();
  await page.waitForSelector("#modal.open");
  await page.fill('#modal [name="comment"]', "同意补录");
  await page.click('#modal [data-x="1"]');
  await page.waitForTimeout(800);
  const step4 = await page.$$eval(".vstep", (els) => els.map((e) => e.innerText.replace(/\s+/g, " ")));
  console.log("6) 第 4 步状态：", step4[3].slice(0, 40));
  assert.match(step4[3], /已解例外/);

  for (const no of [5, 6]) {
    await page.click(`[data-judge="${no}"]`);
    await page.waitForSelector("#modal.open");
    await page.click('#modal [data-x="1"]');
    await page.waitForTimeout(700);
  }
  await page.click("#passBtn");
  await page.waitForSelector("#modal.open");
  await page.click('#modal [data-x="1"]');
  await page.waitForTimeout(900);
  const afterPass = await page.innerText(".phead h2");
  console.log("   核销通过后：", afterPass.replace(/\s+/g, " "));
  assert.match(afterPass, /已核销/);

  // 付款申请
  await page.evaluate((p) => (location.hash = `#/projects/${p}`), pid);
  await page.waitForTimeout(800);
  await page.click('[data-tab="payments"]');
  await page.waitForTimeout(400);
  await page.click("#addPay");
  await page.waitForSelector("#modal.open");
  await page.selectOption('#modal [name="type"]', "学会公付");
  await page.fill('#modal [name="payee"]', "E2E 测试酒店");
  await page.fill('#modal [name="amount"]', "12000");
  await page.fill('#modal [name="invoice_no"]', "E2E-INV-1");
  await page.click('#modal [data-x="1"]');
  await page.waitForTimeout(900);
  const payText = await page.innerText("#tabbody");
  const payId = /PY-2026-\d+/.exec(payText)?.[0];
  console.log("   付款申请提交：", payId || "未提交");
  assert.match(payText, /待审批/);

  // 结算前必须把付款走完（新门禁：存在未完成付款不允许结算）
  await page.click(`[data-pay-approve="${payId}"]`);
  await page.waitForTimeout(700);
  await page.click(`[data-pay-pay="${payId}"]`);
  await page.waitForSelector("#modal.open");
  await page.click('#modal [data-x="1"]');
  await page.waitForTimeout(800);
  const paidText = await page.innerText("#tabbody");
  console.log("   付款完成后：", /已付款/.test(paidText) ? "已付款" : "状态异常");
  assert.match(paidText, /已付款/);

  /* ---------- 7. 结算 ---------- */
  await page.evaluate((p) => (location.hash = `#/projects/${p}`), pid);
  await page.waitForTimeout(700);
  await page.click('[data-act="settle"]');
  await page.waitForSelector("#modal.open");
  await page.click('#modal [data-x="1"]');
  await page.waitForTimeout(900);
  const afterSettle = await page.innerText(".phead h2");
  console.log("7) 结算后：", afterSettle.replace(/\s+/g, " "));
  assert.match(afterSettle, /已结算/);

  /* ---------- 8. 归档门禁 ---------- */
  await page.click('[data-tab="materials"]');
  await page.waitForTimeout(400);
  await page.click("#addMat");
  await page.waitForSelector("#modal.open");
  for (const kind of ["立项文件", "合同", "议程", "课件", "签到表", "劳务表", "发票", "现场照片"]) {
    await page.selectOption('#modal [name="kind"]', kind);
    await page.fill('#modal [name="name"]', kind + "-E2E.pdf");
    await page.click('#modal [data-x="1"]');
    await page.waitForTimeout(450);
    if (kind !== "现场照片") {
      await page.click("#addMat");
      await page.waitForSelector("#modal.open");
    }
  }
  await page.waitForTimeout(600);
  await page.click('[data-tab="overview"]');
  await page.waitForTimeout(400);
  await page.click('[data-act="archive"]');
  await page.waitForSelector("#modal.open");
  await page.click('#modal [data-x="1"]');
  await page.waitForTimeout(900);
  const afterArchive = await page.innerText(".phead h2");
  console.log("8) 归档后：", afterArchive.replace(/\s+/g, " "));
  assert.match(afterArchive, /已归档/);
  await page.screenshot({ path: "/tmp/e2e-archived.png" });

  /* ---------- 9. 导出下载 ---------- */
  await page.evaluate(() => (location.hash = "#/projects"));
  await page.waitForTimeout(600);
  const [dl] = await Promise.all([page.waitForEvent("download"), page.click("#expBtn")]);
  const file = "/tmp/" + dl.suggestedFilename();
  await dl.saveAs(file);
  const size = fs.statSync(file).size;
  console.log("9) 导出文件：", dl.suggestedFilename(), size, "bytes");
  assert.ok(size > 500);
  const buf = fs.readFileSync(file);
  assert.deepEqual([...buf.subarray(0, 3)], [0xef, 0xbb, 0xbf]);

  /* ---------- 10. 总管理员用户管理 ---------- */
  await page.click("#logoutBtn");
  await page.waitForSelector("#lform");
  await login(page, "admin");
  await page.evaluate(() => (location.hash = "#/users"));
  await page.waitForTimeout(700);
  const matrix = await page.$$eval("table", (ts) => ts.length);
  console.log("10) 用户页表格数：", matrix);
  assert.ok(matrix >= 2);
  await page.screenshot({ path: "/tmp/e2e-users.png" });

  console.log("\nERRORS:", errors.length);
  errors.slice(0, 10).forEach((e) => console.log(" -", e));
  await browser.close();
  console.log("E2E DONE");
})().catch(async (e) => {
  console.error("E2E FAILED:", e.message);
  process.exit(1);
});
