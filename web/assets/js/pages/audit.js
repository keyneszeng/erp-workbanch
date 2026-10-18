import { api, state } from "../lib/api.js";
import { esc, panel, table, toast } from "../lib/ui.js";

let filter = { module: "", q: "" };

export async function render(root) {
  const qs = new URLSearchParams();
  if (filter.module) qs.set("module", filter.module);
  if (filter.q) qs.set("q", filter.q);
  const d = await api.get("/api/audit?" + qs.toString());
  const mods = ["项目管理", "筹备管理", "材料中心", "会后核销", "财务结算", "档案中心", "系统配置"];

  root.innerHTML = `<div class="phead">
      <div><h2>审计日志</h2><p>${d.limited ? "当前角色仅可查看本人操作" : "全量操作留痕：Who / When / What / Which"}</p></div>
      <div class="acts">${d.limited ? "" : '<button class="btn btn-o" id="exp">导出日志</button>'}</div>
    </div>
    <div class="panel">
      <div class="filters">
        <select id="mod"><option value="">全部模块</option>
          ${mods.map((m) => `<option value="${m}"${filter.module === m ? " selected" : ""}>${m}</option>`).join("")}
        </select>
        <input type="search" id="q" placeholder="搜索详情 / 对象 / 操作人" value="${esc(filter.q)}">
        <div class="sp"></div>
        <span class="hint">${d.rows.length} 条</span>
      </div>
      ${table([{ t: "时间", w: "130px" }, { t: "操作人", w: "82px" }, { t: "角色", w: "110px" }, { t: "模块", w: "92px" },
        { t: "动作", w: "92px" }, { t: "对象", w: "112px" }, { t: "详情" }],
        d.rows.map((r) => ({
          c: [`<span class="mono">${esc(r.at)}</span>`, esc(r.user_name), esc(r.role), esc(r.module),
            `<b style="font-size:12.5px">${esc(r.action)}</b>`,
            r.target && r.target.startsWith("MP-") ? `<a class="link" data-go="projects/${r.target}">${esc(r.target)}</a>` : `<span class="mono">${esc(r.target || "—")}</span>`,
            `<span style="font-size:12.5px">${esc(r.detail || "")}</span>`]
        })), { empty: "暂无日志" })}
    </div>`;

  root.querySelector("#mod").onchange = (e) => { filter.module = e.target.value; render(root); };
  const q = root.querySelector("#q");
  q.addEventListener("input", () => {
    clearTimeout(q._t);
    q._t = setTimeout(() => { filter.q = q.value.trim(); render(root); }, 350);
  });
  const exp = root.querySelector("#exp");
  if (exp) exp.onclick = async () => {
    try { const r = await api.download("/api/export/audit"); toast(`已导出 ${r.name}`, "ok"); }
    catch (e) { toast(e.message, "warn"); }
  };
}
