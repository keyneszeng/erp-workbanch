import { api, can } from "../lib/api.js";
import { esc, formHtml, modal, panel, readForm, table, toast, validate } from "../lib/ui.js";

export async function render(root) {
  const d = await api.get("/api/materials");
  const complete = d.projects.filter((p) => p.missing.length === 0).length;

  root.innerHTML = `<div class="phead">
      <div><h2>材料中心</h2><p>归档必备 8 类：${d.kinds.join(" / ")}</p></div>
      <div class="acts">${can("archive:write") ? '<button class="btn btn-p" id="add">+ 登记材料</button>' : ""}</div>
    </div>
    <div class="grid g4">
      <div class="kpi"><div class="t">材料条目</div><div class="v">${d.rows.length}<span class="u">条</span></div></div>
      <div class="kpi k2"><div class="t">在管项目</div><div class="v">${d.projects.length}<span class="u">个</span></div></div>
      <div class="kpi k4"><div class="t">8 类齐备</div><div class="v">${complete}<span class="u">个</span></div></div>
      <div class="kpi k3"><div class="t">待补齐</div><div class="v">${d.projects.length - complete}<span class="u">个</span></div></div>
    </div>

    <div class="panel mt">
      <div class="panel-h"><h2>项目齐备情况</h2><span class="hint">缺项项目无法归档</span></div>
      ${table([{ t: "项目" }, { t: "状态", w: "84px" }, { t: "齐备度", w: "110px" }, { t: "缺失类别" }, { t: "操作", w: "90px" }],
        d.projects.map((p) => ({
          c: [`<a class="link" data-go="projects/${p.id}">${esc(p.name)}</a>`,
            p.status, `<b class="${p.missing.length ? "neg" : "pos"}">${8 - p.missing.length}/8</b>`,
            p.missing.length ? `<span style="color:var(--orange)">${p.missing.join("、")}</span>` : '<span style="color:var(--green)">齐备</span>',
            `<button class="link" data-go="projects/${p.id}">去补</button>`]
        })), { empty: "暂无项目" })}
    </div>

    <div class="panel">
      <div class="panel-h"><h2>材料清单</h2><span class="hint">${d.rows.length} 条</span></div>
      ${table([{ t: "项目", w: "180px" }, { t: "类别", w: "100px" }, { t: "名称" }, { t: "版本", w: "60px" },
        { t: "上传人", w: "80px" }, { t: "时间", w: "130px" }],
        d.rows.map((m) => ({ c: [`<a class="link" data-go="projects/${m.pid}">${esc(m.pname)}</a>`, esc(m.kind),
          esc(m.name), esc(m.version || ""), esc(m.uploader || ""), `<span class="mono">${esc(m.created_at)}</span>`] })),
        { empty: "暂无材料" })}
    </div>`;

  const add = root.querySelector("#add");
  if (add) add.onclick = () => openAdd(root, d.projects, d.kinds);
}

function openAdd(root, projects, kinds) {
  const fields = [
    { k: "pid", l: "所属项目", t: "select", req: 1, opts: projects.map((p) => ({ v: p.id, l: `${p.id} ${p.name}` })) },
    { k: "kind", l: "材料类别", t: "select", req: 1, opts: kinds },
    { k: "name", l: "材料名称", req: 1, ph: "如：签到表-终版.pdf" },
    { k: "version", l: "版本", v: "v1" }
  ];
  const m = modal({ title: "登记材料", body: formHtml(fields),
    footer: `<button class="btn btn-o" data-x="0">取消</button><button class="btn btn-p" data-x="1">保存</button>` });
  m.querySelector('[data-x="0"]').onclick = () => m.classList.remove("open");
  m.querySelector('[data-x="1"]').onclick = async () => {
    if (!validate(m, fields)) return;
    const v = readForm(m);
    try {
      await api.post(`/api/projects/${v.pid}/materials`, v);
      toast("材料已登记", "ok");
      m.classList.remove("open");
      await render(root);
    } catch (e) { toast(e.message, "warn"); }
  };
}
