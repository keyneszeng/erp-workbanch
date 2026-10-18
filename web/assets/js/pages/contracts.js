import { api, can, state } from "../lib/api.js";
import { badge, esc, formHtml, modal, money, panel, readForm, table, toast, validate } from "../lib/ui.js";

let q = "";

export async function render(root) {
  const [c, proj] = await Promise.all([api.get("/api/contracts"), api.get("/api/projects")]);
  const rows = c.rows.filter((r) => !q || (r.name + r.vendor + r.pname + r.id).includes(q));
  const total = rows.reduce((s, r) => s + r.amount, 0);
  const signed = rows.filter((r) => r.status === "已签署").reduce((s, r) => s + r.amount, 0);

  root.innerHTML = `<div class="phead">
      <div><h2>合同台账</h2><p>合同金额是核销第 6 步与付款金额的比对基准</p></div>
      <div class="acts">
        <button class="btn btn-o" id="exp">导出 CSV</button>
        ${can("contract:write") ? '<button class="btn btn-p" id="newC">+ 录入合同</button>' : ""}
      </div>
    </div>
    <div class="grid g3">
      <div class="kpi"><div class="t">合同数</div><div class="v">${rows.length}<span class="u">份</span></div></div>
      <div class="kpi k2"><div class="t">合同总额</div><div class="v">¥${money(total)}</div></div>
      <div class="kpi k4"><div class="t">已签署金额</div><div class="v">¥${money(signed)}</div></div>
    </div>
    <div class="panel mt">
      <div class="panel-h"><h2>合同清单</h2><span class="hint">${rows.length} 份</span></div>
      <div class="filters"><input type="search" id="q" placeholder="搜索合同 / 签约方 / 项目" value="${esc(q)}"></div>
      ${table(
        [{ t: "合同编号", w: "112px" }, { t: "项目", w: "170px" }, { t: "合同名称" }, { t: "签约方", w: "160px" },
         { t: "金额", w: "104px", cls: "num" }, { t: "签署日期", w: "100px" }, { t: "状态", w: "80px" }],
        rows.map((r) => ({
          c: [`<span class="mono">${r.id}</span>`, `<a class="link" data-go="projects/${r.pid}">${esc(r.pname)}</a>`,
            esc(r.name), esc(r.vendor), `¥${money(r.amount)}`, `<span class="mono">${esc(r.sign_date || "—")}</span>`, badge(r.status)]
        })), { empty: "暂无合同" })}
    </div>`;

  root.querySelector("#q").addEventListener("input", (e) => { q = e.target.value.trim(); render(root); });
  root.querySelector("#exp").onclick = async () => {
    try { const r = await api.download("/api/export/contracts"); toast(`已导出 ${r.name}`, "ok"); }
    catch (e) { toast(e.message, "warn"); }
  };
  const nb = root.querySelector("#newC");
  if (nb) nb.onclick = () => openCreate(root, proj.rows);
}

function openCreate(root, projects) {
  const fields = [
    { k: "pid", l: "所属项目", t: "select", req: 1, opts: projects.map((p) => ({ v: p.id, l: `${p.id} ${p.name}` })) },
    { k: "name", l: "合同名称", req: 1, full: 1 },
    { k: "vendor", l: "签约方", req: 1 },
    { k: "amount", l: "合同金额（元）", t: "number", req: 1 },
    { k: "sign_date", l: "签署日期", t: "date" },
    { k: "status", l: "状态", t: "select", opts: ["草稿", "待签署", "已签署"] }
  ];
  const m = modal({ title: "录入合同", body: formHtml(fields),
    footer: `<button class="btn btn-o" data-x="0">取消</button><button class="btn btn-p" data-x="1">保存</button>` });
  m.querySelector('[data-x="0"]').onclick = () => m.classList.remove("open");
  m.querySelector('[data-x="1"]').onclick = async () => {
    if (!validate(m, fields)) return;
    try {
      const r = await api.post("/api/contracts", readForm(m));
      toast(r.message, "ok");
      m.classList.remove("open");
      await render(root);
    } catch (e) { toast(e.message, "warn"); }
  };
}
