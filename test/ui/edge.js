let chromium;
try { ({ chromium } = require("playwright")); }
catch { ({ chromium } = require("/Users/mac/node_modules/playwright")); }
const BASE = process.env.ERP_BASE || `http://127.0.0.1:${process.env.ERP_PORT || 8787}`;
const assert = require("node:assert/strict");


async function login(page, user, pass = "123456") {
  await page.goto(BASE, { waitUntil: "networkidle" });
  if (await page.$("#lform")) {
    await page.fill('input[name="username"]', user);
    await page.fill('input[name="password"]', pass);
    await page.click("#lbtn");
  }
  await page.waitForSelector(".layout:not([hidden])", { timeout: 10000 });
  await page.waitForTimeout(400);
}

async function apiAs(page, path, method = "GET", body) {
  return page.evaluate(async ({ path, method, body }) => {
    const r = await fetch(path, {
      method,
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined
    });
    return { status: r.status, data: await r.json().catch(() => null) };
  }, { path, method, body });
}

(async () => {
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push("PAGEERROR " + e.message));
  page.on("console", (m) => { if (m.type() === "error") errors.push("CONSOLE " + m.text()); });

  await login(page, "admin");

  /* ---------- 1. XSS：项目名注入 ---------- */
  const xssName = '<img src=x onerror="window.__xss=1">注入测试';
  const created = await apiAs(page, "/api/projects", "POST", {
    name: xssName, assoc: "华东医学会", form: "线下", date: "2026-12-30",
    budget: 10000, owner: "李静", agenda: "09:00 开幕", people: 10
  });
  assert.equal(created.status, 200);
  const xid = created.data.project.id;
  await page.evaluate((id) => (location.hash = `#/projects/${id}`), xid);
  await page.waitForTimeout(900);
  const xssFired = await page.evaluate(() => !!window.__xss);
  const imgCount = await page.$$eval("#content img", (els) => els.length);
  const titleText = await page.innerText(".phead h2");
  console.log("1) XSS: fired =", xssFired, "| 注入 img 标签数 =", imgCount, "| 标题按文本渲染 =", titleText.includes("<img"));
  assert.equal(xssFired, false, "项目名中的脚本不应执行");
  assert.equal(imgCount, 0, "项目名不应被当作 HTML 解析");
  assert.ok(titleText.includes("<img"), "应原样显示为文本");

  /* ---------- 2. 超长文本不撑破布局 ---------- */
  // 80 字上限内、且含 60 个连续无断点字符，专测换行与横向溢出
  const longName = "A".repeat(60) + "超长会议名称测试";
  const c2 = await apiAs(page, "/api/projects", "POST", {
    name: longName, assoc: "华东医学会", form: "混合", date: "2026-12-31",
    budget: 20000, owner: "李静", agenda: "09:00 开幕", people: 20
  });
  assert.equal(c2.status, 200, "80 字以内的名称应可创建");
  await page.evaluate((id) => (location.hash = `#/projects/${id}`), c2.data.project.id);
  await page.waitForTimeout(800);
  const overflow = await page.evaluate(() => {
    const c = document.getElementById("content");
    return { scroll: c.scrollWidth, client: c.clientWidth };
  });
  console.log("2) 超长名称：content scrollWidth =", overflow.scroll, "clientWidth =", overflow.client);
  assert.ok(overflow.scroll <= overflow.client + 2, "页面不应出现横向溢出");

  /* ---------- 3. 不存在的项目 ---------- */
  await page.evaluate(() => (location.hash = "#/projects/MP-9999-999"));
  await page.waitForTimeout(800);
  const errText = await page.innerText("#content");
  console.log("3) 不存在项目：", errText.replace(/\s+/g, " ").slice(0, 50));
  assert.match(errText, /对象不存在|不存在/);

  /* ---------- 4. 空态 ---------- */
  await page.evaluate(() => (location.hash = "#/projects"));
  await page.waitForSelector("#list");
  await page.fill("#q", "zzzz不存在的关键词");
  await page.waitForTimeout(700);
  const emptyText = await page.innerText("#list");
  console.log("4) 空态文案：", emptyText.trim());
  assert.match(emptyText, /没有符合条件/);

  /* ---------- 5. 表单必填校验 ---------- */
  await page.fill("#q", "");
  await page.waitForTimeout(500);
  await page.click("#newBtn");
  await page.waitForSelector("#modal.open");
  await page.click('[data-a="draft"]');
  await page.waitForTimeout(400);
  const errFields = await page.$$eval("#modal .fld.err", (els) => els.length);
  const stillOpen = await page.$("#modal.open");
  console.log("5) 必填校验：标红字段 =", errFields, "| 弹窗仍打开 =", !!stillOpen);
  assert.ok(errFields >= 5, "空表单应标红多个必填项");
  assert.ok(stillOpen, "校验失败不应关闭弹窗");

  // 填完后再提交
  await page.fill('#modal [name="name"]', "校验通过测试会议");
  await page.selectOption('#modal [name="assoc"]', "华东医学会");
  await page.selectOption('#modal [name="form"]', "线下");
  await page.fill('#modal [name="date"]', "2027-01-10");
  await page.fill('#modal [name="budget"]', "30000");
  await page.fill('#modal [name="owner"]', "李静");
  await page.fill('#modal [name="agenda"]', "09:00 开幕 / 10:00 主题报告");
  await page.click('[data-a="draft"]');
  await page.waitForTimeout(900);
  const afterCreate = await page.innerText(".phead h2");
  console.log("   填写后创建：", afterCreate.replace(/\s+/g, " "));
  assert.match(afterCreate, /草稿/);

  /* ---------- 6. 重复点击提交（幂等性） ---------- */
  await page.evaluate(() => (location.hash = "#/projects/MP-2026-018"));
  await page.waitForTimeout(800);
  const submitBtn = await page.$('[data-act="submit"]');
  if (submitBtn) {
    await Promise.all([submitBtn.click(), submitBtn.click().catch(() => {})]);
    await page.waitForTimeout(1000);
    const st = await page.innerText(".phead h2");
    console.log("6) 双击提交后状态：", st.replace(/\s+/g, " "));
    assert.match(st, /待审批/);
  }

  /* ---------- 7. 越权直链：嘉宾访问系统配置 ---------- */
  await page.click("#logoutBtn");
  await page.waitForSelector("#lform");
  await login(page, "guest");
  await page.evaluate(() => (location.hash = "#/users"));
  await page.waitForTimeout(900);
  const hashNow = await page.evaluate(() => location.hash);
  const bodyText = await page.innerText("#content");
  console.log("7) 嘉宾直链 #/users → hash =", hashNow, "| 页面 =", bodyText.replace(/\s+/g, " ").slice(0, 40));
  assert.equal(hashNow, "#/dashboard", "应被重定向回工作台");
  assert.ok(!bodyText.includes("权限矩阵"), "不应渲染系统配置内容");

  /* ---------- 8. 越权直链：嘉宾访问财务 ---------- */
  await page.evaluate(() => (location.hash = "#/finance"));
  await page.waitForTimeout(800);
  const hash2 = await page.evaluate(() => location.hash);
  console.log("8) 嘉宾直链 #/finance → hash =", hash2);
  assert.equal(hash2, "#/dashboard");

  /* ---------- 9. 越权直链：嘉宾访问他人项目 ---------- */
  await page.evaluate(() => (location.hash = "#/projects/MP-2026-003"));
  await page.waitForTimeout(900);
  const t9 = await page.innerText("#content");
  console.log("9) 嘉宾访问他人项目：", t9.replace(/\s+/g, " ").slice(0, 40));
  assert.match(t9, /无权访问/);

  /* ---------- 10. 登录错误提示 ---------- */
  // 用一次性账号做失败登录，避免把真实账号锁进 5 分钟限流（否则后续脚本无法登录）
  const throwaway = "nobody_" + Date.now().toString(36);
  await page.click("#logoutBtn");
  await page.waitForSelector("#lform");
  await page.fill('input[name="username"]', throwaway);
  await page.fill('input[name="password"]', "badpass");
  await page.click("#lbtn");
  await page.waitForTimeout(700);
  const loginErr = await page.innerText("#lerr");
  console.log("10) 登录错误提示：", loginErr.trim());
  assert.match(loginErr, /账号或密码错误/);
  assert.ok(await page.$("#lform"), "失败后应停留在登录页");

  /* ---------- 11. 连续失败触发限流 ---------- */
  for (let i = 0; i < 5; i++) {
    await page.fill('input[name="password"]', "bad" + i);
    await page.click("#lbtn");
    await page.waitForTimeout(350);
  }
  const throttleMsg = await page.innerText("#lerr");
  console.log("11) 第 6 次失败提示：", throttleMsg.trim());
  assert.match(throttleMsg, /次数过多|5 分钟/);

  console.log("\nERRORS:", errors.length);
  errors.slice(0, 8).forEach((e) => console.log(" -", e));
  await browser.close();
  console.log("UI EDGE DONE");
})().catch((e) => { console.error("UI EDGE FAILED:", e.message); process.exit(1); });
