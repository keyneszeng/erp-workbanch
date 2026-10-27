/**
 * 一次性截图脚本：给老板看「合同详情」弹窗长什么样。
 * 不进测试集，跑完即弃。
 *
 * 做两件事：
 *   1. 本地起服务，用 Chrome 打印一份像样的合同 PDF（甲方乙方/金额/条款/红章），
 *      上传后挂到一份新合同上，再点「详情」截弹窗 —— 证明 PDF 真的内嵌在弹窗里；
 *   2. 到线上台账点开一份合同，截「尚未上传原件」空态 —— 说明线上现状。
 */
const { chromium } = require("playwright");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const PORT = 8796;
const BASE = `http://127.0.0.1:${PORT}`;
const DB = "/tmp/erp-shot/erp.db";
const UP = "/tmp/erp-shot/uploads";
const OUT = path.join(ROOT, "docs", "v1.2.14");
const LIVE = "https://erp.aibuild.work";

fs.mkdirSync(OUT, { recursive: true });
fs.mkdirSync("/tmp/erp-shot", { recursive: true });
for (const f of [DB, DB + "-wal", DB + "-shm"]) if (fs.existsSync(f)) fs.unlinkSync(f);
if (fs.existsSync(UP)) fs.rmSync(UP, { recursive: true, force: true });

const CONTRACT_HTML = `<!doctype html><html><head><meta charset="utf-8"><style>
  @page { size: A4; margin: 22mm 20mm; }
  body { font-family: "Songti SC", "SimSun", serif; color:#1b1b1b; font-size:12.5pt; line-height:2; }
  h1 { text-align:center; font-size:19pt; letter-spacing:6px; margin:0 0 6mm; }
  .no { text-align:center; font-size:10.5pt; color:#555; margin-bottom:10mm; }
  .party { margin:2mm 0; }
  p { margin:2.5mm 0; text-indent:2em; }
  .sig { margin-top:16mm; display:flex; justify-content:space-between; }
  .sig div { width:45%; }
  .seal { position:absolute; right:24mm; top:196mm; width:44mm; height:44mm; border:2.2pt solid #c0392b;
    border-radius:50%; color:#c0392b; display:flex; align-items:center; justify-content:center;
    text-align:center; font-size:9pt; line-height:1.5; transform:rotate(-9deg); opacity:.86; }
</style></head><body>
  <h1>会议服务合同</h1>
  <div class="no">合同编号：HT-2026-031　　签订地点：广州</div>
  <div class="party">甲方（委托方）：广东省某某行业协会</div>
  <div class="party">乙方（服务方）：广州某某会展服务有限公司</div>
  <p>根据《中华人民共和国民法典》及有关法律法规，甲乙双方本着平等自愿、诚实信用的原则，
     就甲方委托乙方承办「2026 年度行业年会」会场租赁及餐饮服务事宜，达成如下协议。</p>
  <p><b>第一条　服务内容</b>　乙方负责提供主会场（容纳 300 人）租赁、音响与投影设备调试、
     午宴 300 人（10 人／桌，含 2 道主食、6 道热菜、2 道凉菜、茶水），以及会场布置与撤场清运。</p>
  <p><b>第二条　服务时间</b>　2026 年 11 月 18 日 08:00 至 18:00，含布场与撤场时间。</p>
  <p><b>第三条　合同金额</b>　人民币壹拾贰万捌仟元整（¥128,000.00），含税、含场地、餐饮、设备及人工。</p>
  <p><b>第四条　付款方式</b>　合同签订后 5 个工作日内预付 40%（¥51,200.00）；
     活动结束并验收合格后 10 个工作日内付清余款 60%（¥76,800.00）。乙方须提供增值税专用发票。</p>
  <p><b>第五条　违约责任</b>　甲方逾期付款的，按日万分之五支付违约金；
     乙方未按约定提供服务或服务质量不符合约定的，应减免相应费用并赔偿由此造成的损失。</p>
  <p><b>第六条　其他</b>　本合同一式肆份，甲乙双方各执贰份，自双方签字盖章之日起生效。</p>
  <div class="sig">
    <div>甲方（盖章）：<br><br>授权代表：____________<br><br>日期：2026 年 10 月 20 日</div>
    <div>乙方（盖章）：<br><br>授权代表：____________<br><br>日期：2026 年 10 月 20 日</div>
  </div>
  <div class="seal">广州某某会展<br>服务有限公司<br>合同专用章</div>
</body></html>`;

async function waitHealth() {
  for (let i = 0; i < 100; i++) {
    try { const r = await fetch(`${BASE}/api/health`); if (r.ok) return; } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("服务启动超时");
}
async function loginApi(u) {
  const r = await fetch(`${BASE}/api/auth/login`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: u, password: "123456" })
  });
  if (r.status !== 200) throw new Error(`${u} 登录失败`);
  return r.headers.get("set-cookie").split(";")[0];
}

(async () => {
  const proc = spawn(process.execPath, ["--experimental-sqlite", "server/index.js"], {
    cwd: ROOT,
    env: { ...process.env, ERP_PORT: String(PORT), ERP_DB: DB, ERP_UPLOAD_DIR: UP },
    stdio: ["ignore", "pipe", "pipe"]
  });
  proc.stderr.on("data", (d) => {
    const s = d.toString();
    if (!s.includes("ExperimentalWarning") && !s.includes("trace-warnings")) process.stderr.write("[srv] " + s);
  });
  await waitHealth();

  const browser = await chromium.launch({ channel: "chrome", headless: true });

  // 1) 用 Chrome 打一份像样的合同 PDF
  const pdfPage = await browser.newPage();
  await pdfPage.setContent(CONTRACT_HTML, { waitUntil: "load" });
  const pdfBuf = await pdfPage.pdf({ format: "A4", printBackground: true });
  await pdfPage.close();
  console.log(`合同 PDF 生成：${pdfBuf.length} bytes`);

  // 2) 上传 + 挂到新合同上
  const ck = await loginApi("exec");
  const up = await fetch(`${BASE}/api/uploads`, {
    method: "POST",
    headers: { "Content-Type": "application/pdf", "x-file-name": encodeURIComponent("会场租赁及餐饮服务合同-盖章版.pdf"), cookie: ck },
    body: pdfBuf
  }).then((r) => r.json());

  const mk = await fetch(`${BASE}/api/contracts`, {
    method: "POST", headers: { "Content-Type": "application/json", cookie: ck },
    body: JSON.stringify({
      pid: "MP-2026-001", name: "会场租赁及餐饮服务合同", vendor: "广州某某会展服务有限公司",
      amount: 128000, status: "草稿", category: "场地餐饮",
      file_key: up.key, file_name: up.name, file_size: up.size, file_mime: up.mime
    })
  }).then((r) => r.json());
  const cid = mk.contract.id;
  console.log(`合同已建：${cid}`);

  // 3) 台账 → 详情 → 截图
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  await page.goto(BASE, { waitUntil: "networkidle" });
  await page.waitForTimeout(600);
  await page.fill('input[name="username"]', "exec");
  await page.fill('input[name="password"]', "123456");
  await page.click("#lbtn");
  await page.waitForTimeout(2200);

  await page.goto(`${BASE}/#/contracts`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1800);
  await page.screenshot({ path: path.join(OUT, "01-台账-详情列.png"), fullPage: true });

  await page.locator(`tr:has-text("${cid}") [data-cdet="${cid}"]`).first().click();
  await page.waitForTimeout(3500); // 等 PDF 首屏渲染
  await page.locator("#modal .mbox").screenshot({ path: path.join(OUT, "02-详情-内嵌合同原件.png") });
  console.log("本地截图完成");

  // 4) 线上空态
  const liveCtx = await browser.newContext({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 2 });
  const lp = await liveCtx.newPage();
  await lp.goto(LIVE, { waitUntil: "networkidle", timeout: 60000 });
  await lp.waitForTimeout(1200);
  await lp.fill('input[name="username"]', "assoc");
  await lp.fill('input[name="password"]', "123456");
  await lp.click("#lbtn");
  await lp.waitForTimeout(3000);
  await lp.goto(`${LIVE}/#/contracts`, { waitUntil: "domcontentloaded", timeout: 60000 });
  await lp.waitForTimeout(2500);
  await lp.screenshot({ path: path.join(OUT, "03-线上台账-详情列.png"), fullPage: true });
  await lp.locator("[data-cdet]").first().click();
  await lp.waitForTimeout(1500);
  await lp.locator("#modal .mbox").screenshot({ path: path.join(OUT, "04-线上详情-尚未上传原件.png") });
  console.log("线上截图完成");

  await browser.close();
  proc.kill("SIGTERM");
  console.log("done");
})().catch((e) => { console.error("失败：", e); process.exit(1); });
