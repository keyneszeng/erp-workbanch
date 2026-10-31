import { api, can } from "../lib/api.js";
import { esc, badge, toast, confirmBox, money } from "../lib/ui.js";

const yuan = (n) => `¥${money(Number(n) || 0)}`;
const blankItem = { item: "", note: "", need: "需要", spec: "", owner: "", owner_id: "", due: "", budget: "" };
let memberOptions = [];

function optHtml(opts, val) {
  return opts.map((o) => `<option value="${esc(o)}"${o === val ? " selected" : ""}>${esc(o)}</option>`).join("");
}

/** 一行需求的单元格。条目名做成无边框输入框：模板条目能改，新增条目能填，看着还像表格 */
function cells(it, locked) {
  const dis = locked ? " disabled" : "";
  // 归档后表单控件一律换成纯文本：禁用状态的输入框会带 placeholder，
  // 标了「不需要」的行空着就显示「规格 / 数量」，看着像漏填。空值统一显示 —。
  const plain = (v, moneyish) => (v
    ? `<span class="dmv">${esc(moneyish ? Number(v).toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : v)}</span>`
    : `<span class="dash">—</span>`);
  return `<td class="c-item">
      <input class="mini plain" data-f="item" value="${esc(it.item || "")}" placeholder="条目名称"${dis}>
      ${it.note ? `<div class="tip">${esc(it.note)}</div>` : ""}
      <input type="hidden" data-f="note" value="${esc(it.note || "")}">
    </td>
    <td><select class="mini" data-f="need"${dis}>${optHtml(["需要", "不需要"], it.need)}</select></td>
    <td>${locked ? plain(it.spec) : `<input class="mini" data-f="spec" value="${esc(it.spec || "")}" placeholder="规格 / 数量">`}</td>
    <td>${locked ? plain(it.owner) : `<select class="mini" data-f="owner_id">
          <option value="">请选择成员</option>
          ${memberOptions.map((u) => `<option value="${esc(String(u.id))}"${Number(it.owner_id) === Number(u.id) ? " selected" : ""}>${esc(u.name)}</option>`).join("")}
        </select>`}</td>
    <td>${locked ? plain(it.due) : `<input class="mini" type="date" data-f="due" value="${esc(it.due || "")}">`}</td>
    <td>${locked ? plain(it.budget, true) : `<input class="mini" data-f="budget" inputmode="decimal" value="${esc(it.budget || "")}" placeholder="0.00">`}</td>
    <td style="width:34px;text-align:center">${locked ? "" : '<button class="link del" data-del="1" title="删除该条">×</button>'}</td>`;
}

function groupPanel(grp, items, locked) {
  const need = items.filter((i) => i.need === "需要");
  const sum = need.reduce((s, i) => s + (Number(i.budget) || 0), 0);
  return `<div class="panel mt" data-panel="${esc(grp)}">
    <div class="panel-h"><h2>⭐ ${esc(grp)}</h2>
      <div><span class="hint">需要 ${need.length} 项 · 预算 ${yuan(sum)}</span></div></div>
    <div class="tw"><table>
      <thead><tr>
        <th>项目 / 业务提示</th><th style="width:84px">是否需要</th><th>规格数量</th>
        <th style="width:96px">负责人</th><th style="width:130px">交付时间</th>
        <th style="width:110px">预算金额</th><th style="width:34px"></th>
      </tr></thead>
      <tbody>${items.map((it) => `<tr data-grp="${esc(grp)}">${cells(it, locked)}</tr>`).join("")}
        ${locked ? "" : `<tr class="addrow"><td colspan="7">
          <button class="link" data-add="${esc(grp)}">+ 新增一行</button></td></tr>`}
      </tbody>
    </table></div>
  </div>`;
}

/** 按行收集：整单替换时以页面上的行为准 */
function collect(root) {
  const items = [];
  let blank = 0;
  root.querySelectorAll("tr[data-grp]").forEach((tr) => {
    const it = { grp: tr.dataset.grp };
    tr.querySelectorAll("[data-f]").forEach((el) => { it[el.dataset.f] = el.value; });
    const name = String(it.item || "").trim();
    if (!name) { blank++; return; }
    it.item = name;
    items.push(it);
  });
  return { items, blank };
}

function refreshHead(root) {
  const rows = [...root.querySelectorAll("tr[data-grp]")];
  const need = rows.filter((tr) => tr.querySelector('[data-f="need"]').value === "需要");
  const sum = need.reduce((s, tr) => s + (Number(tr.querySelector('[data-f="budget"]').value) || 0), 0);
  const el = root.querySelector("#dstat");
  if (el) el.textContent = `共 ${rows.length} 项（需要 ${need.length} 项）· 预算合计 ${yuan(sum)}`;
}

function wireRow(root, tr) {
  tr.querySelector("[data-del]")?.addEventListener("click", async () => {
    if (!tr.dataset.added) {
      const name = tr.querySelector('[data-f="item"]').value || "该条";
      if (!(await confirmBox(`删除「${name}」？保存后生效，可用「重置」恢复模板。`, { ok: "删除" }))) return;
    }
    tr.remove();
    refreshHead(root);
  });
  tr.querySelectorAll("input,select").forEach((el) => {
    el.addEventListener("input", () => refreshHead(root));
    el.addEventListener("change", () => refreshHead(root));
  });
}

function wireSheet(root, pid, d) {
  const locked = !!d.archived || !can("demand:write");
  if (locked) return;
  root.querySelectorAll("tr[data-grp]").forEach((tr) => wireRow(root, tr));
  root.querySelectorAll("[data-add]").forEach((btn) => {
    btn.onclick = () => {
      const grp = btn.dataset.add;
      const tbody = root.querySelector(`[data-panel="${grp}"] tbody`);
      const tr = document.createElement("tr");
      tr.dataset.grp = grp;
      tr.dataset.added = "1";
      tr.innerHTML = cells(blankItem, false);
      tbody.insertBefore(tr, tbody.querySelector(".addrow"));
      wireRow(root, tr);
      refreshHead(root);
      tr.querySelector('[data-f="item"]')?.focus();
    };
  });
}

function renderList(root) {
  return api.get("/api/demand").then((d) => {
    const built = d.projects.filter((p) => p.demandBuilt).length;
    const archived = d.projects.filter((p) => p.confirmed).length;
    const budget = d.projects.reduce((s, p) => s + (Number(p.budgetTotal) || 0), 0);
    const needAll = d.projects.reduce((s, p) => s + (p.needCount || 0), 0);

    root.innerHTML = `<div class="phead">
      <div><h2>会务需求确认</h2><p>四组清单：设计 / 制作 / 现场执行 / 其他 · 只在筹备 / 执行阶段填写，确认后归档到项目详情页，作为后续核销的依据</p></div>
      <div class="acts"></div>
    </div>
    <div class="grid g4">
      <div class="kpi"><div class="t">筹备 / 执行中</div><div class="v">${d.projects.length}<span class="u">个</span></div></div>
      <div class="kpi k2"><div class="t">已建需求单</div><div class="v">${built}<span class="u">个</span></div></div>
      <div class="kpi k4"><div class="t">已归档</div><div class="v">${archived}<span class="u">个</span></div></div>
      <div class="kpi k3"><div class="t">需求预算合计</div><div class="v">${yuan(budget).replace("¥", "")}<span class="u">元</span></div></div>
    </div>
    <div class="panel mt">
      <div class="panel-h"><h2>会议项目</h2><span class="hint">只列「筹备中 / 执行中」的项目；已归档的需求单到项目详情页的「会务需求」里看</span></div>
      ${table([{ t: "项目", w: "200px" }, { t: "协会", w: "120px" }, { t: "状态", w: "84px" },
        { t: "需求", w: "90px" }, { t: "预算金额", w: "120px" }, { t: "归档", w: "110px" }, { t: "操作", w: "90px" }],
        d.projects.map((p) => ({
          c: [`<a class="link" data-go="demand/${p.id}">${esc(p.name)}</a>`,
            esc(p.assoc || "—"),
            badge(p.status),
            p.demandBuilt
              ? `<b>${p.needCount}</b><span class="hint"> 项</span>`
              : '<span style="color:var(--mute)">未建单</span>',
            p.demandBuilt ? yuan(p.budgetTotal) : '<span style="color:var(--mute)">—</span>',
            p.confirmed
              ? `<span class="pos">已归档</span><div class="tip">${esc(p.confirmedBy || "")}</div>`
              : '<span style="color:var(--mute)">草稿</span>',
            `<button class="link" data-go="demand/${p.id}">去填写</button>`]
        })), { empty: "当前没有处于「筹备中 / 执行中」的项目" })}
      <div class="hint" style="padding:8px 14px">需要项合计 ${needAll} 项；预算只统计「需要」的条目，标了不需要的不计入。</div>
    </div>`;
  });
}

function renderSheet(root, pid) {
  return api.get(`/api/demand/${pid}`).then(async (d) => {
    memberOptions = can("demand:write") ? (await api.get("/api/users/assignable?assoc=" + encodeURIComponent(d.projectAssoc))).rows || [] : [];
    const writable = can("demand:write");
    const locked = !!d.archived || !writable;
    const total = d.groups.reduce((s, g) => s + d.items[g].length, 0);
    const need = d.groups.reduce((s, g) => s + d.items[g].filter((i) => i.need === "需要").length, 0);

    root.innerHTML = `<div class="phead">
      <div><h2>会务需求确认 · ${esc(d.projectName)}</h2>
        <p id="dstat">共 ${total} 项（需要 ${need} 项）· 预算合计 ${yuan(d.budgetTotal)}</p></div>
      <div class="acts">
        <button class="btn btn-o" data-go="demand">← 返回</button>
        ${writable && !d.archived ? '<button class="btn btn-p" id="save">保存</button>' : ""}
        ${writable && !d.archived ? '<button class="btn btn-g" id="confirm">确认并归档</button>' : ""}
        ${writable && d.archived ? '<button class="btn btn-o" id="unarchive">撤销归档</button>' : ""}
        ${writable && !d.archived ? '<button class="btn btn-o" id="reset">重置</button>' : ""}
        <button class="btn btn-o" id="export">导出 CSV</button>
      </div>
    </div>
    ${!d.archived && d.inDemandPhase === false
      // 会务需求是筹备 / 执行阶段的作业。项目已经过了这两个阶段还没归档，
      // 核销第 3 步就没有对照依据 —— 这里提示一句，但不硬拦（补确认总比缺依据好）。
      ? `<div class="gate">当前项目状态「${esc(d.projectStatus || "")}」，不在筹备 / 执行阶段。
          需求单仍可补确认 —— 核销第 3 步要拿这份清单做费用对照，缺了它核销会少一项依据。</div>`
      : ""}
    ${d.archived ? `<div class="banner ok">✓ 该会议会务需求已由 <b>${esc(d.confirmed_by || "")}</b> 于 ${esc(d.confirmed_at || "")} 确认并归档
      —— 已封存，后续核销以这份清单和预算金额为依据。${writable ? "如需修改，先「撤销归档」。" : ""}</div>` : ""}
    ${d.groups.map((g) => groupPanel(g, d.items[g], locked)).join("")}`;

    wireSheet(root, pid, d);
    if (!locked) refreshHead(root); // 归档态是纯文本，没有可统计的输入框

    const save = root.querySelector("#save");
    if (save) save.onclick = () => {
      const { items, blank } = collect(root);
      if (!items.length) return toast("至少要有一条需求", "warn");
      save.disabled = true;
      api.patch(`/api/demand/${pid}`, { items })
        .then(() => {
          toast(blank ? `已保存（${blank} 条未填名称已跳过）` : "会务需求已保存", "ok");
          return renderSheet(root, pid);
        })
        .catch((e) => { save.disabled = false; toast(e.message, "warn"); });
    };
    const cfm = root.querySelector("#confirm");
    if (cfm) cfm.onclick = async () => {
      const { items, blank } = collect(root);
      if (blank) return toast(`有 ${blank} 条未填名称，请先补上再归档`, "warn");
      if (!items.length) return toast("至少要有一条需求", "warn");
      if (!(await confirmBox("确认并归档后需求单将锁定，不能再修改（可撤销归档）。确认继续？", { ok: "确认归档" }))) return;
      try {
        await api.patch(`/api/demand/${pid}`, { items });
        await api.post(`/api/demand/${pid}/confirm`);
        toast("已确认并归档，后续核销以此为依据", "ok");
        await renderSheet(root, pid);
      } catch (e) { toast(e.message, "warn"); }
    };
    const un = root.querySelector("#unarchive");
    if (un) un.onclick = async () => {
      if (!(await confirmBox("撤销归档后需求单回到草稿可继续修改，核销将失去这份依据。确认撤销？", { ok: "撤销归档" }))) return;
      try {
        await api.post(`/api/demand/${pid}/unarchive`);
        toast("已撤销归档", "ok");
        await renderSheet(root, pid);
      } catch (e) { toast(e.message, "warn"); }
    };
    const rst = root.querySelector("#reset");
    if (rst) rst.onclick = async () => {
      if (!(await confirmBox("确认重置该会议的需求单？将清空所有明细并回到模板。", { ok: "重置" }))) return;
      try {
        await api.post(`/api/demand/${pid}/reset`);
        toast("已重置为模板", "ok");
        await renderSheet(root, pid);
      } catch (e) { toast(e.message, "warn"); }
    };
    const exp = root.querySelector("#export");
    if (exp) exp.onclick = async () => {
      try { await api.download(`/api/demand/${pid}/export`); toast("已开始导出", "ok"); }
      catch (e) { toast(e.message, "warn"); }
    };
  });
}

export async function render(root, params) {
  if (params && params[0]) return renderSheet(root, params[0]);
  return renderList(root);
}

/* 复用 ui.table / badge */
function table(cols, rows, opt = {}) {
  if (!rows.length) return `<div class="empty">${opt.empty || "暂无数据"}</div>`;
  const minw = cols.length >= 7 ? 900 : cols.length >= 5 ? 720 : 0;
  return `<div class="tw"><table${minw ? ` style="min-width:${minw}px"` : ""}>
  <thead><tr>${cols.map((c) => `<th${c.w ? ` style="width:${c.w}"` : ""}>${c.t}</th>`).join("")}</tr></thead>
  <tbody>${rows.map((r) => `<tr>${r.c.map((x, i) => `<td>${x}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`;
}
