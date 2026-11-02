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
const { VERIFY_STEPS } = require("./constants");

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
function createReportPdf(lines, title, { footer = "核销六步核验记录" } = {}) {
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
    const h = line.kind === "title" ? 24 : line.kind === "section" ? 22 : line.kind === "sub" ? 20 : 16;
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
    content += pdfText(footer, 37, 40, 9, "0.42 0.47 0.55");
    content += pdfText("第 " + (i + 1) + " / " + pages.length + " 页", 476, 40, 9, "0.42 0.47 0.55");
    for (const line of pages[i]) {
      const section = line.kind === "section";
      const color = section ? "0.04 0.27 0.48" : line.kind === "title" ? "0.13 0.22 0.32"
      : line.kind === "sub" ? "0.10 0.26 0.42" : "0.17 0.20 0.26";
      const size = line.kind === "title" ? 14 : section ? 12 : line.kind === "sub" ? 11 : 10;
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

/** 把每步的结构化核验结果翻译成可读条目（evidence_json 里的字段名对人不友好） */
function evidenceLines(no, e) {
  if (!e || typeof e !== "object") return [];
  const out = [];
  const push = (k, v) => { if (v !== undefined && v !== null && v !== "") out.push("    · " + k + "：" + v); };
  switch (no) {
    case 1:
      push("关联原件", (e.materials || []).join("、") || "立项文件、终版议程");
      push("盖章确认", e.stamped ? "已盖章" : "未确认");
      push("终版确认", e.final ? "终版" : "未确认");
      push("比对字段", e.fieldsMatched ? e.fieldsMatched + " 项一致（会议名 / 日期 / 主办方 / 招商主体）" : "");
      break;
    case 2:
      push("名单一致人数", e.matchedPeople ? e.matchedPeople + " 人（终版议程 ∩ 劳务收集表 ∩ 劳务协议）" : "");
      push("无冒领漏发", e.noOmissions ? "已确认" : "未确认");
      break;
    case 3:
      push("会议形式", e.format);
      push("有效在线时长", e.onlineMinutes != null ? e.onlineMinutes + " 分钟" : "不适用");
      push("线下签到", e.signedAttendance ? "已核验" : "不适用");
      break;
    case 4:
      push("课题匹配数", e.matchedTopics ? e.matchedTopics + " 个（课件 ∩ 终版议程）" : "");
      push("串场题目一致", e.hostTitleMatches ? "是" : "否");
      push("主办方名称/logo 一致", e.hostNameLogoMatches ? "是" : "否");
      push("药企 logo 出现页", (e.sponsorLogoPages || []).join("、") || "无");
      break;
    case 5:
      push("劳务记录", e.matchedLaborRecords ? e.matchedLaborRecords + " 条" : "");
      push("比对字段", e.matchedFields ? e.matchedFields + " 项（姓名 / 时间 / 角色 / 金额 / 银行账号）" : "");
      push("劳务/专家类合同", e.laborContracts != null ? e.laborContracts + " 份（已签署）" : "");
      push("账号是否入库", e.accountDataStored ? "是" : "否（仅内存比对）");
      break;
    case 6:
      push("拟请款总额", e.draftAmount != null ? amt(e.draftAmount) : "");
      push("发票总额", e.invoiceAmount != null ? amt(e.invoiceAmount) : "");
      push("免票劳务金额", e.nonInvoiceLaborAmount != null ? amt(e.nonInvoiceLaborAmount) : "");
      push("会议信息一致", e.meetingMatched ? "是" : "否");
      break;
  }
  return out;
}

/**
 * 只生成核销六步这一份记录。
 * 会议概况、材料清单、合同、付款、结算、审批、留痕等章节都不再进 PDF ——
 * 这份文件的用途是「核销判定依据」，别的数据各自有页面可查。
 */
function makeLines(d) {
  const p = d.project, records = d;
  const lines = [];
  const title = "核销六步核验记录 · " + display(p.id);
  const add = (text, kind = "body") => lines.push({ text: display(text, ""), kind });
  const section = text => { add(""); add(text, "section"); };
  add("核销六步核验记录", "title");
  add("会议编号：" + p.id + "　会议名称：" + display(p.name));
  add("会议时间：" + display(p.date) + "　所属协会：" + display(p.assoc));
  add("归档日期：" + display(p.status_at) + "　生成时间：" +
    new Date().toISOString().replace("T", " ").slice(0, 19) + " UTC");
  section("核销六步");
  const matsOf = (def) => {
    const kinds = [...(def.materials || []), ...(def.altMaterials || [])];
    return (records.materials || []).filter(m => kinds.includes(m.kind) && !m.deleted_at);
  };
  for (const def of VERIFY_STEPS) {
    const row = (records.verifySteps || []).find(x => Number(x.step_no) === def.no);
    add("第 " + def.no + " 步 · " + def.name + "　【" + (row ? row.result : "待判定") + "】", "sub");
    add("  核对要点：" + def.desc);
    if (row) {
      add("  判定人：" + display(row.checked_by) + "　判定时间：" + display(row.checked_at));
      if (row.remark) add("  问题描述：" + row.remark);
      let ev = null;
      try { ev = row.evidence_json ? JSON.parse(row.evidence_json) : null; } catch { ev = null; }
      const lines2 = evidenceLines(def.no, ev);
      if (lines2.length) { add("  结构化核验结果："); lines2.forEach(l => add(l)); }
      else add("  结构化核验结果：无（历史记录或仅标记通过，未见结构化依据）");
    } else {
      add("  判定记录：无");
    }
    const mats = matsOf(def);
    add("  关联原件：" + (mats.length
      ? mats.map(m => "[" + m.kind + "] " + (m.file_name || m.name || "仅登记")).join("；")
      : "未登记"));
    add("");
  }
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

async function buildArchivePdf(data) {
  // 只出核销六步记录，不再合并原件页/挂附件：
  // 老板要求「只要核销 6 项内容」，原件本身在材料中心随时可看。
  const report = makeLines(data);
  const dest = await PDFDocument.load(createReportPdf(report.lines, report.title), { updateMetadata: false });
  dest.setTitle(data.project.id + " 核销六步核验记录");
  dest.setSubject("会后核销六步结构化核验记录");
  dest.setCreator("Association ERP");
  return Buffer.from(await dest.save({ useObjectStreams: false }));
}

module.exports = { buildArchivePdf, createReportPdf, makeLines };
