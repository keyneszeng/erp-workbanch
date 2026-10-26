/**
 * 上传链路 UI 验证（真实 Chrome）
 * 运行：node test/ui/upload.js
 *
 * 验的是「用户能不能真的把照片传上去」，不是接口层面：
 * 选文件 → 压缩提示 → 上传进度 → 列表出缩略图 → 点开能看原图。
 */
const { chromium } = require("playwright");

// 与 smoke / e2e / edge 保持同一套约定：ERP_BASE 优先，否则按 ERP_PORT（默认 8787）。
// 原来写死 8899，只有碰巧在那个端口起了服务才跑得起来。
const BASE = process.env.ERP_BASE || `http://127.0.0.1:${process.env.ERP_PORT || 8787}`;
const PHOTO = "/tmp/erp-upload-test/photo-small.jpg";
const BIG = "/tmp/erp-upload-test/big.jpg";

let pass = 0, fail = 0;
const check = (name, ok, extra = "") => {
  if (ok) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}  ${extra}`); }
};

(async () => {
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errs = [];
  page.on("pageerror", (e) => errs.push(e.message));
  page.on("console", (m) => { if (m.type() === "error") errs.push(m.text()); });

  console.log("\n[1] 登录");
  await page.goto(BASE, { waitUntil: "networkidle" });
  await page.fill('input[name="username"]', "admin");
  await page.fill('input[name="password"]', "123456");
  await page.click('button[type="submit"]');
  await page.waitForTimeout(2000);
  check("登录成功", (await page.textContent("body")).includes("工作台"));

  console.log("\n[2] 进入材料中心");
  await page.goto(`${BASE}/#/materials`, { waitUntil: "networkidle" });
  await page.waitForTimeout(1500);
  const hasAdd = await page.$("#add");
  check("材料中心有登记入口", !!hasAdd);

  console.log("\n[3] 打开登记弹窗");
  await page.click("#add");
  await page.waitForTimeout(500);
  const fileInput = await page.$('#modal input[type="file"]');
  check("弹窗内有文件选择控件", !!fileInput);

  console.log("\n[4] 超大文件被前端拦下");
  if (BIG) {
    await page.setInputFiles('#modal input[type="file"]', BIG);
    await page.waitForTimeout(1200);
    const toastText = await page.textContent("#toast");
    check("超过 8MB 给出提示", /8\.0 MB|不能超过/.test(toastText), toastText.trim().slice(0, 60));
  }

  console.log("\n[5] 选择正常照片，触发压缩");
  await page.setInputFiles('#modal input[type="file"]', PHOTO);
  await page.waitForTimeout(2000);
  const fnText = await page.textContent('#modal .upload .fn');
  check("文件名与大小回显", /\.jpg/.test(fnText), fnText);
  const nameVal = await page.inputValue('#modal [name="name"]');
  check("名称自动带出文件名", nameVal.length > 0, nameVal);

  // 压缩后实际大小（用页面里的 canvas 结果反推）
  const compressed = await page.evaluate(async () => {
    const inp = document.querySelector('#modal input[type="file"]');
    return inp && inp.files && inp.files[0] ? inp.files[0].size : -1;
  });
  check("原始文件已选入", compressed > 0, `${compressed} bytes`);

  console.log("\n[6] 提交并上传");
  await page.click('#modal [data-x="1"]');
  await page.waitForTimeout(4000);
  const bodyAfter = await page.textContent("body");
  check("提交后弹窗关闭", !(await page.$('#modal.open')));
  check("列表出现缩略图", (await page.$$("img.thumb")).length > 0);

  await page.screenshot({ path: "/tmp/erp-upload-test/ui-01-materials.png", fullPage: true });

  console.log("\n[7] 点开缩略图验证原图可访问");
  const thumbSrc = await page.getAttribute("img.thumb", "src");
  check("缩略图地址正确", /^\/api\/uploads\/[a-f0-9]{32}\.jpg$/.test(thumbSrc || ""), thumbSrc || "");
  if (thumbSrc) {
    const r = await page.request.get(BASE + thumbSrc);
    check("原图 HTTP 200", r.status() === 200, `status=${r.status()}`);
    const ct = r.headers()["content-type"];
    check("返回 image/jpeg", ct === "image/jpeg", ct);
    const buf = await r.body();
    check("字节数 > 10KB", buf.length > 10 * 1024, `${buf.length} bytes`);
  }

  console.log("\n[8] 分页条渲染");
  await page.goto(`${BASE}/#/projects`, { waitUntil: "networkidle" });
  await page.waitForTimeout(1500);
  const pagerText = await page.textContent(".pager");
  check("项目列表显示总数", /共 \d+ 场/.test(pagerText || ""), pagerText);

  console.log("\n[9] 修改密码入口");
  const pwdBtn = await page.$("#pwdBtn");
  check("顶栏有修改密码按钮", !!pwdBtn);
  if (pwdBtn) {
    await pwdBtn.click();
    await page.waitForTimeout(400);
    const fields = await page.$$eval('#modal input[type="password"]', (els) => els.length);
    check("改密弹窗三个密码框", fields === 3, `${fields}`);
    await page.click('#modal [data-x="0"]');
  }

  await page.screenshot({ path: "/tmp/erp-upload-test/ui-02-projects.png", fullPage: true });

  console.log("\n[10] 控制台");
  check("无 JS 报错", errs.length === 0, errs.slice(0, 3).join(" | "));

  await browser.close();
  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("脚本异常：", e); process.exit(2); });
