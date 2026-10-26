/** 通用 UI 组件（复用演示版设计系统） */

export const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

export const money = (n) => Number(n || 0).toLocaleString("zh-CN");
export const yuan = (n) => `¥${money(n)}`;

const STATUS_CLS = {
  "草稿": "b-gray", "待审批": "b-orange", "已立项": "b-blue", "筹备中": "b-blue",
  "执行中": "b-teal", "待核销": "b-orange", "已核销": "b-green", "已结算": "b-green", "已归档": "b-steel",
  "通过": "b-green", "不通过": "b-red", "待判定": "b-gray", "已解例外": "b-purple",
  "待审批(付款)": "b-orange", "已审批": "b-blue", "已付款": "b-green", "已驳回": "b-red",
  "待邀请": "b-gray", "待确认": "b-orange", "已确认": "b-green", "已通过": "b-green",
  "待开始": "b-gray", "进行中": "b-blue", "已完成": "b-green", "处理中": "b-orange", "已解决": "b-green",
  "已签署": "b-green", "待签署": "b-orange", "已生成": "b-green", "已启用": "b-green", "已停用": "b-gray"
};

export const badge = (s) => `<span class="badge ${STATUS_CLS[s] || "b-blue"}">${esc(s)}</span>`;

export const panel = (title, hint, body, right = "") => `<div class="panel">
  <div class="panel-h"><h2>${title}</h2>
  <div>${hint ? `<span class="hint">${hint}</span>` : ""}${right}</div></div>${body}</div>`;

export const kv = (pairs, cls = "") =>
  `<dl class="dl ${cls}">${pairs.map(([k, v]) => `<dt>${k}</dt><dd>${v ?? "—"}</dd>`).join("")}</dl>`;

export const kpi = (t, v, u, cls = "") =>
  `<div class="kpi ${cls}"><div class="t">${t}</div><div class="v">${v}<span class="u">${u || ""}</span></div></div>`;

export function table(cols, rows, opt = {}) {
  if (!rows.length) return `<div class="empty">${opt.empty || "暂无数据"}</div>`;
  // 列多时给表格一个最小宽度，窄屏走横向滚动，避免文字被压成一字一行
  const minw = opt.minw || (cols.length >= 9 ? 1000 : cols.length >= 7 ? 860 : cols.length >= 5 ? 680 : 0);
  return `<div class="tw"><table${minw ? ` style="min-width:${minw}px"` : ""}>
  <thead><tr>${cols.map((c) => `<th${c.w ? ` style="width:${c.w}"` : ""}>${c.t}</th>`).join("")}</tr></thead>
  <tbody>${rows.map((r) => `<tr${r.attrs || ""}>${r.c.map((x, i) =>
    `<td${cols[i].cls ? ` class="${cols[i].cls}"` : ""}${cols[i].nw ? ' style="white-space:nowrap"' : ""}>${x}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`;
}

export function timeline(items) {
  if (!items.length) return `<div class="empty">暂无记录</div>`;
  return `<div class="tl">${items.map((i) => `<div class="ti">
    <b>${esc(i.at)} · ${esc(i.user_name || "")}</b>
    <span>${esc(i.detail || i.action || "")}</span></div>`).join("")}</div>`;
}

export function toast(msg, type = "") {
  const box = document.getElementById("toast");
  const el = document.createElement("div");
  el.className = `toast ${type}`;
  el.textContent = msg;
  box.appendChild(el);
  setTimeout(() => { el.style.opacity = "0"; el.style.transition = "opacity .3s"; }, 2600);
  setTimeout(() => el.remove(), 3000);
}

export function loading(text = "加载中…") {
  return `<div class="empty" style="padding:60px 20px">${text}</div>`;
}

/* ---------------- 弹窗 ---------------- */
export function modal({ title, body, footer = "", width = "" }) {
  const root = document.getElementById("modal");
  root.innerHTML = `<div class="mmask" data-close="1"></div>
    <div class="mbox" ${width ? `style="width:${width}"` : ""}>
      <div class="mh"><h3>${title}</h3><button class="close" data-close="1">×</button></div>
      <div class="mb">${body}</div>
      ${footer ? `<div class="mf">${footer}</div>` : ""}
    </div>`;
  root.classList.add("open");
  root.querySelectorAll("[data-close]").forEach((el) => el.addEventListener("click", closeModal));
  return root;
}

export function closeModal() {
  const root = document.getElementById("modal");
  root.classList.remove("open");
  root.innerHTML = "";
}

export function confirmBox(message, { title = "请确认", ok = "确认", danger = false } = {}) {
  return new Promise((resolve) => {
    const root = modal({
      title,
      body: `<div style="font-size:13.5px;color:var(--txt);line-height:1.8">${message}</div>`,
      footer: `<button class="btn btn-o" data-x="0">取消</button>
               <button class="btn ${danger ? "btn-d" : "btn-p"}" data-x="1">${ok}</button>`
    });
    root.querySelectorAll("[data-x]").forEach((b) =>
      b.addEventListener("click", () => { closeModal(); resolve(b.dataset.x === "1"); })
    );
  });
}

export function promptBox({ title = "填写", label = "", ph = "", required = true, ok = "提交" } = {}) {
  return new Promise((resolve) => {
    const root = modal({
      title,
      body: `<div class="fld"><label>${label}${required ? '<span class="req">*</span>' : ""}</label>
        <textarea name="v" rows="4" placeholder="${esc(ph)}"></textarea>
        <div class="tip" data-err style="color:var(--red);display:none">此项为必填</div></div>`,
      footer: `<button class="btn btn-o" data-x="0">取消</button>
               <button class="btn btn-p" data-x="1">${ok}</button>`
    });
    const ta = root.querySelector("textarea");
    ta.focus();
    root.querySelector('[data-x="1"]').addEventListener("click", () => {
      const v = ta.value.trim();
      if (required && !v) {
        root.querySelector("[data-err]").style.display = "block";
        ta.focus();
        return;
      }
      closeModal();
      resolve(v);
    });
    root.querySelector('[data-x="0"]').addEventListener("click", () => { closeModal(); resolve(null); });
  });
}

/* ---------------- 表单 ---------------- */
/**
 * fields: [{k,l,t,req,opts,ph,v,full,tip,rows}]
 */
export function formHtml(fields, values = {}) {
  return `<div class="fgrid">${fields.map((f) => {
    const v = values[f.k] ?? f.v ?? "";
    const req = f.req ? '<span class="req">*</span>' : "";
    let input = "";
    if (f.t === "select") {
      input = `<select name="${f.k}">${(f.opts || []).map((o) => {
        const val = typeof o === "string" ? o : o.v;
        const lab = typeof o === "string" ? o : o.l;
        return `<option value="${esc(val)}"${String(v) === String(val) ? " selected" : ""}>${esc(lab)}</option>`;
      }).join("")}</select>`;
    } else if (f.t === "textarea") {
      input = `<textarea name="${f.k}" rows="${f.rows || 3}" placeholder="${esc(f.ph || "")}">${esc(v)}</textarea>`;
    } else if (f.t === "file") {
      input = `<label class="upload"><input type="file" name="${f.k}"${f.accept ? ` accept="${esc(f.accept)}"` : ""} style="display:none">
        <span>选择文件</span><span class="fn" style="color:var(--mute)">未选择</span></label>`;
    } else {
      input = `<input type="${f.t || "text"}" name="${f.k}" value="${esc(v)}" placeholder="${esc(f.ph || "")}"
        ${f.t === "number" ? 'step="any" min="0"' : ""}>`;
    }
    return `<div class="fld${f.full ? " full" : ""}"${f.full ? ' style="grid-column:1/-1"' : ""}>
      <label>${f.l}${req}</label>${input}${f.tip ? `<div class="tip">${f.tip}</div>` : ""}</div>`;
  }).join("")}</div>`;
}

export function readForm(root) {
  const out = {};
  root.querySelectorAll("[name]").forEach((el) => {
    if (el.type === "file") return;
    out[el.name] = el.value.trim();
  });
  return out;
}

export function validate(root, fields) {
  let ok = true;
  root.querySelectorAll(".fld.err").forEach((el) => el.classList.remove("err"));
  for (const f of fields) {
    if (!f.req) continue;
    const el = root.querySelector(`[name="${f.k}"]`);
    if (!el) continue;
    if (!String(el.value || "").trim()) {
      el.closest(".fld")?.classList.add("err");
      ok = false;
    }
  }
  if (!ok) toast("请填写标红的必填项", "warn");
  return ok;
}

export function progressBar(pct, color = "var(--blue)") {
  return `<div class="bar-wrap" style="background:#eef2f7;border-radius:4px;height:6px;overflow:hidden">
    <div class="bar-in" style="width:${Math.min(100, Math.max(0, pct))}%;height:100%;background:${color}"></div></div>`;
}

/* ---------------- 分页 ---------------- */
function pageWindow(cur, total) {
  if (total <= 7) return Array.from({ length: total }, (_, i) => i + 1);
  const out = [1];
  const start = Math.max(2, cur - 2);
  const end = Math.min(total - 1, cur + 2);
  if (start > 2) out.push("…");
  for (let i = start; i <= end; i++) out.push(i);
  if (end < total - 1) out.push("…");
  out.push(total);
  return out;
}

/**
 * 渲染分页条。data 为接口返回体（含 total / page / size / pages / paged）。
 * 未启用分页时只显示总数，不显示按钮。
 */
export function pager(data, opt = {}) {
  if (!data) return "";
  const unit = opt.unit || "条";
  const total = data.total ?? (data.rows || []).length;
  const pages = data.pages || 1;
  const page = data.page || 1;

  // 未分页、或总共只有一页时，只显示总数——翻页按钮没有意义还占地方
  if (!data.paged || pages <= 1) {
    return `<div class="pager"><span class="pg-info">共 ${total} ${unit}</span></div>`;
  }
  const nums = pageWindow(page, pages);
  return `<div class="pager">
    <span class="pg-info">共 ${total} ${unit} · 第 ${page} / ${pages} 页</span>
    <div class="pg-btns">
      <button class="btn btn-o btn-sm" data-pg="${page - 1}"${page <= 1 ? " disabled" : ""}>上一页</button>
      ${nums.map((n) => n === "…"
        ? '<span class="pg-gap">…</span>'
        : `<button class="btn btn-sm ${n === page ? "btn-p" : "btn-o"}" data-pg="${n}">${n}</button>`).join("")}
      <button class="btn btn-o btn-sm" data-pg="${page + 1}"${page >= pages ? " disabled" : ""}>下一页</button>
    </div>
  </div>`;
}

/** 绑定分页点击。回调收到目标页码。 */
export function bindPager(root, onGo) {
  root.querySelectorAll("[data-pg]").forEach((b) => {
    if (b.disabled) return;
    b.addEventListener("click", () => {
      const n = Number(b.dataset.pg);
      if (Number.isFinite(n) && n > 0) onGo(n);
    });
  });
}
