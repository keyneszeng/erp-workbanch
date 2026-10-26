/**
 * V1.2.0 线上冒烟：分页 / 改密 / 上传降级
 * 运行：node test/ui/cf-v12.js
 *
 * 线上（Cloudflare）没有绑定 R2，上传会返回 503。
 * 这个脚本要验的正是「点了上传按钮，用户能不能看懂发生了什么」，
 * 而不是上传成功——成功路径在本地 test/ui/upload.js 里验。
 */
const { chromium } = require("playwright");

const BASE = process.env.ERP_BASE || "https://erp.aibuild.work";
const PHOTO = "/tmp/erp-upload-test/photo-small.jpg";

let pass = 0, fail = 0;
const check = (name, ok, extra = "") => {
  if (ok) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}  ${extra}`); }
};

async function login(page) {
  await page.goto(BASE, { waitUntil: "networkidle" });
  // 线上慢，boot() 的 /api/auth/me 可能晚于填表返回并重渲染登录页
  await page.waitForTimeout(1200);
  for (let i = 0; i < 3; i++) {
    await page.fill('input[name="username"]', "admin");
    await page.fill('input[name="password"]', "123456");
    const u = await page.inputValue('input[name="username"]');
    if (u === "admin") break;
    await page.waitForTimeout(500);
  }
  await page.click("#lbtn");
  await page.waitForTimeout(3000);
  // 不能用 body 全文匹配错误文案：审计日志「最近动态」里可能正好有一条
  // 「账号或密码错误」的历史记录，会把登录成功的页面误判为失败。
  const shell = !!(await page.$("#pwdBtn"));
  const loginVisible = await page.isVisible(".login-box").catch(() => false);
  return shell && !loginVisible;
}

(async () => {
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errs = [];
  // 本脚本会故意触发两条失败响应：上传 503（未绑 R2）、改密 400（原密码错误）。
  // 浏览器把它们记成 console error，属于预期，不能算 JS 报错。
  const EXPECTED_FAIL = [/\/api\/uploads$/, /\/api\/auth\/password$/];
  page.on("pageerror", (e) => errs.push(`[pageerror] ${e.message}`));
  page.on("console", (m) => {
    if (m.type() !== "error") return;
    const url = (m.location() && m.location().url) || "";
    if (EXPECTED_FAIL.some((re) => re.test(url))) return;
    errs.push(`${m.text()} @ ${url}`);
  });

  console.log(`\n目标：${BASE}`);
  console.log("\n[1] 登录");
  check("登录成功", await login(page));

  console.log("\n[2] 项目列表分页");
  await page.goto(`${BASE}/#/projects`, { waitUntil: "networkidle" });
  await page.waitForTimeout(2000);
  const projPager = (await page.textContent(".pager").catch(() => "")) || "";
  check("分页条显示总数", /共 \d+ 场/.test(projPager), projPager.trim());
  const sumText = (await page.textContent("#sum").catch(() => "")) || "";
  check("预算合计非零（全量汇总）", /¥[\d,]{4,}/.test(sumText), sumText.trim());
  const rows1 = (await page.$$("#list tbody tr")).length;
  check("首页行数受限（≤50）", rows1 > 0 && rows1 <= 50, `${rows1} 行`);

  // 翻页：线上项目数不足一页（PAGE_SIZE=50）时没有第 2 页按钮，这是正确行为。
  // 所以 UI 层有按钮就点，没有就改用小 size 直接验接口的分页契约。
  const page2 = await page.$('[data-pg="2"]');
  if (page2) {
    await page2.click();
    await page.waitForTimeout(1800);
    const pager2 = (await page.textContent(".pager")) || "";
    check("可翻到第 2 页", /第 2 \//.test(pager2), pager2.trim());
  } else {
    check("单页时不出翻页按钮", /共 \d+ 场/.test(projPager) && !/第 1 \//.test(projPager), projPager.trim());
    const pg = await page.evaluate(async () => {
      const j = async (u) => (await fetch(u, { credentials: "same-origin" })).json();
      const a = await j("/api/projects?page=1&size=5");
      const b = await j("/api/projects?page=2&size=5");
      return { a, b };
    });
    check("接口 page=1&size=5 生效", Array.isArray(pg.a.rows) && pg.a.rows.length === 5 && pg.a.paged === true,
      `${pg.a.rows?.length} 行 / paged=${pg.a.paged}`);
    check("接口第 2 页内容不同", Array.isArray(pg.b.rows) && pg.b.rows.length > 0 &&
      !pg.b.rows.some((r) => pg.a.rows.some((x) => x.id === r.id)),
      `${pg.b.rows?.length} 行`);
    check("分页不改全量汇总", Math.abs(Number(pg.a.summary?.budget) - Number(pg.b.summary?.budget)) < 1e-6 &&
      Number(pg.a.summary?.budget) > 0, `¥${pg.a.summary?.budget} / ¥${pg.b.summary?.budget}`);
  }
  await page.screenshot({ path: "/tmp/cf-v12-projects.png" });

  console.log("\n[3] 材料中心");
  await page.goto(`${BASE}/#/materials`, { waitUntil: "networkidle" });
  await page.waitForTimeout(2000);
  const matPager = (await page.textContent(".pager").catch(() => "")) || "";
  check("材料分页条", /共 \d+ 条/.test(matPager), matPager.trim());
  const kpi = (await page.textContent(".kpi .v").catch(() => "")) || "";
  check("材料条目 KPI 用全量数", /\d+/.test(kpi), kpi.trim());
  await page.screenshot({ path: "/tmp/cf-v12-materials.png", fullPage: true });

  console.log("\n[4] 上传入口与降级提示");
  const addBtn = await page.$("#add");
  check("登记材料按钮存在", !!addBtn);
  if (addBtn) {
    await addBtn.click();
    await page.waitForTimeout(600);
    const fileInput = await page.$('#modal input[type="file"]');
    check("弹窗内有文件控件", !!fileInput);

    if (fileInput) {
      await page.setInputFiles('#modal input[type="file"]', PHOTO);
      await page.waitForTimeout(1500);
      const fn = (await page.textContent("#modal .upload .fn")) || "";
      check("文件已选中并回显", /\.jpg/.test(fn), fn.trim());

      await page.click('#modal [data-x="1"]');
      await page.waitForTimeout(3500);
      const toastText = (await page.textContent("#toast").catch(() => "")) || "";
      check("存储未配置时提示可读", /存储|R2/.test(toastText), toastText.trim().slice(0, 80));
      check("未出现「服务器内部错误」", !/服务器内部错误/.test(toastText), toastText.trim().slice(0, 80));
    }
    // 关掉弹窗
    const cancel = await page.$('#modal [data-x="0"]');
    if (cancel) await cancel.click();
    await page.waitForTimeout(400);
  }

  console.log("\n[5] 审计日志分页");
  await page.goto(`${BASE}/#/audit`, { waitUntil: "networkidle" });
  await page.waitForTimeout(2000);
  const auditPager = (await page.textContent(".pager").catch(() => "")) || "";
  check("审计分页条", /共 \d+ 条/.test(auditPager), auditPager.trim());

  console.log("\n[6] 修改密码");
  const pwdBtn = await page.$("#pwdBtn");
  check("顶栏有修改密码按钮", !!pwdBtn);
  if (pwdBtn) {
    await pwdBtn.click();
    await page.waitForTimeout(500);
    const n = await page.$$eval('#modal input[type="password"]', (els) => els.length);
    check("三个密码输入框", n === 3, `${n} 个`);
    // 故意填错原密码，验证服务端校验（不动真实密码）
    await page.fill('#modal input[name="oldPassword"]', "WrongPass1");
    await page.fill('#modal input[name="newPassword"]', "SomePass123");
    await page.fill('#modal input[name="confirmPassword"]', "SomePass123");
    await page.click('#modal [data-x="1"]');
    await page.waitForTimeout(3000);
    const t2 = (await page.textContent("#toast").catch(() => "")) || "";
    check("原密码错误被拒绝", /原密码/.test(t2), t2.trim().slice(0, 60));
    const c2 = await page.$('#modal [data-x="0"]');
    if (c2) await c2.click();
  }

  console.log("\n[7] 控制台");
  check("无 JS 报错", errs.length === 0, errs.slice(0, 3).join(" | "));

  await browser.close();
  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("脚本异常：", e); process.exit(2); });
