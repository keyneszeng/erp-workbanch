/**
 * 合同详情弹窗（原件预览）—— UI 定点验证（真实 Chrome）
 * 运行：node test/ui/contract-detail.js
 *
 * 老板 2026-10-27 提的：合同台账「原件」列只有一个「PDF」二字或 40px 缩略图，
 * 点开是新窗口里的裸文件，要核对条款还得自己把上下文对一遍。他要「详情」键，
 * 点开直接看原件，顺便把下一步动作做掉。
 *
 * 这里验四件事在**页面上**成立：
 *   1. 台账与项目详情的原件列都有「详情」，点开是同一个弹窗；
 *   2. PDF 内嵌预览（iframe 指向 /api/uploads/，且真的能取到 application/pdf）；
 *   3. 图片直接铺开；没有原件的说清楚没有，而不是空白；
 *   4. 弹窗底部能直接流转（草稿 → 提交签署 → 待签署），不用关掉回列表找按钮。
 *
 * 脚本自带服务，不依赖外部进程（设 ERP_BASE 可指向已有服务）。
 */
const { chromium } = require("playwright");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..", "..");
const PORT = Number(process.env.ERP_PORT || 8831);
const BASE = process.env.ERP_BASE || `http://127.0.0.1:${PORT}`;
const SELF_HOSTED = !process.env.ERP_BASE;
const DB = path.join(ROOT, "data", "ui-cdet.db");
const UP = path.join(ROOT, "data", "ui-cdet-uploads");

const PID = "MP-2026-001"; // 筹备中，exec 是成员，合同未封存
const TAG = Date.now().toString().slice(-6);

let pass = 0, fail = 0;
const check = (name, ok, extra = "") => {
  if (ok) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}  ${extra}`); }
};

// 能被服务端文件头嗅探认出来的最小样本
const PDF_BUF = Buffer.from(
  "%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n"
);
const PNG_BUF = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64"
);

function clean() {
  for (const f of [DB, DB + "-wal", DB + "-shm"]) if (fs.existsSync(f)) fs.unlinkSync(f);
  if (fs.existsSync(UP)) fs.rmSync(UP, { recursive: true, force: true });
}
async function waitHealth(timeout = 30000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    try { const r = await fetch(`${BASE}/api/health`); if (r.ok) return; } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("服务启动超时");
}
async function loginApi(username) {
  const r = await fetch(`${BASE}/api/auth/login`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password: "123456" })
  });
  if (r.status !== 200) throw new Error(`${username} 登录失败`);
  return r.headers.get("set-cookie").split(";")[0];
}
async function apiCall(cookie, method, url, body) {
  const r = await fetch(BASE + url, {
    method, headers: { "Content-Type": "application/json", cookie },
    body: body ? JSON.stringify(body) : undefined
  });
  const t = await r.text();
  let d = null; try { d = JSON.parse(t); } catch { d = t; }
  return { status: r.status, data: d };
}
async function upload(cookie, buf, mime, name) {
  const r = await fetch(`${BASE}/api/uploads`, {
    method: "POST",
    headers: { "Content-Type": mime, "x-file-name": encodeURIComponent(name), cookie },
    body: buf
  });
  const d = await r.json();
  if (r.status !== 200) throw new Error(`上传失败：${JSON.stringify(d)}`);
  return d;
}

let proc = null;

async function openAs(browser, username) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  const errs = [];
  page.on("pageerror", (e) => errs.push(`[pageerror] ${e.message}`));
  page.on("console", (m) => {
    const t = m.text();
    if (m.type() === "error" && !/Failed to load resource/.test(t)) errs.push(t);
  });
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
  await page.goto(BASE, { waitUntil: "networkidle" });
  await page.waitForTimeout(700);
  for (let i = 0; i < 3; i++) {
    await page.fill('input[name="username"]', username);
    await page.fill('input[name="password"]', "123456");
    if ((await page.inputValue('input[name="username"]')) === username) break;
    await page.waitForTimeout(300);
  }
  await page.click("#lbtn");
  await page.waitForTimeout(2200);
  return { ctx, page, errs };
}

/** 打开台账，按合同编号找那一行的「详情」按钮 */
async function openDetailFromLedger(page, cid) {
  // 不用 networkidle：详情弹窗里的 PDF iframe 会一直占着连接，networkidle 等不到
  await page.goto(`${BASE}/#/contracts`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1800);
  const btn = page.locator(`tr:has-text("${cid}") [data-cdet="${cid}"]`).first();
  if (!(await btn.count())) return false;
  await btn.click();
  await page.waitForTimeout(900);
  return true;
}

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

  /* ---------- 造数据：PDF 合同 / 图片合同 / 无原件合同 ---------- */
  const execCk = await loginApi("exec");
  const pdf = await upload(execCk, PDF_BUF, "application/pdf", `盖章扫描件-${TAG}.pdf`);
  const png = await upload(execCk, PNG_BUF, "image/png", `手机拍照件-${TAG}.png`);

  const mk = async (name, meta) => {
    const r = await apiCall(execCk, "POST", "/api/contracts", {
      pid: PID, name, vendor: "详情弹窗测试供应商", amount: 10000, status: "草稿", ...meta
    });
    if (r.status !== 200) throw new Error(`建合同失败：${JSON.stringify(r.data)}`);
    return r.data.contract.id;
  };
  const cidPdf = await mk(`详情验证-PDF原件-${TAG}`, {
    file_key: pdf.key, file_name: pdf.name, file_size: pdf.size, file_mime: pdf.mime
  });
  const cidImg = await mk(`详情验证-图片原件-${TAG}`, {
    file_key: png.key, file_name: png.name, file_size: png.size, file_mime: png.mime
  });
  const cidNone = await mk(`详情验证-无原件-${TAG}`, {});

  const browser = await chromium.launch({ channel: "chrome", headless: true });
  const allErrs = [];
  const closeAll = [];
  const sess = async (u) => { const s = await openAs(browser, u); closeAll.push(s.ctx); allErrs.push(...s.errs); return s; };

  /* ---------- 一、台账：原件列有「详情」 ---------- */
  console.log("\n[1] 合同台账的原件列");
  const exec1 = await sess("exec");
  await exec1.page.goto(`${BASE}/#/contracts`, { waitUntil: "domcontentloaded" });
  await exec1.page.waitForTimeout(1800);
  const cdetCount = await exec1.page.locator("[data-cdet]").count();
  check("每行原件列都有「详情」按钮", cdetCount >= 3, `实际 ${cdetCount}`);
  const rowTxt = (await exec1.page.textContent(`tr:has-text("${cidPdf}")`)) || "";
  check("详情旁边标出原件类型（PDF）", /详情\s*PDF/.test(rowTxt.replace(/\s+/g, " ")), rowTxt.slice(0, 120));
  const rowNone = (await exec1.page.textContent(`tr:has-text("${cidNone}")`)) || "";
  check("无原件的行标「无原件」", /无原件/.test(rowNone), rowNone.slice(0, 120));

  /* ---------- 二、PDF 详情：内嵌预览 ---------- */
  console.log("\n[2] PDF 合同的详情弹窗");
  check("能点开详情", await openDetailFromLedger(exec1.page, cidPdf));
  const title = (await exec1.page.textContent("#modal .mh")) || "";
  check("弹窗标题带合同编号", title.includes(cidPdf), title);
  const body = (await exec1.page.textContent("#modal .mb")) || "";
  check("显示合同名称", body.includes(`详情验证-PDF原件-${TAG}`), body.slice(0, 200));
  check("显示所属项目", /华东医学会年会/.test(body));
  check("显示签约方", /详情弹窗测试供应商/.test(body));
  check("显示金额", /¥10,000/.test(body));
  check("显示类别", /其他|场地餐饮|劳务专家|物料搭建|设备技术/.test(body));
  check("显示录入人", /录入/.test(body));

  const iframeSrc = await exec1.page.getAttribute("#modal iframe.cdpdf", "src");
  check("PDF 用 iframe 内嵌", !!iframeSrc && iframeSrc.includes("/api/uploads/"), iframeSrc || "无 iframe");
  check("有「新窗口打开」兜底", /新窗口打开/.test(body));

  // iframe 真的能取到 PDF（否则弹窗里是一片空白，比没有更糟）
  if (iframeSrc) {
    const r = await exec1.page.request.get(`${BASE}${iframeSrc.split("#")[0]}`);
    const ct = r.headers()["content-type"] || "";
    check("原件可访问且是 PDF", r.status() === 200 && /application\/pdf/.test(ct), `${r.status()} ${ct}`);
  }
  check("底部有「提交签署」", /提交签署/.test((await exec1.page.textContent("#modal .mf")) || ""));
  await exec1.page.click('#modal [data-x="0"]');
  await exec1.page.waitForTimeout(500);

  /* ---------- 三、图片详情：直接铺开 ---------- */
  console.log("\n[3] 图片合同的详情弹窗");
  check("能点开详情", await openDetailFromLedger(exec1.page, cidImg));
  const imgSrc = await exec1.page.getAttribute("#modal img.cdimg", "src");
  check("图片用 img 铺开", !!imgSrc && imgSrc.includes("/api/uploads/"), imgSrc || "无 img");
  check("图片有实际尺寸", await exec1.page.evaluate(() => {
    const el = document.querySelector("#modal img.cdimg");
    return !!el && el.naturalWidth > 0;
  }));
  await exec1.page.click('#modal [data-x="0"]');
  await exec1.page.waitForTimeout(500);

  /* ---------- 四、无原件：说清楚，不空白 ---------- */
  console.log("\n[4] 无原件合同的详情弹窗");
  check("能点开详情", await openDetailFromLedger(exec1.page, cidNone));
  const bodyNone = (await exec1.page.textContent("#modal .mb")) || "";
  check("明确提示尚未上传原件", /合同原件[\s\S]{0,12}尚未上传/.test(bodyNone), bodyNone.slice(0, 240));
  check("没有 iframe / img 假占位", (await exec1.page.locator("#modal iframe, #modal img.cdimg").count()) === 0);
  await exec1.page.click('#modal [data-x="0"]');
  await exec1.page.waitForTimeout(500);

  /* ---------- 五、项目详情里的同一套弹窗 ---------- */
  console.log("\n[5] 项目详情 → 合同页签");
  await exec1.page.goto(`${BASE}/#/projects/${PID}`, { waitUntil: "domcontentloaded" });
  await exec1.page.waitForTimeout(1800);
  await exec1.page.click('[data-tab="contracts"]');
  await exec1.page.waitForTimeout(900);
  const tabCdet = exec1.page.locator(`[data-cdet="${cidPdf}"]`).first();
  check("项目详情合同页签也有「详情」", (await tabCdet.count()) > 0);
  await tabCdet.click();
  await exec1.page.waitForTimeout(900);
  const tabTitle = (await exec1.page.textContent("#modal .mh")) || "";
  check("打开的是同一个弹窗", tabTitle.includes(cidPdf), tabTitle);
  const tabBody = (await exec1.page.textContent("#modal .mb")) || "";
  check("项目名取自当前项目（不是空）", /华东医学会年会/.test(tabBody), tabBody.slice(0, 200));
  check("项目详情里也有原件预览", (await exec1.page.locator("#modal iframe.cdpdf").count()) === 1);

  /* ---------- 六、弹窗里直接流转 ---------- */
  console.log("\n[6] 在弹窗里把下一步做掉");
  const flowBtn = exec1.page.locator('#modal [data-x="1"]');
  check("草稿合同底部有「提交签署」", (await flowBtn.count()) === 1 && /提交签署/.test(await flowBtn.textContent()));
  await flowBtn.click();
  await exec1.page.waitForTimeout(2200);
  const t6 = await exec1.page.evaluate(() => window.__toasts || []);
  check("流转成功提示", t6.some((t) => /提交签署|待签署/.test(t)), JSON.stringify(t6).slice(0, 200));
  check("弹窗已关闭", !(await exec1.page.isVisible("#modal .mbox")));

  const after = await apiCall(execCk, "GET", `/api/contracts?pid=${PID}`);
  const row = (after.data.rows || []).find((x) => x.id === cidPdf);
  check("接口里状态已变「待签署」", row && row.status === "待签署", row ? row.status : "查不到");

  await exec1.page.waitForTimeout(600);
  const reopened = await openDetailFromLedger(exec1.page, cidPdf);
  check("重开详情仍是「待签署」", reopened && /待签署/.test((await exec1.page.textContent("#modal .mb")) || ""));
  check("执行角色看到「待协会确认」而不是可点按钮",
    (await exec1.page.locator('#modal [data-x="1"]').count()) === 0 &&
    /待协会管理员确认签署/.test((await exec1.page.textContent("#modal .mb")) || ""));
  await exec1.page.click('#modal [data-x="0"]');
  await exec1.page.waitForTimeout(400);

  /* ---------- 七、协会确认签署 ---------- */
  console.log("\n[7] 协会管理员在弹窗里确认签署");
  const assoc = await sess("assoc");
  const okOpen = await openDetailFromLedger(assoc.page, cidPdf);
  check("协会能打开该合同详情", okOpen);
  const signBtn = assoc.page.locator('#modal [data-x="1"]');
  check("待签署合同底部有「确认签署」", (await signBtn.count()) === 1 && /确认签署/.test(await signBtn.textContent()));
  await signBtn.click();
  await assoc.page.waitForTimeout(600);
  const barTxt = (await assoc.page.textContent("#modal .mf")) || "";
  check("底部切换成行内二次确认", /签署日期记为今天/.test(barTxt) && /确认签署/.test(barTxt), barTxt);
  check("确认时详情内容还在（没被覆盖）", (await assoc.page.locator("#modal iframe.cdpdf").count()) === 1);
  // 先点取消，验证能退回详情而不是把弹窗关掉
  await assoc.page.click('#modal [data-back="1"]');
  await assoc.page.waitForTimeout(400);
  check("点取消退回详情，原件还在", (await assoc.page.locator("#modal iframe.cdpdf").count()) === 1 &&
    /确认签署/.test((await assoc.page.textContent("#modal .mf")) || ""));
  await assoc.page.click('#modal [data-x="1"]');
  await assoc.page.waitForTimeout(500);
  await assoc.page.click('#modal [data-ok="1"]');
  await assoc.page.waitForTimeout(2200);
  const t7 = await assoc.page.evaluate(() => window.__toasts || []);
  check("确认签署成功提示", t7.some((t) => /签署/.test(t)), JSON.stringify(t7).slice(0, 200));
  const after2 = await apiCall(execCk, "GET", `/api/contracts?pid=${PID}`);
  const row2 = (after2.data.rows || []).find((x) => x.id === cidPdf);
  check("状态已变「已签署」且带签署日期", row2 && row2.status === "已签署" && !!row2.sign_date,
    row2 ? `${row2.status} / ${row2.sign_date}` : "查不到");

  /* ---------- 八、零报错 ---------- */
  console.log("\n[8] 页面错误");
  check("无 JS 报错", allErrs.length === 0, allErrs.slice(0, 3).join(" | "));

  for (const c of closeAll) await c.close();
  await browser.close();
  if (proc) { proc.kill("SIGTERM"); proc = null; }

  console.log(`\n=== ${pass} 通过 / ${fail} 失败 ===`);
  process.exit(fail ? 1 : 0);
})().catch(async (e) => {
  console.error("脚本异常：", e);
  if (proc) proc.kill("SIGTERM");
  process.exit(1);
});
