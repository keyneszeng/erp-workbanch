import { api, can, state } from "../lib/api.js";
import { badge, esc, money, panel, promptBox, table, toast } from "../lib/ui.js";

let view = "pending";

/**
 * 从工作台待办 / 预警点进来时 params[0] 带着目标（审批单号 A-xxx 或项目号 MP-xxx）。
 * 先确认目标在「待我审批」里，不在就退到「全部审批」—— 否则渲染完找不到那一行，
 * 用户会以为点了没反应。定位用高亮 + 滚到中间，不做过滤，避免他看不到上下文。
 */
function focusRow(root, key) {
  if (!key) return false;
  const row = root.querySelector(`tr[data-row="${key}"]`) || root.querySelector(`tr[data-pid="${key}"]`);
  if (!row) return false;
  row.classList.add("row-focus");
  row.scrollIntoView({ block: "center", behavior: "smooth" });
  return true;
}

export async function render(root, params = []) {
  const focus = params[0] || "";
  if (focus) {
    const probe = await api.get("/api/approvals?status=待审批");
    view = probe.rows.some((a) => a.id === focus || a.pid === focus) ? "pending" : "all";
  }
  root.innerHTML = `<div class="phead">
      <div><h2>审批中心</h2><p>立项 / 例外单 / 付款 / 变更 四类审批统一入口</p></div>
      <div class="acts"><button class="btn btn-o" id="exp">导出 CSV</button></div>
    </div>
    <div class="panel">
      <div class="tabs">
        <button data-v="pending" class="${view === "pending" ? "on" : ""}">待我审批</button>
        <button data-v="all" class="${view === "all" ? "on" : ""}">全部审批</button>
      </div>
      <div id="body"></div>
    </div>`;
  root.querySelectorAll("[data-v]").forEach((b) => b.addEventListener("click", () => { view = b.dataset.v; render(root, params); }));
  root.querySelector("#exp").onclick = async () => {
    try { const r = await api.download("/api/export/projects"); toast(`已导出 ${r.name}`, "ok"); }
    catch (e) { toast(e.message, "warn"); }
  };

  const d = await api.get("/api/approvals" + (view === "pending" ? "?status=待审批" : ""));
  const rows = d.rows;
  root.querySelector("#body").innerHTML = panel(
    view === "pending" ? "待审批" : "全部审批",
    `${rows.length} 条`,
    table(
      [{ t: "审批单", w: "112px" }, { t: "类型", w: "92px" }, { t: "标题" }, { t: "项目", w: "150px" },
       { t: "金额", w: "92px", cls: "num" }, { t: "提交人", w: "76px" }, { t: "时限", w: "92px" },
       { t: "状态", w: "80px" }, { t: "操作", w: "150px" }],
      rows.map((a) => ({
        attrs: ` data-row="${a.id}" data-pid="${a.pid || ""}"`,
        c: [
          `<span class="mono">${a.id}</span>`, esc(a.type), esc(a.title),
          a.pid ? `<a class="link" data-go="projects/${a.pid}">${esc(a.pname || a.pid)}</a>` : "—",
          a.amount ? `¥${money(a.amount)}` : "—", esc(a.by_user || ""), esc(a.sla || ""), badge(a.status),
          a.status === "待审批"
            ? `<div class="tacts">${canDecide(a.type) ? `<button class="link" data-ok="${a.id}">通过</button>
                 <button class="link danger" data-no="${a.id}">驳回</button>` : `<span class="link muted">无权限</span>`}</div>`
            : `<span style="font-size:12px;color:var(--mute)">${esc(a.decided_by || "")} ${esc(a.decided_at || "")}</span>`
        ]
      })),
      { empty: view === "pending" ? "没有待审批事项" : "暂无审批记录" })
  );

  root.querySelectorAll("[data-ok]").forEach((b) => b.onclick = () => decide(root, b.dataset.ok, true));
  root.querySelectorAll("[data-no]").forEach((b) => b.onclick = () => decide(root, b.dataset.no, false));

  if (focus && !focusRow(root, focus)) toast("这条审批可能已经处理过了，可在「全部审批」里查", "warn");
}

function canDecide(type) {
  if (state.super) return true;
  if (type === "立项审批" || type === "变更审批") return can("project:approve");
  if (type === "例外单审批") return can("verify:exception_approve");
  if (type === "付款审批") return can("payment:approve");
  return false;
}

async function decide(root, id, ok) {
  const comment = await promptBox({
    title: ok ? "审批通过" : "驳回",
    label: "审批意见" + (ok ? "（可选）" : ""),
    required: !ok,
    ph: ok ? "同意" : "请说明驳回理由",
    ok: ok ? "通过" : "驳回"
  });
  if (comment === null) return;
  try {
    const r = await api.post(`/api/approvals/${id}/decide`, { approve: ok, comment });
    toast(r.message, "ok");
    await render(root);
  } catch (e) { toast(e.message, "warn"); }
}
