/**
 * 原件在线预览
 *
 * 为什么不用裸链接：
 *   `<a href="/api/uploads/xxx.pdf" target="_blank">` 能不能直接看到内容，取决于浏览器。
 *   Chrome 装了 PDF 阅读器会内嵌显示，但很多国产浏览器、或系统里勾了「下载 PDF」
 *   的用户，点下去就是下载一个以哈希命名的文件 —— 核销时要核对原件内容，
 *   落到下载等于把核对动作打断。Office 文件（课件、串场 PPT、劳务表 Excel）
 *   浏览器更是完全没有渲染能力，只会下载。
 *
 * 所以统一走应用内预览：
 *   图片   → 直接铺开
 *   PDF    → 服务端按页渲染成 PNG（/api/uploads/:key/preview），任何浏览器都能看
 *   Office → 明确说明无法在线预览，给出下载入口（不假装能看）
 *
 * 链接本身仍然保留 href + target，JS 失效时退化为新窗口打开。
 */
import { esc, modal } from "./ui.js";

const IMAGE_EXT = ["jpg", "jpeg", "png", "webp", "gif"];
const OFFICE_EXT = ["doc", "docx", "xls", "xlsx", "ppt", "pptx"];

export function fileExt(key) {
  const m = /\.([a-z0-9]+)$/i.exec(String(key || ""));
  return m ? m[1].toLowerCase() : "";
}

export function fileUrl(key) {
  return key ? `/api/uploads/${encodeURIComponent(key)}` : "";
}

/** 在线预览地址（PDF 走服务端渲染，其余同原文件） */
function previewUrl(key, page = 1) {
  return `/api/uploads/${encodeURIComponent(key)}/preview?page=${page}`;
}

/**
 * 生成「在线查看原件」链接。
 * @param {string} key   文件 key
 * @param {string} name  原始文件名（用于弹窗标题与下载文件名）
 * @param {string} label 链接文字
 */
export function fileLink(key, name = "", label = "在线查看原件") {
  if (!key) return "未上传";
  return `<a class="link" href="${fileUrl(key)}" target="_blank" rel="noopener"
    data-file-preview="${esc(key)}" data-file-name="${esc(name)}"
    title="在线查看原件">${esc(label)}</a>`;
}

/** 打开预览弹窗 */
export function openFilePreview(key, name = "") {
  const ext = fileExt(key);
  const title = name || `原件${ext ? " · " + ext.toUpperCase() : ""}`;
  const url = fileUrl(key);

  if (OFFICE_EXT.includes(ext)) {
    const root = modal({
      title: `原件预览 · ${esc(title)}`,
      width: "560px",
      body: `<div class="fp-note">
          <b>${esc(ext.toUpperCase())} 无法在浏览器里直接显示</b>
          浏览器不支持在线渲染 Word / Excel / PowerPoint，这是格式限制，不是权限问题。
          可以下载后用本地 Office 打开核对；如果希望全程在线，建议把这类原件同时导出一份 PDF 上传。
        </div>`,
      footer: `<a class="btn btn-o" href="${url}" target="_blank" rel="noopener">新窗口打开</a>
               <a class="btn btn-p" href="${url}" download>下载原件</a>`
    });
    return root;
  }

  const isImage = IMAGE_EXT.includes(ext);
  const root = modal({
    title: `原件预览 · ${esc(title)}`,
    width: "940px",
    body: `${isImage ? "" : `<div class="fp-bar">
        <button class="btn btn-o btn-sm" data-fp-prev disabled>上一页</button>
        <span class="fp-ind" data-fp-ind>第 1 页</span>
        <button class="btn btn-o btn-sm" data-fp-next disabled>下一页</button>
        <div style="flex:1"></div>
        <span class="fp-hint">滚轮可缩放，拖动画布可平移</span>
      </div>`}
      <div class="fp-wrap" data-fp-wrap><div class="fp-loading">正在加载原件…</div></div>`,
    footer: `<a class="btn btn-o" href="${url}" target="_blank" rel="noopener">原文件</a>
             <a class="btn btn-o" href="${url}" download>下载</a>
             <button class="btn btn-p" data-close="1">关闭</button>`
  });

  const wrap = root.querySelector("[data-fp-wrap]");
  const ind = root.querySelector("[data-fp-ind]");
  const prev = root.querySelector("[data-fp-prev]");
  const next = root.querySelector("[data-fp-next]");
  let page = 1, pages = 1, objectUrl = "";

  const show = (message) => {
    wrap.innerHTML = `<div class="fp-note">${message}</div>`;
  };

  const load = async (target) => {
    wrap.innerHTML = `<div class="fp-loading">正在加载原件…</div>`;
    try {
      const res = await fetch(isImage ? url : previewUrl(key, target), { credentials: "same-origin" });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        const msg = body?.error?.message || `预览失败（HTTP ${res.status}）`;
        // 服务端没装 poppler 或文件加密时，明确告诉用户可以下载查看
        show(`${esc(msg)}<div style="margin-top:10px"><a class="btn btn-o" href="${url}" download>下载原件</a></div>`);
        return;
      }
      if (!isImage) {
        pages = Number(res.headers.get("X-Preview-Pages") || 1);
        page = Number(res.headers.get("X-Preview-Page") || target);
      }
      const blob = await res.blob();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      objectUrl = URL.createObjectURL(blob);
      wrap.innerHTML = `<img class="fp-page" alt="${esc(title)}" src="${objectUrl}">`;
      // 点一下放大到原始像素宽度，再点回到适配宽度：合同小字经常要看清
      const img = wrap.querySelector(".fp-page");
      img?.addEventListener("click", () => img.classList.toggle("fp-zoom"));
      if (ind) ind.textContent = `第 ${page} / ${pages} 页`;
      if (prev) prev.disabled = page <= 1;
      if (next) next.disabled = page >= pages;
    } catch (e) {
      show(`原件加载失败：${esc(e.message)}`);
    }
  };

  prev?.addEventListener("click", () => { if (page > 1) load(page - 1); });
  next?.addEventListener("click", () => { if (page < pages) load(page + 1); });
  // 关闭时释放 Blob，避免连续查看多份原件把内存堆住
  root.querySelectorAll("[data-close]").forEach((el) =>
    el.addEventListener("click", () => { if (objectUrl) URL.revokeObjectURL(objectUrl); })
  );
  load(1);
  return root;
}

/**
 * 全局委托：任何带 data-file-preview 的链接都走预览弹窗。
 * 带修饰键点击（Ctrl/⌘/Shift）或中键时放行，保留用户「就要新窗口打开」的习惯。
 */
if (typeof document !== "undefined") {
  document.addEventListener("click", (e) => {
    const a = e.target.closest("[data-file-preview]");
    if (!a) return;
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
    e.preventDefault();
    openFilePreview(a.dataset.filePreview, a.dataset.fileName || "");
  });
}
