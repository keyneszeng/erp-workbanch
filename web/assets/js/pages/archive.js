import { api, can } from "../lib/api.js";
import { canDownloadArchivePdf, bindArchivePdfButtons } from "../lib/archive-pdf.js";
import { badge, esc, money, panel, table, toast } from "../lib/ui.js";

let q = "";

export async function render(root) {
  const [proj, st] = await Promise.all([api.get("/api/projects"), api.get("/api/settlements")]);
  const archived = proj.rows.filter((p) => p.status === "已归档");
  const rows = archived.filter((p) => !q || (p.name + p.id + p.assoc).includes(q));
  const settleMap = new Map(st.rows.map((s) => [s.pid, s]));
  const profit = archived.reduce((s, p) => s + (settleMap.get(p.id)?.profit || 0), 0);

  root.innerHTML = `<div class="phead">
      <div><h2>数字卷宗</h2><p>归档前置：结算单已生成 + 材料 8/8 齐备；归档后卷宗封存</p></div>
      <div class="acts">${can("export:any") ? '<button class="btn btn-o" id="exp">导出核销卷宗</button>' : ""}</div>
    </div>
    <div class="grid g3">
      <div class="kpi"><div class="t">已归档项目</div><div class="v">${archived.length}<span class="u">个</span></div></div>
      <div class="kpi k2"><div class="t">累计结余</div><div class="v">¥${money(profit)}</div></div>
      <div class="kpi k4"><div class="t">待归档</div><div class="v">${proj.rows.filter((p) => p.status === "已结算").length}<span class="u">个</span></div></div>
    </div>

    <div class="panel mt">
      <div class="panel-h"><h2>卷宗检索</h2><span class="hint">${rows.length} 个</span></div>
      <div class="filters"><input type="search" id="q" placeholder="搜索会议 / 编号 / 协会" value="${esc(q)}"></div>
      ${table([{ t: "编号", w: "112px" }, { t: "会议名称" }, { t: "协会", w: "120px" }, { t: "会期", w: "92px" },
        { t: "结算单", w: "112px" }, { t: "结余", w: "100px", cls: "num" }, { t: "归档时间", w: "130px" }, { t: "操作", w: "80px" }],
        rows.map((p) => {
          const s = settleMap.get(p.id);
          return { c: [`<span class="mono">${p.id}</span>`, esc(p.name), esc(p.assoc), `<span class="mono">${esc(p.date)}</span>`,
            s ? `<span class="mono">${s.id}</span>` : "—",
            s ? `<span class="${s.profit >= 0 ? "pos" : "neg"}">¥${money(s.profit)}</span>` : "—",
            `<span class="mono">${esc(p.status_at || "")}</span>`,
            `<button class="link" data-go="projects/${p.id}">查看</button>` +
              (canDownloadArchivePdf(p) ? ` <button class="link" data-archive-pdf="${p.id}">资料下载</button>` : "")] };
        }), { empty: "暂无归档项目" })}
    </div>

    <div class="panel">
      <div class="panel-h"><h2>待归档</h2><span class="hint">结算完成即可归档</span></div>
      ${table([{ t: "编号", w: "112px" }, { t: "会议名称" }, { t: "状态", w: "84px" }, { t: "操作", w: "100px" }],
        proj.rows.filter((p) => p.status === "已结算").map((p) => ({
          c: [`<span class="mono">${p.id}</span>`, esc(p.name), badge(p.status), `<button class="link" data-go="projects/${p.id}">去归档</button>`]
        })), { empty: "没有待归档项目" })}
    </div>`;

  bindArchivePdfButtons(root);
  root.querySelector("#q").addEventListener("input", (e) => { q = e.target.value.trim(); render(root); });
  const expBtn = root.querySelector("#exp");
  if (expBtn) expBtn.onclick = async () => {
    try { const r = await api.download("/api/export/verify"); toast(`已导出 ${r.name}`, "ok"); }
    catch (e) { toast(e.message, "warn"); }
  };
}
