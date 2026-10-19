import { api, can } from "../lib/api.js";
import { esc, badge, toast, confirmBox } from "../lib/ui.js";

function optHtml(opts, val) {
  return opts.map((o) => `<option value="${esc(o)}"${o === val ? " selected" : ""}>${esc(o)}</option>`).join("");
}

function groupPanel(grp, items, d) {
  const need = items.filter((i) => i.need === "需要").length;
  const done = items.filter((i) => i.need === "需要" && i.status === "已完成").length;
  const rows = items.map((it) => {
    const df = (f) => `data-df="${esc(grp)}@@${esc(it.item)}@@${f}"`;
    return `<tr>
      <td class="c-item"><b>${esc(it.item)}</b>${it.note ? `<div class="tip">${esc(it.note)}</div>` : ""}
        <input type="hidden" ${df("note")} value="${esc(it.note || "")}"></td>
      <td><select class="mini" ${df("need")}>${optHtml(d.needOptions, it.need)}</select></td>
      <td><input class="mini" ${df("spec")} value="${esc(it.spec || "")}" placeholder="规格 / 数量"></td>
      <td><input class="mini" ${df("owner")} value="${esc(it.owner || "")}" placeholder="负责人"></td>
      <td><input class="mini" type="date" ${df("due")} value="${esc(it.due || "")}"></td>
      <td><input class="mini" ${df("budget")} value="${esc(it.budget || "")}" placeholder="预算归属"></td>
      <td><input class="mini" ${df("attach")} value="${esc(it.attach || "")}" placeholder="附件"></td>
      <td><select class="mini" ${df("status")}>${optHtml(d.statusOptions, it.status)}</select></td>
    </tr>`;
  }).join("");
  return `<div class="panel mt">
    <div class="panel-h"><h2>⭐ ${esc(grp)}</h2>
      <div><span class="hint">需要 ${need} 项 · 已完成 ${done} 项</span></div></div>
    <div class="tw"><table>
      <thead><tr>
        <th>项目 / 业务提示</th><th style="width:84px">是否需要</th><th>规格数量</th>
        <th>负责人</th><th style="width:130px">交付时间</th><th>预算归属</th><th>附件</th><th style="width:96px">执行状态</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table></div>
  </div>`;
}

function renderList(root) {
  return api.get("/api/demand").then((d) => {
    const built = d.projects.filter((p) => p.demandBuilt).length;
    const confirmed = d.projects.filter((p) => p.confirmed).length;
    const totalNeed = d.projects.reduce((s, p) => s + (p.needCount || 0), 0);
    const totalDone = d.projects.reduce((s, p) => s + (p.doneCount || 0), 0);

    root.innerHTML = `<div class="phead">
      <div><h2>会务需求确认</h2><p>四组清单：设计 / 制作 / 现场执行 / 其他</p></div>
      <div class="acts"></div>
    </div>
    <div class="grid g4">
      <div class="kpi"><div class="t">在管项目</div><div class="v">${d.projects.length}<span class="u">个</span></div></div>
      <div class="kpi k2"><div class="t">已建需求单</div><div class="v">${built}<span class="u">个</span></div></div>
      <div class="kpi k4"><div class="t">已确认</div><div class="v">${confirmed}<span class="u">个</span></div></div>
      <div class="kpi k3"><div class="t">需要 / 已完成</div><div class="v">${totalNeed}<span class="u">/ ${totalDone}</span></div></div>
    </div>
    <div class="panel mt">
      <div class="panel-h"><h2>会议项目</h2><span class="hint">点「去填写」打开该会议的需求确认单</span></div>
      ${table([{ t: "项目", w: "200px" }, { t: "协会", w: "120px" }, { t: "状态", w: "84px" },
        { t: "需求进度", w: "150px" }, { t: "确认", w: "80px" }, { t: "操作", w: "90px" }],
        d.projects.map((p) => ({
          c: [`<a class="link" data-go="demand/${p.id}">${esc(p.name)}</a>`,
            esc(p.assoc || "—"),
            badge(p.status),
            p.demandBuilt
              ? `<b class="${p.needCount === p.doneCount ? "pos" : "orange"}">${p.doneCount}/${p.needCount}</b>`
              : '<span style="color:var(--mute)">未建单</span>',
            p.confirmed ? badge("已确认") : '<span style="color:var(--mute)">草稿</span>',
            `<button class="link" data-go="demand/${p.id}">去填写</button>`]
        })), { empty: "暂无项目" })}
    </div>`;
  });
}

function renderSheet(root, pid) {
  return api.get(`/api/demand/${pid}`).then((d) => {
    const total = d.groups.reduce((s, g) => s + d.items[g].length, 0);
    const need = d.groups.reduce((s, g) => s + d.items[g].filter((i) => i.need === "需要").length, 0);
    const done = d.groups.reduce((s, g) => s + d.items[g].filter((i) => i.need === "需要" && i.status === "已完成").length, 0);
    const writable = can("demand:write");

    root.innerHTML = `<div class="phead">
      <div><h2>会务需求确认 · ${esc(d.projectName)}</h2>
        <p>${d.confirmed ? "需求单已确认" : "草稿"} · 共 ${total} 项（需要 ${need} / 已完成 ${done}）</p></div>
      <div class="acts">
        <button class="btn btn-o" data-go="demand">← 返回</button>
        ${writable ? '<button class="btn btn-p" id="save">保存</button>' : ""}
        ${writable && !d.confirmed ? '<button class="btn btn-g" id="confirm">确认需求单</button>' : ""}
        ${writable ? '<button class="btn btn-o" id="reset">重置</button>' : ""}
        <button class="btn btn-o" id="export">导出 CSV</button>
      </div>
    </div>
    ${d.confirmed ? `<div class="banner ok">✓ 该会议会务需求已由 ${esc(d.confirmed_by || "")} 于 ${esc(d.confirmed_at || "")} 确认</div>` : ""}
    ${d.groups.map((g) => groupPanel(g, d.items[g], d)).join("")}`;

    const save = root.querySelector("#save");
    if (save) save.onclick = () => doSave(root, pid, d);
    const cfm = root.querySelector("#confirm");
    if (cfm) cfm.onclick = async () => {
      try {
        await api.post(`/api/demand/${pid}/confirm`);
        toast("已确认会务需求", "ok");
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

function doSave(root, pid, d) {
  const items = [];
  const map = {};
  root.querySelectorAll("[data-df]").forEach((el) => {
    const [grp, item, field] = el.dataset.df.split("@@");
    const key = `${grp}@@${item}`;
    if (!map[key]) { map[key] = { grp, item, note: "" }; items.push(map[key]); }
    map[key][field] = el.value;
  });
  api.patch(`/api/demand/${pid}`, { items }).then(() => {
    toast("会务需求已保存", "ok");
    return renderSheet(root, pid);
  }).catch((e) => toast(e.message, "warn"));
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
