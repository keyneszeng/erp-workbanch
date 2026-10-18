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
