/**
 * 合同原件上传 UI 验证（真实 Chrome）
 * 运行：node test/ui/contract.js
 *
 * 验的是「录入合同时能不能直接把盖章扫描件 / 拍照件挂上去」：
 *   打开弹窗 → 选文件 → 名称自动带出 → 上传 → 列表出现原件入口 → 点开能拿到文件。
 * 脚本自带服务，不依赖外部进程（设 ERP_BASE 可指向已有服务）。
 */
const { chromium } = require("playwright");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..", "..");
const PORT = Number(process.env.ERP_PORT || 8811);
const BASE = process.env.ERP_BASE || `http://127.0.0.1:${PORT}`;
const SELF_HOSTED = !process.env.ERP_BASE;

const TMP = "/tmp/erp-contract-test";
const PDF_FILE = path.join(TMP, "服务合同-盖章版.pdf");
const IMG_FILE = path.join(TMP, "合同拍照件.jpg");
const DB = path.join(ROOT, "data", "ui-contract.db");
const UP = path.join(ROOT, "data", "ui-contract-uploads");

let pass = 0, fail = 0;
const check = (name, ok, extra = "") => {
  if (ok) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}  ${extra}`); }
};

function makeFixtures() {
  fs.mkdirSync(TMP, { recursive: true });
  // 最小合法 PDF（服务端只嗅探 %PDF 魔数）
  fs.writeFileSync(PDF_FILE, Buffer.from(
    "%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n", "utf8"));
  // 1×1 JPEG
  fs.writeFileSync(IMG_FILE, Buffer.from(
    "/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==",
    "base64"));
}

function clean() {
  for (const f of [DB, DB + "-wal", DB + "-shm"]) if (fs.existsSync(f)) fs.unlinkSync(f);
  if (fs.existsSync(UP)) fs.rmSync(UP, { recursive: true, force: true });
}

async function waitHealth(timeout = 20000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    try { const r = await fetch(`${BASE}/api/health`); if (r.ok) return; } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("服务启动超时");
}

let proc = null;

(async () => {
  makeFixtures();
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

  const browser = await chromium.launch({ channel: "chrome", headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errs = [];
  page.on("pageerror", (e) => errs.push(`[pageerror] ${e.message}`));
  page.on("console", (m) => { if (m.type() === "error") errs.push(m.text()); });

  // toast 3 秒后自动移除，等提交完再读 DOM 会读到空。
  // 在每次导航前注入监听，把所有出现过的提示攒起来。
  await page.addInitScript(() => {
    window.__toasts = [];
    const hook = () => {
      const box = document.getElementById("toast");
      if (!box) return setTimeout(hook, 50);
      new MutationObserver((ms) => {
        for (const m of ms) for (const n of m.addedNodes) {
          if (n.textContent) window.__toasts.push(n.textContent);
        }
      }).observe(box, { childList: true });
    };
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", hook);
    else hook();
  });
  const toasts = () => page.evaluate(() => window.__toasts || []);

  console.log("\n[1] 登录");
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
  check("登录成功", !!(await page.$("#pwdBtn")) && !(await page.isVisible(".login-box").catch(() => false)));

  console.log("\n[2] 进入合同台账");
  await page.goto(`${BASE}/#/contracts`, { waitUntil: "networkidle" });
  await page.waitForTimeout(1800);
  const newBtn = await page.$("#newC");
  check("有「录入合同」按钮", !!newBtn);
  const headers = (await page.textContent("#app table thead").catch(() => "")) || "";
  check("清单有「原件」列", /原件/.test(headers), headers.replace(/\s+/g, " ").slice(0, 90));

  console.log("\n[3] 打开录入弹窗");
  await newBtn.click();
  await page.waitForTimeout(600);
  check("弹窗内有文件控件", !!(await page.$('#modal input[type="file"]')));
  const accept = await page.getAttribute('#modal input[type="file"]', "accept");
  check("控件接受 PDF 与图片", /application\/pdf/.test(accept || "") && /image\/jpeg/.test(accept || ""), accept || "");

  console.log("\n[4] 选 PDF 扫描件");
  await page.setInputFiles('#modal input[type="file"]', PDF_FILE);
  await page.waitForTimeout(1500);
  const fn = (await page.textContent("#modal .upload .fn")) || "";
  check("文件名回显", /\.pdf/.test(fn), fn.trim());
  const autoName = await page.inputValue('#modal [name="name"]');
  check("合同名称自动带出（去掉扩展名）", autoName === "服务合同-盖章版", autoName);

  console.log("\n[5] 填必填项并提交");
  const pid = await page.$eval('#modal [name="pid"]', (el) => el.options[1] ? el.options[1].value : "");
  if (pid) await page.selectOption('#modal [name="pid"]', pid);
  await page.fill('#modal [name="vendor"]', "某某会展服务有限公司");
  await page.fill('#modal [name="amount"]', "128000");
  await page.click('#modal [data-x="1"]');
  await page.waitForTimeout(4500);
  check("提交后弹窗关闭", !(await page.$("#modal.open")));
  const t1 = await toasts();
  check("提示含「原件已附上」", t1.some((t) => /原件已附上/.test(t)), JSON.stringify(t1).slice(0, 100));

  console.log("\n[6] 列表出现 PDF 原件入口");
  const pdfLink = await page.$('a.link[href^="/api/uploads/"]');
  check("有 PDF 原件链接", !!pdfLink);
  const href = pdfLink ? await pdfLink.getAttribute("href") : "";
  check("链接指向上传接口", /^\/api\/uploads\/[a-f0-9]{32}\.pdf$/.test(href || ""), href || "");
  if (href) {
    const r = await page.request.get(BASE + href);
    check("原件 HTTP 200", r.status() === 200, `status=${r.status()}`);
    const ct = r.headers()["content-type"];
    check("返回 application/pdf", ct === "application/pdf", ct || "");
    const buf = await r.body();
    check("字节数 > 0", buf.length > 0, `${buf.length} bytes`);
  }

  console.log("\n[7] 拍照件（图片）也能挂");
  await page.goto(`${BASE}/#/contracts`, { waitUntil: "networkidle" });
  await page.waitForTimeout(1500);
  await page.click("#newC");
  await page.waitForTimeout(600);
  await page.setInputFiles('#modal input[type="file"]', IMG_FILE);
  await page.waitForTimeout(1500);
  const pid2 = await page.$eval('#modal [name="pid"]', (el) => el.options[1] ? el.options[1].value : "");
  if (pid2) await page.selectOption('#modal [name="pid"]', pid2);
  await page.fill('#modal [name="vendor"]', "某某广告有限公司");
  await page.fill('#modal [name="amount"]', "8600");
  await page.click('#modal [data-x="1"]');
  await page.waitForTimeout(4500);
  check("图片合同提交成功", !(await page.$("#modal.open")));
  check("列表出现缩略图", (await page.$$("img.thumb")).length > 0);
  const thumbSrc = await page.getAttribute("img.thumb", "src").catch(() => "");
  if (thumbSrc) {
    const r = await page.request.get(BASE + thumbSrc);
    check("缩略图地址可访问", r.status() === 200 && r.headers()["content-type"] === "image/jpeg",
      `status=${r.status()} ct=${r.headers()["content-type"]}`);
  }

  console.log("\n[8] 不带原件仍可录合同");
  await page.click("#newC");
  await page.waitForTimeout(600);
  const pid3 = await page.$eval('#modal [name="pid"]', (el) => el.options[1] ? el.options[1].value : "");
  if (pid3) await page.selectOption('#modal [name="pid"]', pid3);
  await page.fill('#modal [name="name"]', "无附件合同");
  await page.fill('#modal [name="vendor"]', "某某科技");
  await page.fill('#modal [name="amount"]', "1000");
  await page.click('#modal [data-x="1"]');
  await page.waitForTimeout(3000);
  check("无附件也能保存", !(await page.$("#modal.open")));

  console.log("\n[9] 项目详情页合同页签");
  const firstProj = await page.getAttribute('a.link[data-go^="projects/"]', "data-go").catch(() => "");
  if (firstProj) {
    await page.goto(`${BASE}/#/${firstProj}`, { waitUntil: "networkidle" });
    await page.waitForTimeout(1500);
    const tab = await page.$('[data-tab="contracts"]');
    if (tab) {
      await tab.click();
      await page.waitForTimeout(1200);
      const th = (await page.textContent("#app table thead").catch(() => "")) || "";
      check("项目页合同表也有原件列", /原件/.test(th), th.replace(/\s+/g, " ").slice(0, 80));
    } else {
      check("项目页有合同页签", false, "未找到 contracts 页签");
    }
  }

  await page.screenshot({ path: `${TMP}/ui-contracts.png`, fullPage: true });

  console.log("\n[10] 控制台");
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
