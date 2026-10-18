import { api, state } from "../lib/api.js";
import { badge, esc, kpi, money, panel, table, timeline, yuan } from "../lib/ui.js";

const STATUS_ORDER = ["草稿", "待审批", "已立项", "筹备中", "执行中", "待核销", "已核销", "已结算", "已归档"];

export async function render(root) {
  const d = await api.get("/api/dashboard");
  const total = Object.values(d.counts).reduce((a, b) => a + b, 0);

  root.innerHTML = `
  <div class="grid g4">
    ${kpi("在管会议", total, "场")}
    ${kpi("待核销", d.counts["待核销"] || 0, "个", "k3")}
    ${kpi("预算总额", `¥${money(d.budget)}`, "", "k2")}
    ${kpi("已付款", `¥${money(d.paid)}`, "", "k4")}
  </div>

  ${d.alerts.length ? `<div class="panel mt"><div class="panel-h"><h2>异常预警</h2>
      <div><span class="hint">${d.alerts.length} 条需要处理</span></div></div>
    <div style="display:flex;flex-direction:column;gap:8px">
      ${d.alerts.map((a) => `<div class="alert ${a.level === "紧急" ? "alert-r" : a.level === "重要" ? "alert-w" : "alert-g"}">
        <div style="flex:1"><b>${esc(a.level)}</b> · ${esc(a.text)}</div>
        <button class="btn btn-o btn-sm" data-go="${a.go}${a.pid ? "/" + a.pid : ""}">去处理</button>
      </div>`).join("")}
    </div></div>` : ""}

  <div class="grid g2 mt">
    <div>${panel("我的待办", `${d.todos.length} 项`, d.todos.length ? table(
      [{ t: "类型", w: "76px" }, { t: "事项" }, { t: "项目", w: "150px" }, { t: "时限", w: "110px" }, { t: "操作", w: "70px" }],
      d.todos.map((t) => ({
        c: [badge(t.kind === "审批" ? "待审批" : t.kind === "核销" ? "待核销" : t.kind === "结算" ? "已核销" : t.kind === "归档" ? "已结算" : "已审批"),
          `<b style="font-size:12.8px">${esc(t.title)}</b>`,
          `<span class="mono">${esc(t.pname || t.pid || "—")}</span>`,
          `<span style="font-size:12px;color:var(--sub)">${esc(t.sla || "")}</span>`,
          `<button class="link" data-go="${t.go}${t.pid ? "/" + t.pid : ""}">处理</button>`],
        attrs: ""
      })), { empty: "当前没有待办，保持这个状态" }) : `<div class="empty">当前没有待办</div>`,
      `<button class="btn btn-o btn-sm" data-go="flow">看全流程</button>`)}</div>

    <div>${panel("近期会议", "按会期排序", table(
      [{ t: "会期", w: "92px" }, { t: "会议" }, { t: "状态", w: "76px" }],
      d.upcoming.map((p) => ({
        c: [`<span class="mono">${esc(p.date)}</span>`,
          `<a class="link" data-go="projects/${p.id}">${esc(p.name)}</a>
           <div style="font-size:11.5px;color:var(--mute)">${esc(p.assoc)} · ${esc(p.owner || "")}</div>`,
          badge(p.status)]
      })), { empty: "近期没有排期会议" }))}</div>
  </div>

  <div class="grid g2 mt">
    <div>${panel("阶段分布", "点状态进列表", `<div style="display:flex;flex-direction:column;gap:9px">
      ${STATUS_ORDER.map((s) => {
        const c = d.counts[s] || 0;
        const pct = total ? Math.round((c / total) * 100) : 0;
        return `<div style="display:flex;align-items:center;gap:10px;font-size:12.5px">
          <span style="width:76px;color:var(--sub)">${s}</span>
          <div style="flex:1;height:7px;background:#eef2f7;border-radius:4px;overflow:hidden">
            <div style="width:${pct}%;height:100%;background:var(--blue);opacity:${0.35 + pct / 140}"></div></div>
          <b style="width:28px;text-align:right" class="num">${c}</b>
          <button class="link" data-go="projects">查看</button>
        </div>`;
      }).join("")}
    </div>`)}</div>

    <div>${panel("最近操作", "全量留痕见审计日志", timeline(d.recent),
      `<button class="btn btn-o btn-sm" data-go="audit">全部日志</button>`)}</div>
  </div>

  <div class="foot-note">当前登录：${esc(state.user.name)} · ${esc(state.role.name)} · 数据范围「${esc(state.role.scope)}」
    ${state.super ? "· 总管理员拥有全部模块与全部数据权限" : ""}</div>`;
}
