import { api, state } from "../lib/api.js";
import { badge, esc, kpi, money, panel, table } from "../lib/ui.js";
import { reachable } from "../lib/nav.js";

/**
 * 我的工作台。
 *
 * 只保留四块：KPI / 异常预警 / 我的待办 / 近期会议。
 * 「阶段分布」和「最近操作」按业务要求去掉 —— 前者在项目列表里按状态筛一次就有，
 * 后者与审计日志完全重复（审计日志还能按模块、按人、按时间查）。
 *
 * 「我的待办」独占整行、只放待办：待办是这一页唯一要动手的东西，
 * 跟「近期会议」挤成两栏时列被压窄，「时限」列会折成两行。
 */
/**
 * 待办点「处理」应该去哪。
 *
 * 这里不能简单拼 `${t.go}/${t.pid}`：路由表里没有 `approvals/:项目号`、`finance/:项目号`
 * 这些路径，拼出来匹配不上，route() 会把人丢回工作台 —— 表现就是「点了处理没反应」。
 * 每条按「点进去就能直接动手」选目标：
 *   审批 → 审批中心，按审批单号定位到那一行
 *   核销 → 核销看板（该项目的 6 步）
 *   付款 → 财务页，只列该项目的付款，直接看到「付款」按钮
 *   结算 / 归档 / 变更落账 → 项目详情页（「生成结算单」「归档」「执行落账」按钮在那里）
 */
function todoHref(t) {
  let target;
  switch (t.kind) {
    case "审批": target = `approvals/${t.ref || t.pid}`; break;
    case "核销": target = `verify/${t.pid}`; break;
    case "付款": target = `finance/${t.pid}`; break;
    case "结算":
    case "归档":
    case "变更落账": target = `projects/${t.pid}`; break;
    default: target = t.go || "dashboard";
  }
  return safeTarget(target, t.pid);
}

/** 预警同理：例外单待审批要落到审批中心并定位到该项目 */
function alertHref(a) {
  const target = a.go === "approvals" ? `approvals/${a.pid}` : `${a.go}${a.pid ? "/" + a.pid : ""}`;
  return safeTarget(target, a.pid);
}

/**
 * 兜底：目标页面这个角色进不去就别给按钮。
 *
 * 后端已经按「权限 + 模块」把预警收过一遍了，但前端不能只靠后端 ——
 * 角色矩阵一改、或者哪天新加一类待办，这里就会重新冒出「点了没反应」的死按钮。
 * 进不去的时候退到项目详情页（信息还在，能看能查），连项目详情都进不去就不渲染按钮。
 */
function safeTarget(target, pid) {
  if (reachable(target)) return target;
  const fallback = pid ? `projects/${pid}` : "";
  return reachable(fallback) ? fallback : "";
}

export async function render(root) {
  const d = await api.get("/api/dashboard");
  const total = Object.values(d.counts).reduce((a, b) => a + b, 0);

  root.innerHTML = `
  <div class="grid g4">
    ${kpi("在管会议", total, "场")}
    ${kpi("待核销", d.counts["待核销"] || 0, "个", "k3")}
    ${state.user.role === "user" ? "" : kpi("预算总额", `¥${money(d.budget)}`, "", "k2")}
    ${state.user.role === "user" ? "" : kpi("已付款", `¥${money(d.paid)}`, "", "k4")}
  </div>

  ${d.alerts.length ? `<div class="panel mt"><div class="panel-h"><h2>异常预警</h2>
      <div><span class="hint">${d.alerts.length} 条需要处理</span></div></div>
    <div style="display:flex;flex-direction:column;gap:8px">
      ${d.alerts.map((a) => {
        const href = alertHref(a);
        return `<div class="alert ${a.level === "紧急" ? "alert-r" : a.level === "重要" ? "alert-w" : "alert-g"}">
        <div style="flex:1"><b>${esc(a.level)}</b> · ${esc(a.text)}</div>
        ${href ? `<button class="btn btn-o btn-sm" data-go="${href}">去处理</button>` : ""}
      </div>`;
      }).join("")}
    </div></div>` : ""}

  <div class="mt">${panel("我的待办", `${d.todos.length} 项`, d.todos.length ? table(
    [{ t: "类型", w: "86px" }, { t: "事项" }, { t: "项目", w: "190px" }, { t: "时限", w: "132px" }, { t: "操作", w: "76px" }],
    d.todos.map((t) => ({
      c: [badge(t.kind === "审批" ? "待审批" : t.kind === "核销" ? "待核销" : t.kind === "结算" ? "已核销" : t.kind === "归档" ? "已结算" : "已审批"),
        `<b style="font-size:12.8px">${esc(t.title)}</b>`,
        `<span class="mono">${esc(t.pname || t.pid || "—")}</span>`,
        `<span style="font-size:12px;color:var(--sub)">${esc(t.sla || "")}</span>`,
        todoHref(t) ? `<button class="link" data-go="${todoHref(t)}">处理</button>` : `<span style="color:var(--mute)">—</span>`],
      attrs: ""
    })), { empty: "当前没有待办，保持这个状态" }) : `<div class="empty">当前没有待办</div>`,
    `<button class="btn btn-o btn-sm" data-go="flow">看全流程</button>`)}</div>

  <div class="mt">${panel("近期会议", "按会期排序", table(
    [{ t: "会期", w: "120px" }, { t: "会议" }, { t: "状态", w: "96px" }],
    d.upcoming.map((p) => ({
      c: [`<span class="mono">${esc(p.date)}</span>`,
        `<a class="link" data-go="projects/${p.id}">${esc(p.name)}</a>
         <div style="font-size:11.5px;color:var(--mute)">${esc(p.assoc)} · ${esc(p.owner || "")}</div>`,
        badge(p.status)]
    })), { empty: "近期没有排期会议" }))}</div>

  <div class="foot-note">当前登录：${esc(state.user.name)} · ${esc(state.role.name)} · 数据范围「${esc(state.role.scope)}」
    ${state.super ? "· 总管理员拥有全部模块与全部数据权限" : ""}</div>`;
}
