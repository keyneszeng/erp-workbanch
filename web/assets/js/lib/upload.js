/**
 * 上传相关的浏览器侧工具
 *
 * 压缩放在前端做，不是偷懒，是权衡后的选择：
 *   服务端压图要引 sharp，一张 3 MB JPEG 解码后约 36 MB 像素，
 *   4 个并发上传就是 144 MB —— 2 GB 的服务器直接 OOM。
 *   浏览器 canvas 做同样的事几乎零成本，还能把上传时间从 12 秒降到 3 秒。
 */

export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;

export function formatBytes(n) {
  const v = Number(n) || 0;
  if (v < 1024) return `${v} B`;
  if (v < 1024 * 1024) return `${(v / 1024).toFixed(0)} KB`;
  return `${(v / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * 前端压缩图片：长边限制 + JPEG 重编码。
 * 只处理 JPEG / PNG / WebP；GIF（压了会丢帧）和 PDF 原样返回。
 * 压完比原图还大时退回原图，绝不做负优化。
 */
export async function compressImage(file, { maxEdge = 2000, quality = 0.85, skipUnder = 400 * 1024 } = {}) {
  if (!/^image\/(jpeg|png|webp)$/.test(file.type || "")) return file;
  if (file.size <= skipUnder) return file;

  let bmp;
  try {
    bmp = await createImageBitmap(file);
  } catch {
    return file; // 浏览器解不了（异常色彩空间等），原图上传
  }

  const longEdge = Math.max(bmp.width, bmp.height);
  const scale = Math.min(1, maxEdge / longEdge);
  const w = Math.max(1, Math.round(bmp.width * scale));
  const h = Math.max(1, Math.round(bmp.height * scale));

  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const g = canvas.getContext("2d");
  // PNG 可能带透明，转 JPEG 前必须铺白底，否则透明区会变黑
  if (file.type === "image/png") {
    g.fillStyle = "#ffffff";
    g.fillRect(0, 0, w, h);
  }
  g.imageSmoothingEnabled = true;
  g.imageSmoothingQuality = "high";
  g.drawImage(bmp, 0, 0, w, h);
  bmp.close?.();

  const blob = await new Promise((r) => canvas.toBlob(r, "image/jpeg", quality));
  if (!blob || blob.size >= file.size) return file;

  const base = file.name.replace(/\.[^.]+$/, "");
  return new File([blob], `${base}.jpg`, { type: "image/jpeg", lastModified: Date.now() });
}

/** 客户端预检，避免传完 8 MB 才被服务端拒 */
/** 所有通用上传窗口共用相同扩展名；服务端独立验证真实内容。 */
export const UPLOAD_ACCEPT = ".jpg,.jpeg,.png,.webp,.gif,.pdf,.doc,.docx,.ppt,.pptx,.xls,.xlsx,.csv,.txt";
export const UPLOAD_FORMATS = "JPG / PNG / WebP / GIF / PDF / DOC / DOCX / PPT / PPTX / XLS / XLSX / CSV / TXT";
export const UPLOAD_TIP = "支持图片、PDF、Word、PowerPoint、Excel（包括老版 XLS）及 CSV/TXT，单个不超过 20 MB。旧版 Office 文件只提供安全下载，不执行宏。";

export function checkFile(file) {
  const ext=String(file?.name||"").split(".").pop().toLowerCase();
  const allowed=new Set(UPLOAD_ACCEPT.split(",").map(x=>x.slice(1)));
  if(!allowed.has(ext))return "不支持该文件类型；可上传 "+UPLOAD_FORMATS;
  if(file.size===0)return "不能上传空文件";
  if(file.size>MAX_UPLOAD_BYTES)
    return "文件不能超过 "+formatBytes(MAX_UPLOAD_BYTES)+"，当前 "+formatBytes(file.size);
  // 浏览器识别旧版 Excel 时可能使用 application/vnd.ms-excel、application/octet-stream
  // 或不返回 MIME；这里按扩展名放行，服务端会按 CFB 目录结构核实真伪。
  return null;
}

/** 缩略图地址（走同一个下载接口，浏览器会按 Cache-Control 缓存） */
export function fileUrl(key) {
  return key ? `/api/uploads/${key}` : "";
}

/**
 * 把 formHtml 里的 file 字段接到压缩流程上。
 * onPick(file | null, errorMessage | null) 由调用方决定怎么用。
 */
export function bindFilePicker(root, name, onPick) {
  const input = root.querySelector(`input[name="${name}"]`);
  if (!input) return;

  const label = input.closest(".upload");
  const fnEl = label ? label.querySelector(".fn") : null;

  input.addEventListener("change", async () => {
    const f = input.files && input.files[0];
    if (!f) return;

    const bad = checkFile(f);
    if (bad) {
      input.value = "";
      if (label) label.classList.remove("has");
      if (fnEl) fnEl.textContent = "未选择";
      onPick(null, bad);
      return;
    }

    if (label) label.classList.add("has");
    if (fnEl) fnEl.textContent = "处理中…";

    const out = await compressImage(f);

    if (fnEl) {
      const saved = f.size - out.size;
      fnEl.textContent = saved > 50 * 1024
        ? `${out.name} · ${formatBytes(out.size)}（已压缩 ${formatBytes(saved)}）`
        : `${out.name} · ${formatBytes(out.size)}`;
    }
    onPick(out, null);
  });
}
