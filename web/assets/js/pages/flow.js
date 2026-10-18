import { api, state } from "../lib/api.js";
import { esc, kpi, money, panel, table } from "../lib/ui.js";

export async function render(root) {
  const d = await api.get("/api/dashboard");
  const c = d.counts;
  const steps = [
    { s: "草稿", d: "立项材料未提交", gate: "议程 / 预算必填" },
    { s: "待审批", d: "协会管理员审批", gate: "提交即生成审批单" },
    { s: "已立项", d: "组建团队、授权成员", gate: "审批通过" },
    { s: "筹备中", d: "合同 / 嘉宾 / 议程 / 资源", gate: "合同金额确定" },
    { s: "执行中", d: "现场执行与取证", gate: "签到与凭证留存" },
    { s: "待核销", d: "6 步核销判定", gate: "顺序判定 + 例外闭环" },
    { s: "已核销", d: "可付款、可结算", gate: "6/6 通过" },
    { s: "已结算", d: "结算单已生成", gate: "结论冻结" },
    { s: "已归档", d: "数字卷宗封存", gate: "材料 8/8" }
  ];

  root.innerHTML = `<div class="phead">
      <div><h2>全流程总览</h2><p>9 状态 8 流转 · 3 道硬门禁 · 每个动作写入审计</p></div>
    </div>

    <div class="grid g4">
      ${kpi("在管会议", Object.values(c).reduce((a, b) => a + b, 0), "场")}
      ${kpi("待核销", c["待核销"] || 0, "个", "k3")}
      ${kpi("预算总额", `¥${money(d.budget)}`, "", "k2")}
      ${kpi("已付款", `¥${money(d.paid)}`, "", "k4")}
    </div>

    <div class="panel mt">
      <div class="panel-h"><h2>阶段流转</h2><span class="hint">括号内为当前停留项目数</span></div>
      <div class="flowwrap">${steps.map((x, i) => `
        <div class="fs" data-go="projects">
          <b>${i + 1}. ${x.s}</b><span>${x.d}</span><em>${c[x.s] || 0}</em>
        </div>`).join("")}</div>
      <div class="foot-note">正向 8 条流转：草稿→待审批→已立项→筹备中→执行中→待核销→已核销→已结算→已归档；
        另有「驳回」回退（待审批→草稿）。任何跨越状态的操作都会被业务层拒绝。</div>
    </div>

    ${panel("三道硬门禁", "绕过 UI 直接调接口同样会被拒", table(
      [{ t: "门禁", w: "150px" }, { t: "规则" }, { t: "拦截结果", w: "200px" }],
      [
        { c: ["<b>付款门禁</b>", "项目必须处于「已核销 / 已结算 / 已归档」，6 步核销未通过一律不可付款", "<code>409 VERIFY_GATE</code>"] },
        { c: ["<b>结算门禁</b>", "6 步全部判定通过、且无未审批例外单，才允许生成结算单", "<code>409 GATE_BLOCKED</code>"] },
        { c: ["<b>归档门禁</b>", "结算单已生成 + 材料 8 类齐备，才允许归档", "<code>409 GATE_BLOCKED</code>"] }
      ]))}

    <div class="grid g2 mt">
      <div>${panel("阶段职责", "", table(
        [{ t: "阶段", w: "84px" }, { t: "主责角色", w: "120px" }, { t: "出口条件" }],
        [
          { c: ["立项", "协会管理员", "审批通过 → 已立项"] },
          { c: ["筹备", "会务执行", "合同签署、议程定稿 → 执行中"] },
          { c: ["执行", "会务执行", "签到、凭证、课件齐备 → 待核销"] },
          { c: ["核销", "财务与核销", "6 步通过 + 例外闭环 → 已核销"] },
          { c: ["结算", "财务与核销", "结算单生成 → 已结算"] },
          { c: ["归档", "协会管理员 / 财务", "材料 8/8 → 已归档"] }
        ]))}</div>
      <div>${panel("角色与数据范围", "总管理员为超级角色", table(
        [{ t: "角色", w: "130px" }, { t: "数据范围", w: "110px" }, { t: "说明" }],
        state.meta.roles.map((r) => ({ c: [`<b>${esc(r.name)}</b>`, esc(r.scope), esc(r.desc)] }))))}</div>
    </div>

    ${panel("核销 6 步 SOP", "顺序不可跳过", table(
      [{ t: "步骤", w: "52px" }, { t: "名称", w: "190px" }, { t: "核对内容" }, { t: "判定角色", w: "110px" }],
      state.meta.verifySteps.map((s) => ({ c: [`<b>${s.no}</b>`, esc(s.name), esc(s.desc), esc(s.who)] }))))}

    <div class="foot-note">
      当前登录：${esc(state.user.name)} · ${esc(state.role.name)} · 数据范围「${esc(state.role.scope)}」
      ${state.super ? " · 总管理员拥有全部模块与全部数据权限" : ""}
    </div>`;
}
