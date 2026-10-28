"use strict";
/**
 * 已归档会议 PDF 资料卷宗。
 *
 * - 核销六步、例外、归档八类材料、会务需求、合同、付款、结算和审批都有独立章节。
 * - PDF/JPEG/PNG 原件转为 PDF 可见页面，并将每份原文件嵌入 PDF 附件区以便取证。
 * - GIF/WebP 与不可解析的 PDF 原件作为 PDF 内嵌附件保留，目录明示不能分页呈现。
 * - Cloudflare 无 R2 或只登记元数据时仍生成带缺失清单的 PDF，绝不伪称原件齐备。
 *
 * 核心报表用标准 PDF Type0 / UniGB-UCS2-H 字体生成中文文本；
 * 不依赖 Worker OS 字体，并在浏览器/常见 PDF 阅读器中可检索和打印。
 */
const { PDFDocument } = require("pdf-lib");
const { HttpError } = require("./util");

const MAX_FILE_COUNT = 60;
const MAX_FILE_BYTES = 8 * 1024 * 1024;
const MAX_TOTAL_BYTES = 32 * 1024 * 1024;
const MAX_PAGES = 250;
const PAGE_W = 595.28;
const PAGE_H = 841.89;

function display(v, empty = "—") {
  const s = String(v == null ? "" : v).replace(/[\u0000-\u001f\u007f]/g, " ").trim();
  return s || empty;
}
function amt(v) {
  const n = Number(v);
  return Number.isFinite(n) ? "¥" + n.toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : "—";
}
function wrap(s, max = 50) {
  const paragraphs = String(s).replace(/\r/g, "").split("\n");
  const rows = [];
  for (const paragraph of paragraphs) {
    if (!paragraph) { rows.push(""); continue; }
    let current = "", weight = 0;
    for (const ch of paragraph) {
      const w = /[\u0000-\u00ff]/.test(ch) ? 0.56 : 1;
      if (current && weight + w > max) { rows.push(current); current = ""; weight = 0; }
      current += ch;
      weight += w;
    }
    if (current) rows.push(current);
  }
  return rows;
}
function asHexCjk(s) {
  const le = Buffer.from(String(s), "utf16le");
  const be = Buffer.alloc(le.length);
  for (let i = 0; i < le.length; i += 2) { be[i] = le[i + 1]; be[i + 1] = le[i]; }
  return be.toString("hex").toUpperCase();
}
function pdfText(text, x, y, size = 10, rgb = "0.13 0.18 0.27") {
  return rgb + " rg BT /F1 " + size + " Tf 1 0 0 1 " +
    x.toFixed(2) + " " + y.toFixed(2) + " Tm <" + asHexCjk(text) + "> Tj ET\n";
}

/** 小体积 PDF 中文正文；所有动态文字以 UTF-16BE 十六进制编码，避免 PDF 注入。 */
function createReportPdf(lines, title) {
  const flat = [];
  for (const line of lines) {
    const max = line.kind === "title" ? 32 : 50;
    const parts = wrap(line.text, max);
    for (let i = 0; i < parts.length; i++) {
      flat.push({ text: parts[i], kind: i === 0 ? line.kind : "body" });
    }
  }
  const pages = [];
  let current = [], y = 779;
  for (const line of flat) {
    const h = line.kind === "title" ? 24 : line.kind === "section" ? 22 : 16;
    if (y - h < 67 && current.length) {
      pages.push(current); current = []; y = 779;
    }
    current.push({ text: line.text, kind: line.kind, y });
    y -= h;
  }
  if (current.length || pages.length === 0) pages.push(current);
  const objs = [null, null, null, null];
  const addObj = s => { objs.push(s); return objs.length; };
  const stream = s => {
    const content = Buffer.from(s, "ascii");
    return "<< /Length " + content.length + " >>\nstream\n" + s + "\nendstream";
  };
  const pageRefs = [];
  for (let i = 0; i < pages.length; i++) {
    let content = "0.97 0.98 1 rg 0 798 " + PAGE_W.toFixed(2) + " 43 re f\n";
    content += pdfText(display(title), 37, 812, 16, "0.08 0.20 0.38");
    content += "0.76 0.82 0.90 RG 36 58 523 0 l S\n";
    content += pdfText("内部归档 · 核销资料卷宗", 37, 40, 9, "0.42 0.47 0.55");
    content += pdfText("第 " + (i + 1) + " / " + pages.length + " 页", 476, 40, 9, "0.42 0.47 0.55");
    for (const line of pages[i]) {
      const section = line.kind === "section";
      const color = section ? "0.04 0.27 0.48" : line.kind === "title" ? "0.13 0.22 0.32" : "0.17 0.20 0.26";
      const size = line.kind === "title" ? 14 : section ? 12 : 10;
      content += pdfText(line.text, 38, line.y, size, color);
    }
    const sid = addObj(stream(content));
    const pid = addObj("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 " + PAGE_W +
      " " + PAGE_H + "] /Contents " + sid + " 0 R /Resources << /Font << /F1 3 0 R >> >> >>");
    pageRefs.push(pid + " 0 R");
  }
  objs[0] = "<< /Type /Catalog /Pages 2 0 R >>";
  objs[1] = "<< /Type /Pages /Count " + pageRefs.length + " /Kids [" + pageRefs.join(" ") + "] >>";
  objs[2] = "<< /Type /Font /Subtype /Type0 /BaseFont /STSong-Light /Encoding /UniGB-UCS2-H /DescendantFonts [4 0 R] >>";
  objs[3] = "<< /Type /Font /Subtype /CIDFontType0 /BaseFont /STSong-Light /CIDSystemInfo " +
    "<< /Registry (Adobe) /Ordering (GB1) /Supplement 4 >> /DW 1000 >>";
  const chunks = [Buffer.from("%PDF-1.4\n%\xE2\xE3\xCF\xD3\n", "latin1")];
  const offsets = [0];
  let size = chunks[0].length;
  for (let i = 0; i < objs.length; i++) {
    offsets.push(size);
    const c = Buffer.from((i + 1) + " 0 obj\n" + objs[i] + "\nendobj\n", "ascii");
    chunks.push(c); size += c.length;
  }
  const xrefStart = size;
  let xref = "xref\n0 " + (objs.length + 1) + "\n0000000000 65535 f \n";
  for (let i = 1; i < offsets.length; i++) {
    xref += String(offsets[i]).padStart(10, "0") + " 00000 n \n";
  }
  xref += "trailer\n<< /Size " + (objs.length + 1) + " /Root 1 0 R >>\nstartxref\n" + xrefStart + "\n%%EOF\n";
  chunks.push(Buffer.from(xref, "ascii"));
  return Buffer.concat(chunks);
}

function makeLines(d, sources) {
  const p = d.project, records = d;
  const lines = [];
  const title = "已归档会议核销资料 · " + display(p.id);
  const add = (text, kind = "body") => lines.push({ text: display(text, ""), kind });
  const section = text => { add(""); add(text, "section"); };
  const item = (key, value) => add("  " + key + "：" + display(value));
  const simpleRecords = (rows, map, absent) => {
    if (!rows || !rows.length) return add(absent || "  无记录");
    rows.forEach((r, i) => add("  " + (i + 1) + ". " + map(r)));
  };
  add("核销资料封存卷宗", "title");
  add("生成时间：" + new Date().toISOString().replace("T", " ").slice(0, 19) + " UTC");
  add("会议编号：" + p.id + "   资料来源：ERP 归档状态快照");
  add("提示：仅有登记信息的材料不会被虚构为原文件；缺失和无法转换项均单独列出。");
  section("一、会议概况");
  item("会议名称", p.name);
  item("所属协会", p.assoc);
  item("状态", p.status);
  item("会议时间", p.date + " · " + p.days + " 天");
  item("会议形式", p.form);
  item("负责人", p.owner);
  item("参会人数", p.people);
  item("项目预算", amt(p.budget));
  item("会议议程", p.agenda);
  item("归档日期", p.status_at);
  section("二、会后核销六步");
  simpleRecords(records.verifySteps, s => "第" + s.step_no + "步 " + s.name +
    "｜" + s.result + "｜判定人 " + display(s.checked_by) +
    "｜时间 " + display(s.checked_at) + "｜备注 " + display(s.remark), "  无核销判定记录");
  section("三、核销例外审批");
  simpleRecords(records.exceptions, e => e.id + " / 第" + e.step_no + "步 / " + e.status +
    " / 原因：" + e.reason + " / 审批人：" + display(e.approved_by) +
    " / 意见：" + display(e.comment), "  无例外单");
  section("四、八类归档材料及文件状态");
  add("  说明：以下列出全部材料登记记录；各原始文件的分页和内嵌情况详见附件目录。");
  simpleRecords(records.materials, m => "[" + m.kind + "] " + m.name +
    " / 版本 " + display(m.version) + " / 登记者 " + display(m.uploader) +
    " / 日期 " + display(m.created_at) + " / 文件 " +
    display(m.file_name || m.file_key, "仅登记，未上传原件"), "  无材料");
  section("五、会务需求与费用对照");
  if (records.demandSheet) {
    item("确认归档", records.demandSheet.confirmed ? "是" : "否");
    item("确认人/时间", display(records.demandSheet.confirmed_by) + " / " + display(records.demandSheet.confirmed_at));
  }
  simpleRecords(records.demandItems, r => "[" + r.grp + "] " + r.item +
    " / 需求：" + display(r.need) + " / 规格：" + display(r.spec) +
    " / 数量/说明：" + display(r.note) + " / 预算：" + display(r.budget), "  无需求明细");
  section("六、合同及签署资料");
  simpleRecords(records.contracts, c => c.id + " " + c.name +
    " / 签约方：" + c.vendor + " / 状态：" + c.status + " / 金额：" + amt(c.amount) +
    " / 原件：" + display(c.file_name || c.file_key, "仅登记，未上传原件"), "  无合同");
  section("七、付款及报销记录");
  simpleRecords(records.payments, y => y.id + " [" + y.type + "] " +
    y.payee + " / " + amt(y.amount) + " / 状态：" + y.status +
    " / 发票：" + display(y.invoice_no) + " / 付款时间：" + display(y.paid_at), "  无付款单");
  section("八、财务结算");
  if (records.settlement) {
    const s = records.settlement;
    item("结算单", s.id);
    item("预算口径收入", amt(s.income));
    item("已付款支出", amt(s.expense));
    item("结余", amt(s.profit));
    item("收款方", s.payee);
    item("开户行", s.payee_bank);
    item("结算状态", s.status);
    item("生成日期", s.created_at);
  } else add("  无结算单（归档项目应核查此异常）");
  section("九、关联审批单");
  simpleRecords(records.approvals, a => a.id + " [" + a.type + "] " + a.title +
    " / " + a.status + " / 申请：" + display(a.by_user) +
    " / 审批：" + display(a.decided_by) + " / 意见：" + display(a.comment), "  无关联审批记录");
  section("十、核销与归档操作留痕");
  simpleRecords(records.auditLogs, a => display(a.at) + " / " +
    display(a.user_name) + " / " + a.module + " / " + a.action +
    " / " + display(a.detail), "  无操作记录");
  section("十一、资料原件目录");
  add("  PDF 原件会追加为可见 PDF 页面；JPG/PNG 图片转换为 PDF 页面。");
  add("  其他图像类型或无法解析的文件作为 PDF 内嵌附件保留；并非可见页面。");
  add("  内嵌原件需使用支持附件面板的 PDF 阅读器打开。");
  if (!sources.length) add("  无上传的原文件；本卷宗只含业务记录文本。");
  for (let i = 0; i < sources.length; i++) {
    const a = sources[i];
    add("  " + (i + 1) + ". [" + a.group + "] " + a.label + " / " +
      display(a.file_name || a.file_key) + " / " + a.status);
  }
  const missing = sources.filter(a => a.status.includes("缺失") || a.status.includes("未配置") || a.status.includes("未上传")).length;
  add("  附件合计：" + sources.length + " 项；原件缺失/不可用：" + missing + " 项。");
  add("  注意：该 PDF 为下载时依据只读归档记录生成的文件；不改变归档状态或财务记录。");
  return { title, lines };
}
function mimetype(bytes, fallback) {
  if (bytes.length >= 5 && bytes.toString("latin1", 0, 5) === "%PDF-") return "application/pdf";
  if (bytes.length >= 8 && bytes.slice(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))) return "image/png";
  if (bytes.length >= 3 && bytes.slice(0, 3).equals(Buffer.from("ffd8ff", "hex"))) return "image/jpeg";
  if (bytes.length >= 6 && ["GIF87a", "GIF89a"].includes(bytes.toString("ascii", 0, 6))) return "image/gif";
  if (bytes.length >= 12 && bytes.toString("ascii", 0, 4) === "RIFF" &&
      bytes.toString("ascii", 8, 12) === "WEBP") return "image/webp";
  return fallback || "application/octet-stream";
}
function safeAttachmentName(name, index) {
  const file = display(name, "attachment").replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").slice(0, 85);
  return String(index + 1).padStart(2, "0") + "_" + file;
}

async function buildArchivePdf(data, store) {
  const sources = [
    ...(data.materials || []).map(m => ({ group: "材料", label: m.kind + " - " + m.name,
      file_key: m.file_key, file_name: m.file_name, file_mime: m.file_mime })),
    ...(data.contracts || []).map(c => ({ group: "合同", label: c.id + " " + c.name,
      file_key: c.file_key, file_name: c.file_name, file_mime: c.file_mime }))
  ];
  const withKeys = sources.filter(s => s.file_key);
  if (withKeys.length > MAX_FILE_COUNT) {
    throw new HttpError(413, "ARCHIVE_TOO_MANY_FILES", "归档资料包含超过 " + MAX_FILE_COUNT + " 个原件，需分批导出");
  }
  const { name: _, ...storeWithoutName } = store || {};
  const staged = await PDFDocument.create();
  let totalBytes = 0, stagedPages = 0;
  const originals = [];
  const seenKeys = new Set();
  for (const [i, source] of sources.entries()) {
    if (!source.file_key) { source.status = "仅登记，未上传原件"; continue; }
    if (seenKeys.has(source.file_key)) { source.status = "原件已在目录前项中收录"; continue; }
    seenKeys.add(source.file_key);
    let obj;
    try {
      obj = await storeWithoutName.get(source.file_key);
    } catch (e) {
      source.status = e && e.code === "STORAGE_UNAVAILABLE" ?
        "文件存储未配置，原件未能获取" : "原件读取失败：" + display(e.message, "错误");
      continue;
    }
    if (!obj || !obj.buffer) { source.status = "原件缺失（存储中未找到）"; continue; }
    const bytes = Buffer.from(obj.buffer);
    if (bytes.length > MAX_FILE_BYTES) {
      throw new HttpError(413, "ARCHIVE_FILE_TOO_LARGE", "原件 " + display(source.file_name) + " 超过 8 MB，请拆分后导出");
    }
    totalBytes += bytes.length;
    if (totalBytes > MAX_TOTAL_BYTES) {
      throw new HttpError(413, "ARCHIVE_TOO_LARGE", "原始附件总量超过 32 MB，请拆分后导出");
    }
    const type = mimetype(bytes, source.file_mime);
    originals.push({ bytes, type, name: safeAttachmentName(source.file_name || source.file_key, i), label: source.label });
    try {
      if (type === "application/pdf") {
        const input = await PDFDocument.load(bytes, { updateMetadata: false });
        const indices = input.getPageIndices();
        if (stagedPages + indices.length > MAX_PAGES) {
          throw new HttpError(413, "ARCHIVE_TOO_MANY_PAGES", "原件 PDF 页面超过 " + MAX_PAGES + " 页，请拆分导出");
        }
        const pages = await staged.copyPages(input, indices);
        for (const page of pages) staged.addPage(page);
        stagedPages += pages.length;
        source.status = "PDF 原件合并 " + pages.length + " 页，保留原件附件";
      } else if (type === "image/jpeg" || type === "image/png") {
        if (stagedPages >= MAX_PAGES) {
          throw new HttpError(413, "ARCHIVE_TOO_MANY_PAGES", "图片转 PDF 页面超过 " + MAX_PAGES + " 页");
        }
        const img = type === "image/png" ? await staged.embedPng(bytes) : await staged.embedJpg(bytes);
        const page = staged.addPage([PAGE_W, PAGE_H]);
        const scale = Math.min((PAGE_W - 70) / img.width, (PAGE_H - 110) / img.height, 1);
        const width = img.width * scale, height = img.height * scale;
        page.drawImage(img, { x: (PAGE_W - width) / 2, y: (PAGE_H - height) / 2, width, height });
        stagedPages++;
        source.status = "图片转换为 PDF 可见页，保留原件附件";
      } else {
        source.status = "作为 PDF 内嵌附件保留（该格式暂不生成可见页面）";
      }
    } catch (e) {
      if (e instanceof HttpError) throw e;
      source.status = "文件无法转换为可见页面；原件已作为 PDF 附件保留";
    }
  }
  const report = makeLines(data, sources);
  const dest = await PDFDocument.load(createReportPdf(report.lines, report.title), { updateMetadata: false });
  if (staged.getPageCount()) {
    const pages = await dest.copyPages(staged, staged.getPageIndices());
    for (const page of pages) dest.addPage(page);
  }
  for (const original of originals) {
    await dest.attach(original.bytes, original.name, {
      mimeType: original.type,
      description: "原始归档附件：" + original.label,
      creationDate: new Date()
    });
  }
  dest.setTitle(data.project.id + " 核销资料汇编");
  dest.setSubject("已归档会议资料、核销六步及原件");
  dest.setCreator("Association ERP");
  return Buffer.from(await dest.save({ useObjectStreams: false }));
}

module.exports = { buildArchivePdf, createReportPdf, makeLines };
