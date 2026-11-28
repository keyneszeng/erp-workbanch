import { esc } from "./ui.js";
import { api } from "./api.js";

/**
 * 统一的原件弹窗预览：全系统所有 /api/uploads/<key> 链接共用。
 *
 * 采用 document 级事件委托，一次初始化覆盖所有页面/弹窗里的「查看原件」链接，
 * 无需逐个改各业务页面。普通左键点击 → 弹窗预览；Ctrl/Cmd/Shift/中键点击 → 保留浏览器原生行为（新窗口）。
 *
 * - 图片：直接 <img> 铺开
 * - PDF：iframe 内嵌
 * - Office（doc/docx/ppt/pptx/xls/xlsx）与 txt/csv：走 /api/uploads/<key>?preview=1
 *   后端把 Office 转成 PDF 内联返回（LibreOffice，带缓存），文本按纯文本内联；
 *   权限校验与直接下载走同一条路由，没有任何绕过。
 * - 弹窗头部保留「新窗口打开」「下载」「关闭」，内嵌失败也能兜底。
 */
const IMG_EXT = ["jpg", "jpeg", "png", "webp", "gif", "bmp"];

/** 把后端解析出的 sheet 结构渲染成 <table>，还原行列与合并单元格，不改原件。 */
function renderXlsxSheet(sheet) {
  const cellMap = new Map();
  for (const c of sheet.cells || []) cellMap.set(c.r + ":" + c.c, c);
  const mergeStart = new Map(), covered = new Set();
  for (const m of sheet.merges || []) {
    mergeStart.set(m.r + ":" + m.c, m);
    for (let r = m.r; r < m.r + m.rs; r++)
      for (let c = m.c; c < m.c + m.cs; c++)
        if (r !== m.r || c !== m.c) covered.add(r + ":" + c);
  }
  const widths = new Map((sheet.widths || []).map(w => [w.col, w.width]));
  const rows = [];
  for (let r = 1; r <= (sheet.rows || 0); r++) {
    const tds = [];
    for (let c = 1; c <= (sheet.colsCount || 0); c++) {
      if (covered.has(r + ":" + c)) continue;
      const cell = cellMap.get(r + ":" + c);
      const merge = mergeStart.get(r + ":" + c);
      const attrs = [];
      if (widths.get(c)) attrs.push('style="min-width:' + Math.min(360, Math.max(60, widths.get(c))) + 'px"');
      if (merge && merge.rs > 1) attrs.push('rowspan="' + merge.rs + '"');
      if (merge && merge.cs > 1) attrs.push('colspan="' + merge.cs + '"');
      if (cell && cell.t === "n") attrs.push('class="num"');
      tds.push("<td " + attrs.join(" ") + ">" + esc(cell ? cell.v : "") + "</td>");
    }
    rows.push("<tr>" + tds.join("") + "</tr>");
  }
  return '<table class="xlsx-table"><tbody>' + rows.join("") + "</tbody></table>";
}

function renderXlsxPreview(box, key, name) {
  const bd = box.querySelector(".fv-bd");
  bd.innerHTML = '<p class="hint" style="padding:24px">正在按原表格结构读取…</p>';
  api.get("/api/uploads/" + encodeURIComponent(key) + "?preview=table")
    .then(data => {
      const sheets = data?.sheets || [];
      if (!sheets.length) { bd.innerHTML = '<p class="hint" style="padding:24px">这张表没有可预览的内容</p>'; return; }
      bd.innerHTML = '<div class="xlsx-wrap">' +
        (sheets.length > 1
          ? '<div class="xlsx-tabs">' + sheets.map((s, i) => '<button type="button" class="link' + (i ? "" : " on") + '" data-sheet="' + i + '">' + esc(s.name) + "</button>").join("") + "</div>"
          : "") +
        '<div class="xlsx-sheet" data-sheet-body></div></div>';
      const body = bd.querySelector("[data-sheet-body]");
      const show = i => {
        body.innerHTML = renderXlsxSheet(sheets[i]);
        bd.querySelectorAll("[data-sheet]").forEach(b => b.classList.toggle("on", Number(b.dataset.sheet) === i));
      };
      bd.querySelectorAll("[data-sheet]").forEach(b => b.onclick = () => show(Number(b.dataset.sheet)));
      show(0);
    })
    .catch(err => {
      bd.innerHTML = '<p class="hint" style="padding:24px">表格读取失败：' + esc(err.message || "请稍后重试") + "</p>";
    });
}

function buildPreview(key, name) {
  const ext = String(key.split(".").pop() || "").toLowerCase();
  const url = "/api/uploads/" + encodeURIComponent(key);
  const isImg = IMG_EXT.includes(ext);
  const isPdf = ext === "pdf";
  // 图片与 PDF 直接用原 URL；Office/txt/csv 走后端的 preview=1 内联形态。
  const previewUrl = isImg || isPdf ? url : url + "?preview=1";
  const box = document.createElement("div");
  box.className = "fv";
  box.innerHTML = '<div class="fv-mask" data-fv-close></div><div class="fv-box">' +
    '<div class="fv-hd"><b>' + esc(name || "原件") + '</b><span>' +
    '<a class="link" href="' + url + '" target="_blank" rel="noopener">新窗口打开</a>' +
    '<a class="link" href="' + url + '" download style="margin-left:10px">下载</a>' +
    '<button class="btn btn-o" data-fv-close style="margin-left:10px">关闭</button></span></div>' +
    '<div class="fv-bd">' + (isImg
      ? '<img src="' + url + '" alt="' + esc(name || "原件") + '">'
      : '<iframe src="' + previewUrl + '" title="原件预览"></iframe>') +
    '</div></div>';
  document.body.appendChild(box);
  // xlsx 走原表格结构渲染（行列/合并单元格/列宽），不转 PDF、不改内容编排。
  if (ext === "xlsx") { box.querySelector(".fv-bd").classList.add("xlsx-mode"); renderXlsxPreview(box, key, name); }
  const close = () => { box.remove(); document.removeEventListener("keydown", onKey); };
  const onKey = e => { if (e.key === "Escape") close(); };
  box.querySelectorAll("[data-fv-close]").forEach(el => el.onclick = close);
  document.addEventListener("keydown", onKey);
}

/** 供需要主动调用的场景使用（例如 verify-ocr-judge 的 data-view）。 */
export function previewFile(key, name = "原件") {
  if (key) buildPreview(key, name);
}

let installed = false;
/** 安装全局委托：拦截所有指向 /api/uploads/<key> 的普通左键点击为弹窗预览。 */
export function installFilePreview() {
  if (installed || typeof document === "undefined") return;
  installed = true;
  document.addEventListener("click", e => {
    if (e.defaultPrevented || e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
    const a = e.target.closest && e.target.closest("a[href]");
    if (!a) return;
    // 显式要求原生下载的链接不拦截。
    if (a.hasAttribute("download")) return;
    const href = a.getAttribute("href") || "";
    const m = href.match(/^\/api\/uploads\/([A-Za-z0-9._-]+)(?:\?[^#]*)?$/);
    if (!m) return;
    let key;
    try { key = decodeURIComponent(m[1]); } catch { return; }
    if (!/^[a-f0-9]{32}\.[a-z0-9]+$/i.test(key)) return;
    e.preventDefault();
    e.stopPropagation();
    // 名称优先取链接上的显式标注，其次标题属性，最后回退文件名。
    const name = a.getAttribute("data-file-name") || a.getAttribute("title") || a.textContent.trim();
    buildPreview(key, name && name !== "查看" ? name : "");
  });
}

/** 兼容需要按容器绑定的页面（实际全局委托已覆盖，此函数保留给显式绑定场景）。 */
export function bindFilePreview(root) {
  if (!root) return;
  root.querySelectorAll("[data-file-preview]").forEach(el => {
    if (el.dataset.fvBound === "1") return;
    el.dataset.fvBound = "1";
    el.addEventListener("click", e => {
      e.preventDefault();
      e.stopPropagation();
      previewFile(el.dataset.filePreview, el.dataset.fileName || el.textContent.trim() || "原件");
    });
  });
}
