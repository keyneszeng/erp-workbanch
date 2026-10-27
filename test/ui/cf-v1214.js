/**
 * V1.2.14 线上验证：合同台账「详情」入口 + 原件内嵌（**只读**，不改生产数据）
 * 运行：node test/ui/cf-v1214.js
 *
 * 只验老板要的那个键在真实环境里成立，不点任何流转按钮、不提交任何东西：
 *   1. 台账「原件」列是「详情」按钮 + 类型标签（PDF / 图片 / 无原件），不再是裸文件链接
 *   2. 点开弹窗：合同信息、原件、下一步动作同屏
 *   3. 有原件的合同，PDF 内嵌 iframe / 图片铺开，且原件地址真能取到（200 + 正确 content-type）
 *   4. 没有原件的合同明说「尚未上传原件」，不留白
 *   5. 项目详情页合同页签走的是同一个弹窗（口径不分叉）
 */
const { chromium } = require("playwright");

const BASE = process.env.ERP_BASE || "https://erp.aibuild.work";

let pass = 0, fail = 0;
const check = (name, ok, extra = "") => {
  if (ok) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}  ${extra}`); }
};

async function openAs(browser, username) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  const errs = [];
  page.on("pageerror", (e) => errs.push(`[pageerror] ${e.message}`));
  page.on("console", (m) => {
    const t = m.text();
    if (m.type() === "error" && !/Failed to load resource/.test(t)) errs.push(t);
  });
  await page.goto(BASE, { waitUntil: "networkidle", timeout: 60000 });
  await page.waitForTimeout(1500);
  for (let i = 0; i < 4; i++) {
    await page.fill('input[name="username"]', username);
    await page.fill('input[name="password"]', "123456");
    if ((await page.inputValue('input[name="username"]')) === username) break;
    await page.waitForTimeout(400);
  }
  await page.click("#lbtn");
  await page.waitForTimeout(3000);
  return { ctx, page, errs };
}

/** 关弹窗 —— 必须走 closeModal 同款动作：只摘类会让 PDF iframe 在后台继续加载 */
async function closeModal(page) {
  await page.evaluate(() => {
    const m = document.getElementById("modal");
    if (!m) return;
    const btn = m.querySelector('[data-x="0"]');
    if (btn) btn.click();
    m.classList.remove("open");
    m.innerHTML = "";
  });
  await page.waitForTimeout(400);
}

/** 跳路由：先清弹窗，再 domcontentloaded —— 详情里挂着 PDF iframe 时 networkidle 等不到 */
async function goHash(page, hash) {
  await closeModal(page);
  await page.goto(`${BASE}/${hash}`, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForTimeout(2200);
}

(async () => {
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  const allErrs = [];
  const closeAll = [];
  const sess = async (u) => { const s = await openAs(browser, u); closeAll.push(s.ctx); allErrs.push(...s.errs); return s; };

  console.log("\n[1] 合同台账：原件列改成「详情」入口");
  const assoc = await sess("assoc");
  await goHash(assoc.page, "#/contracts");

  const rows = assoc.page.locator("#content tbody tr");
  const rowCount = await rows.count();
  check("台账有合同行", rowCount > 0, `行数 ${rowCount}`);

  const detBtns = assoc.page.locator("#content [data-cdet]");
  const detCount = await detBtns.count();
  check("每行都有「详情」按钮", detCount === rowCount, `详情 ${detCount} / 行 ${rowCount}`);

  const btnTexts = await detBtns.allTextContents();
  check("详情按钮带原件类型标签", btnTexts.every((t) => /PDF|图片|无原件/.test(t)),
    JSON.stringify(btnTexts.slice(0, 4)));
  const noFile = btnTexts.filter((t) => /无原件/.test(t)).length;
  const hasFile = btnTexts.filter((t) => /PDF|图片/.test(t)).length;
  console.log(`      （有原件 ${hasFile} 份 / 无原件 ${noFile} 份）`);

  console.log("\n[2] 点开「详情」：合同信息 + 原件 + 下一步动作同屏");
  // 优先挑一份有原件的，验内嵌预览；没有就退回第一行验「尚未上传」
  let idx = btnTexts.findIndex((t) => /PDF|图片/.test(t));
  if (idx < 0) idx = 0;
  await detBtns.nth(idx).click();
  await assoc.page.waitForTimeout(1500);

  const title = (await assoc.page.textContent("#modal .mh")) || "";
  check("弹窗标题是「合同详情 · 编号」", /合同详情\s*·\s*HT-/.test(title), title.trim());

  const top = (await assoc.page.textContent("#modal .cdtop")) || "";
  check("顶部给出编号 / 名称 / 类别 / 状态", top.trim().length > 0 && /HT-/.test(top), top.trim().slice(0, 90));

  const grid = (await assoc.page.textContent("#modal .cdgrid")) || "";
  check("基本信息含所属项目 / 签约方 / 金额", /所属项目/.test(grid) && /签约方/.test(grid) && /合同金额/.test(grid),
    grid.replace(/\s+/g, " ").slice(0, 120));
  check("金额用 ¥ 展示", /¥/.test(grid), grid.replace(/\s+/g, " ").slice(0, 80));

  const foot = (await assoc.page.textContent("#modal .mf")) || "";
  check("底部有关闭键", /关闭/.test(foot), foot.trim());

  // 下一步动作必须跟状态对得上：已签署不该有按钮，草稿/待签署要么有按钮、要么说清为什么点不了。
  // 只读验证不点它 —— 点了就改生产数据了。
  const st = /草稿|待签署|已签署/.exec(top)?.[0] || "";
  const hasAct = !!(await assoc.page.$('#modal .mf .btn-p'));
  const gate = (await assoc.page.textContent("#modal .cdgate").catch(() => "")) || "";
  if (st === "已签署") {
    check("已签署合同不给流转按钮", !hasAct, foot.trim());
  } else if (st === "草稿" || st === "待签署") {
    check(`${st}合同给下一步动作或说明原因`, hasAct || /需要|待协会/.test(gate), `act=${hasAct} gate=${gate.trim().slice(0, 40)}`);
  } else {
    console.log(`      （状态未识别：${st || "空"}，跳过动作一致性）`);
  }

  console.log("\n[3] 原件在弹窗里能直接看");
  const pdfSrc = await assoc.page.getAttribute("#modal iframe.cdpdf", "src").catch(() => null);
  const imgSrc = await assoc.page.getAttribute("#modal img.cdimg", "src").catch(() => null);
  const fileBody = (await assoc.page.textContent("#modal .cdfile")) || "";

  if (pdfSrc) {
    check("PDF 内嵌在弹窗里（不是新窗口裸文件）", /^\/api\/uploads\/[a-f0-9]{32}\.pdf/.test(String(pdfSrc).split("#")[0]), pdfSrc);
    check("原件区有「新窗口打开」兜底", /新窗口打开/.test(fileBody), fileBody.replace(/\s+/g, " ").slice(0, 80));
    const r = await assoc.page.request.get(BASE + String(pdfSrc).split("#")[0]);
    check("原件地址 HTTP 200", r.status() === 200, `status=${r.status()}`);
    check("返回 application/pdf", r.headers()["content-type"] === "application/pdf", r.headers()["content-type"] || "");
    const buf = await r.body();
    check("原件字节数 > 0", buf.length > 0, `${buf.length} bytes`);
  } else if (imgSrc) {
    check("图片直接铺开在弹窗里", /^\/api\/uploads\//.test(imgSrc), imgSrc);
    check("原件区有「新窗口打开」兜底", /新窗口打开/.test(fileBody), fileBody.replace(/\s+/g, " ").slice(0, 80));
    check("图片有实际尺寸", await assoc.page.evaluate(() => {
      const el = document.querySelector("#modal img.cdimg");
      return !!el && el.naturalWidth > 0;
    }));
    const r = await assoc.page.request.get(BASE + imgSrc);
    check("图片地址可访问", r.status() === 200 && /image\//.test(r.headers()["content-type"] || ""),
      `status=${r.status()} ct=${r.headers()["content-type"]}`);
  } else {
    check("无原件时明说「尚未上传」", /合同原件[\s\S]{0,12}尚未上传/.test(fileBody), fileBody.replace(/\s+/g, " ").slice(0, 120));
    check("无原件时不留空白占位", /cdfile-empty/.test(await assoc.page.innerHTML("#modal .cdfile")), "缺少空态说明");
    // 没有原件时不该出现「新窗口打开」—— 没东西可开，给了才是误导
    check("无原件时不放「新窗口打开」", !/新窗口打开/.test(fileBody), fileBody.replace(/\s+/g, " ").slice(0, 80));
  }
  await closeModal(assoc.page);

  console.log("\n[4] 无原件的合同也说得清楚");
  const noIdx = btnTexts.findIndex((t) => /无原件/.test(t));
  if (noIdx >= 0) {
    await assoc.page.locator("#content [data-cdet]").nth(noIdx).click();
    await assoc.page.waitForTimeout(1200);
    const b = (await assoc.page.textContent("#modal .cdfile")) || "";
    check("「无原件」行点开明确提示尚未上传", /合同原件[\s\S]{0,12}尚未上传/.test(b), b.replace(/\s+/g, " ").slice(0, 120));
    check("没有 iframe / img 假占位",
      (await assoc.page.$("#modal iframe.cdpdf")) === null && (await assoc.page.$("#modal img.cdimg")) === null);
    await closeModal(assoc.page);
  } else {
    console.log("      （线上没有「无原件」合同，跳过）");
  }

  console.log("\n[5] 项目详情页合同页签走同一个弹窗");
  const firstPid = await assoc.page.getAttribute('a.link[data-go^="projects/"]', "data-go").catch(() => "");
  check("台账能拿到项目入口", !!firstPid, firstPid || "");
  if (firstPid) {
    const pid = String(firstPid).replace("projects/", "");
    await goHash(assoc.page, `#/projects/${pid}`);
    const tab = await assoc.page.$('[data-tab="contracts"]');
    check("项目详情有合同页签", !!tab);
    if (tab) {
      await tab.click();
      await assoc.page.waitForTimeout(1500);
      const projDet = assoc.page.locator("#tabbody [data-cdet]");
      const n = await projDet.count();
      check("项目页合同也有「详情」入口", n > 0, `入口数 ${n}`);
      if (n > 0) {
        await projDet.first().click();
        await assoc.page.waitForTimeout(1200);
        const t2 = (await assoc.page.textContent("#modal .mh")) || "";
        check("项目页点开是同一个合同详情弹窗", /合同详情\s*·\s*HT-/.test(t2), t2.trim());
        check("弹窗里同样有原件区", !!(await assoc.page.$("#modal .cdfile")));
        await closeModal(assoc.page);
      }
    }
  }

  console.log("\n[6] 页面错误");
  check("无 JS 报错", allErrs.length === 0, allErrs.slice(0, 3).join(" | "));

  for (const c of closeAll) await c.close();
  await browser.close();
  console.log(`\n=== ${pass} 通过 / ${fail} 失败 ===`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error("脚本异常：", e);
  process.exit(1);
});
