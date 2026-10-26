/** 统一接口层：所有页面只通过这里访问后端 */
const jsonHeaders = { "Content-Type": "application/json" };

export class ApiError extends Error {
  constructor(status, code, message, detail) {
    super(message);
    this.status = status;
    this.code = code;
    this.detail = detail;
  }
}

async function request(path, { method = "GET", body, raw = false } = {}) {
  const res = await fetch(path, {
    method,
    credentials: "same-origin",
    headers: body ? jsonHeaders : undefined,
    body: body ? JSON.stringify(body) : undefined
  });
  if (raw) return res;
  let data = null;
  try { data = await res.json(); } catch { data = null; }
  if (!res.ok) {
    const err = data?.error || {};
    if (res.status === 401 && !path.includes("/auth/login")) {
      window.dispatchEvent(new CustomEvent("erp:unauthorized"));
    }
    throw new ApiError(res.status, err.code || "ERROR", err.message || `请求失败（${res.status}）`, err.detail);
  }
  return data;
}

export const api = {
  get: (p) => request(p),
  post: (p, body) => request(p, { method: "POST", body }),
  patch: (p, body) => request(p, { method: "PATCH", body }),
  del: (p) => request(p, { method: "DELETE" }),
  /**
   * 上传单个文件（原始二进制，非 multipart）。
   * 用 XHR 而不是 fetch：fetch 拿不到上传进度，几 MB 的照片没有进度条体验很差。
   */
  upload(file, { onProgress } = {}) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open("POST", "/api/uploads");
      xhr.withCredentials = true;
      xhr.setRequestHeader("Content-Type", file.type || "application/octet-stream");
      xhr.setRequestHeader("x-file-name", encodeURIComponent(file.name || "file"));
      if (onProgress) {
        xhr.upload.onprogress = (e) => {
          if (e.lengthComputable) onProgress(e.loaded / e.total);
        };
      }
      xhr.onload = () => {
        let data = null;
        try { data = JSON.parse(xhr.responseText); } catch { data = null; }
        if (xhr.status >= 200 && xhr.status < 300) return resolve(data);
        const err = data?.error || {};
        if (xhr.status === 401) window.dispatchEvent(new CustomEvent("erp:unauthorized"));
        reject(new ApiError(xhr.status, err.code || "UPLOAD_FAILED", err.message || `上传失败（${xhr.status}）`));
      };
      xhr.onerror = () => reject(new ApiError(0, "NETWORK", "网络异常，上传失败"));
      xhr.ontimeout = () => reject(new ApiError(0, "TIMEOUT", "上传超时，请重试"));
      xhr.send(file);
    });
  },
  async download(path) {
    const res = await request(path, { raw: true });
    if (!res.ok) {
      let msg = "导出失败";
      try { msg = (await res.json()).error?.message || msg; } catch {}
      throw new ApiError(res.status, "EXPORT_FAILED", msg);
    }
    const blob = await res.blob();
    const cd = res.headers.get("Content-Disposition") || "";
    const m = /filename\*=UTF-8''([^;]+)/.exec(cd);
    const name = m ? decodeURIComponent(m[1]) : "export.csv";
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 3000);
    return { name, size: blob.size };
  }
};

export const state = {
  user: null,
  role: null,
  perms: [],
  super: false,
  meta: null,
  route: "dashboard",
  cache: {}
};

export function can(perm) {
  if (state.super) return true;
  return state.perms.includes(perm);
}
