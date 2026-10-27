import { api, can, state } from "../lib/api.js";
import { badge, bindPager, esc, formHtml, modal, money, pager, panel, readForm, table, toast, validate, yuan } from "../lib/ui.js";

const TABS = [
  { k: "", n: "全部" },
  { k: "draft", n: "待审批" },
  { k: "prep", n: "筹备中" },
  { k: "exec", n: "执行中" },
  { k: "verify", n: "待核销" },
  { k: "done", n: "已核销及以后" }
];

const PAGE_SIZE = 50;
let filter = { stage: "", q: "", assoc: "", page: 1 };

export async function render(root) {
  root.innerHTML = `<div class="phead">
      <div><h2>会议项目</h2><p>按数据范围「${esc(state.role.scope)}」展示，共 <b id="cnt">0</b> 场</p></div>
      <div class="acts">
        ${can("export:any") ? '<button class="btn btn-o" id="expBtn">导出 CSV</button>' : ""}
        ${can("project:create") ? '<button class="btn btn-p" id="newBtn">+ 新建立项</button>' : ""}
      </div>
    </div>
    <div class="panel">
      <div class="tabs" id="tabs">${TABS.map((t) => `<button data-stage="${t.k}" class="${filter.stage === t.k ? "on" : ""}">${t.n}</button>`).join("")}</div>
      <div class="filters">
        <input type="search" id="q" placeholder="搜索会议名称 / 编号 / 负责人" value="${esc(filter.q)}">
        <select id="assoc"><option value="">全部协会</option>
          ${(state.meta.assocs || []).map((a) => `<option value="${esc(a)}"${filter.assoc === a ? " selected" : ""}>${esc(a)}</option>`).join("")}
        </select>
        <div class="sp"></div>
        <span class="hint" id="sum"></span>
      </div>
      <div id="list"></div>
    </div>`;

  root.querySelectorAll("#tabs button").forEach((b) => b.addEventListener("click", () => {
    filter.stage = b.dataset.stage;
    filter.page = 1;
    render(root);
  }));
  const q = root.querySelector("#q");
  q.addEventListener("keydown", (e) => { if (e.key === "Enter") { filter.q = q.value.trim(); filter.page = 1; render(root); } });
  q.addEventListener("input", debounce(() => { filter.q = q.value.trim(); filter.page = 1; load(root); }, 300));
  root.querySelector("#assoc").addEventListener("change", (e) => { filter.assoc = e.target.value; filter.page = 1; render(root); });
  // 导出接口按 export:any 收口，按钮也要跟着收 —— 否则嘉宾能看到按钮，点了 403
  const eb = root.querySelector("#expBtn");
  if (eb) eb.addEventListener("click", async () => {
    try {
      const r = await api.download("/api/export/projects");
      toast(`已导出 ${r.name}（${(r.size / 1024).toFixed(1)} KB）`, "ok");
    } catch (e) { toast(e.message, "warn"); }
  });
  const nb = root.querySelector("#newBtn");
  if (nb) nb.addEventListener("click", () => openCreate(root));

  await load(root);
}

function debounce(fn, ms) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

async function load(root) {
  const qs = new URLSearchParams();
  if (filter.stage) qs.set("stage", filter.stage);
  if (filter.q) qs.set("q", filter.q);
  if (filter.assoc) qs.set("assoc", filter.assoc);
  qs.set("page", filter.page);
  qs.set("size", PAGE_SIZE);
  const d = await api.get("/api/projects?" + qs.toString());
  const list = root.querySelector("#list");
  root.querySelector("#cnt").textContent = d.total;
  // 分页后本页行只含当前页金额，合计必须用后端给的全量 summary
  const budget = d.summary ? d.summary.budget : d.rows.reduce((s, r) => s + r.budget, 0);
  const paid = d.summary ? d.summary.paid : d.rows.reduce((s, r) => s + (r.paid_amt || 0), 0);
  root.querySelector("#sum").textContent = `预算合计 ¥${money(budget)} · 已付款 ¥${money(paid)}`;

  list.innerHTML = table(
    [{ t: "编号", w: "112px" }, { t: "会议名称" }, { t: "协会", w: "118px" }, { t: "形式", w: "58px" },
     { t: "会期", w: "92px" }, { t: "预算", w: "92px", cls: "num" }, { t: "负责人", w: "72px" },
     { t: "状态", w: "84px" }, { t: "操作", w: "120px" }],
    d.rows.map((p) => ({
      attrs: ` class="clickable" data-pid="${p.id}"`,
      c: [
        `<span class="mono">${p.id}</span>`,
        `<b style="font-size:12.8px">${esc(p.name)}</b>`,
        esc(p.assoc), esc(p.form), `<span class="mono">${esc(p.date)}</span>`,
        `¥${money(p.budget)}`, esc(p.owner || "—"), badge(p.status),
        `<div class="tacts"><button class="link" data-go="projects/${p.id}">详情</button>
         ${p.status === "待核销" && can("verify:check") ? `<button class="link" data-go="verify/${p.id}">核销</button>` : ""}</div>`
      ]
    })),
    { empty: "没有符合条件的项目" }
  ) + pager(d, { unit: "场" });
  bindPager(list, (n) => { filter.page = n; load(root); });
  list.querySelectorAll("[data-pid]").forEach((tr) => {
    tr.addEventListener("click", (e) => {
      if (e.target.closest("[data-go]")) return;
      location.hash = `#/projects/${tr.dataset.pid}`;
    });
  });
}

function openCreate(root) {
  const fields = [
    { k: "name", l: "会议名称", req: 1, ph: "如：京津冀论坛 2027", full: 1 },
    { k: "assoc", l: "所属协会", t: "select", req: 1, opts: state.meta.assocs },
    { k: "form", l: "会议形式", t: "select", req: 1, opts: state.meta.forms },
    { k: "date", l: "会议日期", t: "date", req: 1 },
    { k: "days", l: "会期（天）", t: "number", v: "1" },
    { k: "budget", l: "预算（元）", t: "number", req: 1, ph: "如：240000" },
    { k: "people", l: "预计参会人数", t: "number", ph: "如：260" },
    { k: "owner", l: "项目负责人", req: 1, ph: "如：王敏" },
    { k: "phone", l: "联系电话", ph: "仅内部可见" },
    { k: "dept", l: "承办部门", t: "select", opts: state.meta.depts },
    { k: "agenda", l: "初版议程要点", t: "textarea", req: 1, rows: 3, full: 1, ph: "按环节列出，如：09:10 主题演讲 / 10:10 病例讨论 …" }
  ];
  const m = modal({
    title: "新建立项申请",
    width: "640px",
    body: `<div class="hint" style="margin-bottom:12px">保存为「草稿」后，可在项目详情页提交审批；提交后进入「待审批」，协会管理员审批通过才进入筹备。</div>
      ${formHtml(fields)}`,
    footer: `<button class="btn btn-o" data-a="cancel">取消</button>
             <button class="btn btn-o" data-a="draft">保存草稿</button>
             <button class="btn btn-p" data-a="submit">保存并提交</button>`
  });
  const box = m.querySelector(".mbox");
  box.querySelector('[data-a="cancel"]').onclick = () => m.classList.remove("open");
  box.querySelectorAll("[data-a]").forEach((btn) => {
    if (btn.dataset.a === "cancel") return;
    btn.addEventListener("click", async () => {
      if (!validate(box, fields)) return;
      const v = readForm(box);
      btn.disabled = true;
      try {
        const r = await api.post("/api/projects", v);
        if (btn.dataset.a === "submit") {
          await api.post(`/api/projects/${r.project.id}/transition`, { action: "submit" });
          toast("已提交立项审批", "ok");
        } else {
          toast(`已保存草稿 ${r.project.id}`, "ok");
        }
        m.classList.remove("open");
        location.hash = `#/projects/${r.project.id}`;
      } catch (e) {
        toast(e.message, "warn");
        btn.disabled = false;
      }
    });
  });
}
