import { api, can, state } from "../lib/api.js";
import {
  badge, confirmBox, esc, formHtml, kv, modal, money, panel, promptBox, readForm, table, timeline, toast, validate, yuan
} from "../lib/ui.js";
import { bindFilePicker, fileUrl } from "../lib/upload.js";
import { openStepDetail } from "../lib/verify-detail.js";

const ORDER = ["草稿", "待审批", "已立项", "筹备中", "执行中", "待核销", "已核销", "已结算", "已归档"];
const PAYABLE = ["已核销"];
const TABS = [
  ["overview", "概览"], ["contracts", "合同"], ["payments", "付款"],
  ["verify", "核销"], ["materials", "材料"], ["team", "成员与授权"], ["timeline", "操作留痕"]
];
let tab = "overview";

export async function render(root, [pid]) {
  const d = await api.get(`/api/projects/${pid}`);
  const p = d.project;
  const canEdit = (state.super || state.user.role === "assoc") && (p.status !== "已归档" || state.super);

  root.innerHTML = `
  <div class="crumb"><a data-go="projects">会议项目</a> / <span class="mono">${p.id}</span></div>
  <div class="phead">
    <div>
      <h2>${esc(p.name)} ${badge(p.status)}</h2>
      <p>${esc(p.assoc)} · ${esc(p.form)} · ${esc(p.date)} 起 ${p.days} 天 · 负责人 ${esc(p.owner || "—")}</p>
    </div>
    <div class="acts">
      ${d.actions.map((a) => `<button class="btn ${a.enabled ? "btn-p" : "btn-o"}"
        data-act="${a.action}" ${a.enabled ? "" : "disabled"} title="${esc(a.reason || "")}">${a.label}</button>`).join("")}
      ${canEdit ? '<button class="btn btn-o" id="editBtn">编辑资料</button>' : ""}
      ${["已立项", "筹备中", "执行中"].includes(p.status) ? '<button class="btn btn-o" id="changeBtn">提交变更</button>' : ""}
    </div>
  </div>

  <div class="panel"><div class="steps">${ORDER.map((s, i) => {
    const cur = ORDER.indexOf(p.status);
    const cls = i < cur ? "done" : i === cur ? "cur" : "";
    return `${i ? '<span class="ln"></span>' : ""}<span class="st ${cls}"><i>${i < cur ? "✓" : i + 1}</i>${s}</span>`;
  }).join("")}</div></div>

  ${d.actions.some((a) => !a.enabled && a.reason) ? `<div class="gate mt"><b>当前不能推进的原因</b>
    ${d.actions.filter((a) => !a.enabled && a.reason).map((a) => `${a.label}：${esc(a.reason)}`).join("；")}</div>` : ""}

  <div class="tabs mt">${TABS.map(([k, n]) => `<button data-tab="${k}" class="${tab === k ? "on" : ""}">${n}${
    k === "verify" ? ` <span style="color:var(--mute)">${d.verification.passed}/6</span>` : ""}${
    k === "materials" ? ` <span style="color:var(--mute)">${8 - d.materialsStatus.missing.length}/8</span>` : ""}</button>`).join("")}</div>
  <div id="tabbody"></div>`;

  root.querySelectorAll("[data-tab]").forEach((b) => b.addEventListener("click", () => { tab = b.dataset.tab; render(root, [pid]); }));
  root.querySelectorAll("[data-act]").forEach((b) => b.addEventListener("click", () => doTransition(root, pid, b.dataset.act)));
  const eb = root.querySelector("#editBtn");
  if (eb) eb.onclick = () => openEdit(root, pid, p);
  const cb = root.querySelector("#changeBtn");
  if (cb) cb.onclick = () => openChange(root, pid);

  const body = root.querySelector("#tabbody");
  const fn = { overview: tabOverview, contracts: tabContracts, payments: tabPayments, verify: tabVerify, materials: tabMaterials, team: tabTeam, timeline: tabTimeline }[tab];
  body.innerHTML = fn(d, p);
  wire(root, pid, d, body);
}

/* ---------------- 概览 ---------------- */
function tabOverview(d, p) {
  const paid = d.paidTotal;
  const settle = d.settlement;
  const v = d.verification;
  const ms = d.materialsStatus;
  return `<div class="grid g2">
    <div>${panel("会议信息", "", kv([
      ["项目编号", `<span class="mono">${p.id}</span>`],
      ["会议名称", esc(p.name)],
      ["所属协会", esc(p.assoc)],
      ["会议形式", esc(p.form)],
      ["会期", `${esc(p.date)} · ${p.days} 天`],
      ["预计人数", `${p.people || 0} 人`],
      ["负责人", `${esc(p.owner || "—")} · ${esc(p.phone || "")}`],
      ["承办部门", esc(p.dept || "—")],
      ["预算", `<b class="num">¥${money(p.budget)}</b>`],
      ["初版议程", `<span style="white-space:pre-wrap">${esc(p.agenda || "—")}</span>`]
    ]))}</div>
    <div>
      ${panel("财务概览", "", `<div class="grid g3">
        <div class="kpi"><div class="t">预算</div><div class="v" style="font-size:18px">¥${money(p.budget)}</div></div>
        <div class="kpi k2"><div class="t">已付款</div><div class="v" style="font-size:18px">¥${money(paid)}</div></div>
        <div class="kpi k4"><div class="t">结余</div><div class="v" style="font-size:18px">¥${money(p.budget - paid)}</div></div>
      </div>
      <div style="margin-top:12px">${settle
        ? `<div class="gate ok"><b>结算单 ${settle.id} 已生成</b>
             收入 ¥${money(settle.income)} · 支出 ¥${money(settle.expense)} · 结余 ¥${money(settle.profit)}（${settle.created_at}）</div>`
        : `<div class="gate"><b>结算单未生成</b>核销 6 步全部通过后，由财务生成结算单；生成后核销结论冻结。</div>`}</div>
      <div style="margin-top:10px">${PAYABLE.includes(p.status)
        ? `<div class="gate ok"><b>付款门禁已放行</b>项目已完成核销，可提交付款申请。</div>`
        : `<div class="gate"><b>付款门禁锁定</b>当前状态「${p.status}」，6 步核销通过（已核销）后才可付款${p.status === "已结算" ? "；结算后账目已封账" : p.status === "已归档" ? "；归档后卷宗已封存" : ""}。</div>`}</div>
      `)}
      ${panel("流程门禁", "系统实时校验", `<div style="display:flex;flex-direction:column;gap:8px;font-size:12.5px">
        <div>${v.complete ? "✅" : "⛔"} 核销：${v.passed}/6 通过${v.openExceptions ? `，${v.openExceptions} 张例外单待审批` : ""}</div>
        <div>${settle ? "✅" : "⛔"} 结算：${settle ? "已生成 " + settle.id : "未生成"}</div>
        <div>${ms.ok ? "✅" : "⛔"} 归档材料：${8 - ms.missing.length}/8${ms.missing.length ? "，缺 " + ms.missing.join("、") : ""}</div>
      </div>`)}
    </div>
  </div>
  ${panel("立项审批记录", "", table(
    [{ t: "审批单" }, { t: "类型", w: "96px" }, { t: "金额", w: "96px" }, { t: "提交人", w: "80px" }, { t: "状态", w: "80px" }, { t: "审批人", w: "80px" }, { t: "时间", w: "130px" }],
    d.approvals.map((a) => ({ c: [a.id, a.type, `¥${money(a.amount)}`, esc(a.by_user || ""), badge(a.status), esc(a.decided_by || "—"), `<span class="mono">${esc(a.created_at)}</span>`] })),
    { empty: "暂无审批记录" }))}`;
}

/* ---------------- 合同 ---------------- */
const CONTRACT_LOCKED = ["已结算", "已归档"];
function tabContracts(d, p) {
  const locked = CONTRACT_LOCKED.includes(p.status);
  return panel("合同台账", `${d.contracts.length} 份${locked ? " · 已封存" : ""}`, table(
    [{ t: "合同编号", w: "112px" }, { t: "合同名称" }, { t: "签约方", w: "150px" }, { t: "金额", w: "100px", cls: "num" }, { t: "签署日期", w: "100px" }, { t: "状态", w: "80px" }, { t: "原件", w: "70px" }],
    d.contracts.map((c) => ({
      c: [`<span class="mono">${c.id}</span>`, esc(c.name), esc(c.vendor), `¥${money(c.amount)}`,
        `<span class="mono">${esc(c.sign_date || "—")}</span>`, badge(c.status),
        c.file_key
          ? (c.file_mime === "application/pdf"
              ? `<a class="link" href="${fileUrl(c.file_key)}" target="_blank" rel="noopener" title="${esc(c.file_name || "合同原件")}">PDF</a>`
              : `<a href="${fileUrl(c.file_key)}" target="_blank" rel="noopener" title="${esc(c.file_name || "合同原件")}"><img class="thumb" src="${fileUrl(c.file_key)}" alt=""></a>`)
          : '<span style="color:var(--mute)">—</span>']
    })),
    { empty: "暂无合同" }),
    locked ? `<span class="foot-note">项目${p.status === "已归档" ? "已归档，卷宗封存" : "已结算，台账封账"}，不可再录入合同</span>`
      : can("contract:write") ? '<button class="btn btn-p btn-sm" id="addContract">+ 录入合同</button>' : "");
}

/* ---------------- 付款 ---------------- */
function tabPayments(d, p) {
  const archived = p.status === "已归档";
  const payable = PAYABLE.includes(p.status);
  const gate = archived
    ? `<div class="gate" style="margin-bottom:12px"><b>卷宗已封存</b>项目已归档，不可再新增付款；历史付款记录仍可查阅。</div>`
    : p.status === "已结算"
      ? `<div class="gate" style="margin-bottom:12px"><b>账目已封账</b>结算单已生成，不可再新增付款；如需补付请走线下流程。</div>`
      : payable ? ""
      : `<div class="gate" style="margin-bottom:12px"><b>付款门禁锁定</b>
      项目状态「${p.status}」，按制度必须先完成 6 步核销并通过（已核销）才可付款。当前核销进度 ${d.verification.passed}/6。</div>`;
  return `${gate}
  ${panel("付款记录", `已付款 ¥${money(d.paidTotal)}`, table(
    [{ t: "付款单号", w: "112px" }, { t: "类型", w: "86px" }, { t: "收款方" }, { t: "金额", w: "100px", cls: "num" },
     { t: "发票号", w: "96px" }, { t: "申请人", w: "72px" }, { t: "状态", w: "80px" }, { t: "操作", w: "120px" }],
    d.payments.map((y) => ({
      c: [`<span class="mono">${y.id}</span>`, esc(y.type), esc(y.payee), `¥${money(y.amount)}`,
        `<span class="mono">${esc(y.invoice_no || "—")}</span>`, esc(y.req_user || ""), badge(y.status),
        `<div class="tacts">
          ${y.status === "待审批" && can("payment:approve") ? `<button class="link" data-pay-approve="${y.id}">审批</button>` : ""}
          ${y.status === "已审批" && can("payment:pay") ? `<button class="link" data-pay-pay="${y.id}">付款</button>` : ""}
          ${y.status === "待审批" && can("payment:approve") ? `<button class="link danger" data-pay-reject="${y.id}">驳回</button>` : ""}
        </div>`]
    })), { empty: "暂无付款记录" }),
    can("payment:create")
      ? `<button class="btn btn-p btn-sm" id="addPay" ${payable ? "" : `disabled title="${archived ? "项目已归档，不可新增付款" : "核销通过后才可付款"}"`}>+ 付款申请</button>`
      : "")}`;
}

/* ---------------- 核销 ---------------- */
function tabVerify(d, p) {
  const v = d.verification;
  const frozen = !!d.settlement;
  return `${panel("核销 6 步 SOP", `已通过 ${v.passed}/6 · ${v.openExceptions ? v.openExceptions + " 张例外单待审批" : "无未决例外"}`,
    `<div class="vsteps">${v.steps.map((s) => {
      const cls = s.result === "通过" || s.result === "已解例外" ? "s-pass" : s.result === "不通过" ? "s-fail" : "s-wait";
      const canJudge = can("verify:check") && !frozen && (p.status === "待核销" || (p.status === "已核销" && state.super));
      const prevUnjudged = v.steps.some((x) => x.no < s.no && x.result === "待判定");
      return `<div class="vstep ${cls}">
        <div class="vh"><span class="no">${s.no}</span><span class="nm">${esc(s.name)}</span>
          <span class="who">${esc(s.who)}</span></div>
        <div class="desc">${esc(s.desc)}</div>
        <div class="res">${badge(s.result)}
          ${s.remark ? `<span class="rm">${esc(s.remark)}</span>` : ""}
          ${s.checked_by ? `<span style="color:var(--mute)">· ${esc(s.checked_by)} ${esc(s.checked_at)}</span>` : ""}
          <div style="flex:1"></div>
          <button class="btn btn-o btn-sm" data-detail="${s.no}">详情</button>
          ${canJudge && s.result === "待判定" ? `<button class="btn btn-o btn-sm" data-judge="${s.no}" ${prevUnjudged ? "disabled title=\"必须按顺序判定\"" : ""}>判定</button>` : ""}
          ${canJudge && s.result !== "待判定" ? `<button class="btn btn-o btn-sm" data-judge="${s.no}">重新判定</button>` : ""}
        </div></div>`;
    }).join("")}</div>
    ${frozen ? '<div class="gate ok" style="margin-top:12px"><b>结论已冻结</b>结算单已生成，核销结论不可修改。</div>' : ""}
    ${p.status !== "待核销" && p.status !== "已核销" ? `<div class="gate" style="margin-top:12px"><b>当前状态不可判定</b>「${p.status}」项目需进入「待核销」后才能判定。</div>` : ""}`)}

  ${panel("例外单", `${v.exceptions.length} 张`, table(
    [{ t: "例外单号", w: "112px" }, { t: "步骤", w: "52px" }, { t: "原因" }, { t: "提交人", w: "76px" }, { t: "状态", w: "80px" }, { t: "审批人", w: "76px" }, { t: "操作", w: "80px" }],
    v.exceptions.map((e) => ({
      c: [`<span class="mono">${e.id}</span>`, `第 ${e.step_no} 步`, esc(e.reason), esc(e.created_by || ""), badge(e.status), esc(e.approved_by || "—"),
        e.status === "待审批" && can("verify:exception_approve")
          ? `<div class="tacts"><button class="link" data-ex-ok="${e.id}">通过</button><button class="link danger" data-ex-no="${e.id}">驳回</button></div>`
          : "—"]
    })), { empty: "无例外单" }),
    can("verify:exception") ? '<button class="btn btn-o btn-sm" id="addEx">+ 提交例外单</button>' : "")}`;
}

/* ---------------- 材料 ---------------- */
function tabMaterials(d, p) {
  const ms = d.materialsStatus;
  return panel("归档材料（必备 8 类）", `${8 - ms.missing.length}/8 齐备`, `
    <div class="chips">${ms.required.map((k) => `<span class="chip" style="${ms.have.includes(k) ? "border-color:#c9e8d4;background:#f4fbf6" : "border-color:#efdcc8;background:#fdf7f1"}">
      <i>${ms.have.includes(k) ? "✅" : "⛔"}</i><b>${esc(k)}</b></span>`).join("")}</div>
    ${table([{ t: "类别", w: "104px" }, { t: "材料名称" }, { t: "附件", w: "84px" }, { t: "版本", w: "56px" },
      { t: "上传人", w: "76px" }, { t: "时间", w: "130px" }, { t: "操作", w: "56px" }],
      d.materials.map((m) => ({
        c: [
          esc(m.kind), esc(m.name),
          m.file_key
            ? (m.file_mime === "application/pdf"
                ? `<a class="link" href="${fileUrl(m.file_key)}" target="_blank" rel="noopener">PDF</a>`
                : `<a href="${fileUrl(m.file_key)}" target="_blank" rel="noopener"><img class="thumb" src="${fileUrl(m.file_key)}" alt=""></a>`)
            : '<span style="color:var(--mute)">—</span>',
          esc(m.version || ""), esc(m.uploader || ""), `<span class="mono">${esc(m.created_at)}</span>`,
          can("material:write") && p.status !== "已归档" ? `<button class="link danger" data-del-mat="${m.id}">删除</button>` : "—"
        ]
      })),
      { empty: "暂无材料" })}`,
    can("material:write") && p.status !== "已归档" ? '<button class="btn btn-p btn-sm" id="addMat">+ 登记材料</button>' : "");
}

/* ---------------- 成员 ---------------- */
function tabTeam(d, p) {
  return `${panel("项目成员与授权", `${d.members.length} 人`, table(
    [{ t: "姓名", w: "90px" }, { t: "账号", w: "110px" }, { t: "系统角色", w: "130px" }, { t: "项目内角色", w: "100px" }, { t: "操作", w: "70px" }],
    d.members.map((m) => ({ c: [esc(m.name), `<span class="mono">${esc(m.username)}</span>`, esc((state.meta.roles.find((r) => r.key === m.role) || {}).name || m.role),
      esc(m.member_role || "成员"), can("project:member") ? `<button class="link danger" data-del-mem="${m.id}">移出</button>` : "—"] })),
    { empty: "暂无成员" }),
    can("project:member") ? '<button class="btn btn-p btn-sm" id="addMem">+ 增加成员</button>' : "")}
  ${panel("嘉宾", `${d.guests.length} 位`, table(
    [{ t: "姓名", w: "90px" }, { t: "单位" }, { t: "职务", w: "120px" }, { t: "状态", w: "80px" }],
    d.guests.map((g) => ({ c: [esc(g.name), esc(g.org), esc(g.title), badge(g.status)] })), { empty: "暂无嘉宾" }))}
  ${panel("任务", `${d.tasks.length} 项`, table(
    [{ t: "任务" }, { t: "负责人", w: "80px" }, { t: "截止", w: "96px" }, { t: "优先级", w: "66px" }, { t: "状态", w: "80px" }],
    d.tasks.map((t) => ({ c: [esc(t.name), esc(t.owner), `<span class="mono">${esc(t.due)}</span>`, esc(t.priority), badge(t.status)] })), { empty: "暂无任务" }))}`;
}

/* ---------------- 时间轴 ---------------- */
function tabTimeline(d) {
  return panel("操作留痕", `${d.timeline.length} 条`, timeline(d.timeline));
}

/* ---------------- 事件绑定 ---------------- */
function wire(root, pid, d, body) {
  body.querySelectorAll("[data-pay-approve]").forEach((b) => b.onclick = () => payAct(root, pid, b.dataset.payApprove, "approve"));
  body.querySelectorAll("[data-pay-reject]").forEach((b) => b.onclick = () => payAct(root, pid, b.dataset.payReject, "reject"));
  body.querySelectorAll("[data-pay-pay]").forEach((b) => b.onclick = () => payAct(root, pid, b.dataset.payPay, "pay"));
  body.querySelectorAll("[data-judge]").forEach((b) => b.onclick = () => openJudge(root, pid, Number(b.dataset.judge), d));
  // 核销 6 步的「详情」：判定前先把该核对的原始数据摆出来（与核销看板共用同一份实现）
  const canJudgeHere = can("verify:check") && !d.settlement
    && (d.project.status === "待核销" || (d.project.status === "已核销" && state.super));
  body.querySelectorAll("[data-detail]").forEach((b) => b.onclick = () =>
    openStepDetail(d, Number(b.dataset.detail), {
      canJudge: canJudgeHere,
      onJudge: (no) => openJudge(root, pid, no, d)
    }));
  body.querySelectorAll("[data-ex-ok]").forEach((b) => b.onclick = () => exDecide(root, pid, b.dataset.exOk, true));
  body.querySelectorAll("[data-ex-no]").forEach((b) => b.onclick = () => exDecide(root, pid, b.dataset.exNo, false));
  body.querySelectorAll("[data-del-mat]").forEach((b) => b.onclick = () => delMaterial(root, pid, b.dataset.delMat));
  body.querySelectorAll("[data-del-mem]").forEach((b) => b.onclick = () => delMember(root, pid, b.dataset.delMem));

  const ac = body.querySelector("#addContract"); if (ac) ac.onclick = () => openContract(root, pid);
  const ap = body.querySelector("#addPay"); if (ap) ap.onclick = () => openPay(root, pid, d);
  const ae = body.querySelector("#addEx"); if (ae) ae.onclick = () => openException(root, pid, d);
  const am = body.querySelector("#addMat"); if (am) am.onclick = () => openMaterial(root, pid);
  const amm = body.querySelector("#addMem"); if (amm) amm.onclick = () => openMember(root, pid, d);
}

async function refresh(root, pid) {
  await render(root, [pid]);
}

async function doTransition(root, pid, action) {
  if (["settle", "archive", "verify_pass"].includes(action)) {
    const ok = await confirmBox(
      action === "settle" ? "生成结算单后，核销结论将<b>永久冻结</b>，确认继续？"
        : action === "archive" ? "归档后数字卷宗封存，材料不可再修改，确认继续？"
          : "确认核销通过？通过后项目可进入结算与付款。",
      { ok: "确认", danger: action !== "verify_pass" });
    if (!ok) return;
  }
  try {
    const r = await api.post(`/api/projects/${pid}/transition`, { action });
    toast(r.message, "ok");
    await refresh(root, pid);
  } catch (e) {
    if (e.code === "GATE_BLOCKED") toast("门禁未通过：" + e.message, "warn");
    else toast(e.message, "warn");
  }
}

function openJudge(root, pid, no, d) {
  const step = d.verification.steps.find((s) => s.no === no);
  const m = modal({
    title: `第 ${no} 步 · ${step.name}`,
    body: `<div class="hint" style="margin-bottom:12px">${esc(step.desc)}</div>
      <div class="fld"><label>判定结果<span class="req">*</span></label>
        <select name="result"><option value="通过">通过</option><option value="不通过">不通过（自动生成例外单）</option></select></div>
      <div class="fld" style="margin-top:12px"><label>问题描述 / 备注</label>
        <textarea name="remark" rows="3" placeholder="判定不通过时必填，如：课件「XX」不在议程课题内"></textarea></div>`,
    footer: `<button class="btn btn-o" data-x="0">取消</button><button class="btn btn-p" data-x="1">提交判定</button>`
  });
  m.querySelector('[data-x="0"]').onclick = () => m.classList.remove("open");
  m.querySelector('[data-x="1"]').onclick = async () => {
    const v = readForm(m);
    if (v.result === "不通过" && !v.remark.trim()) { toast("判定不通过必须填写问题描述", "warn"); return; }
    try {
      const r = await api.post(`/api/projects/${pid}/verify/steps/${no}`, v);
      toast(r.message, "ok");
      m.classList.remove("open");
      await refresh(root, pid);
    } catch (e) { toast(e.message, "warn"); }
  };
}

async function exDecide(root, pid, id, ok) {
  const comment = await promptBox({ title: ok ? "通过例外单" : "驳回例外单", label: "审批意见", required: false, ph: ok ? "同意，补录议程后归档" : "请说明驳回理由" });
  if (comment === null) return;
  try {
    const r = await api.post(`/api/exceptions/${id}/decide`, { approve: ok, comment });
    toast(r.message, "ok");
    await refresh(root, pid);
  } catch (e) { toast(e.message, "warn"); }
}

async function payAct(root, pid, id, kind) {
  try {
    if (kind === "pay") {
      if (!await confirmBox(`确认对付款单 <b>${id}</b> 执行付款？付款后不可撤销。`, { ok: "确认付款" })) return;
      const r = await api.post(`/api/payments/${id}/pay`, {});
      toast(r.message, "ok");
    } else {
      const r = await api.post(`/api/payments/${id}/approve`, { approve: kind === "approve" });
      toast(r.message, "ok");
    }
    await refresh(root, pid);
  } catch (e) { toast(e.message, "warn"); }
}

function openContract(root, pid) {
  const fields = [
    { k: "name", l: "合同名称", req: 1, full: 1 },
    { k: "vendor", l: "签约方", req: 1 },
    { k: "amount", l: "合同金额（元）", t: "number", req: 1 },
    { k: "sign_date", l: "签署日期", t: "date" },
    { k: "status", l: "状态", t: "select", opts: ["草稿", "待签署", "已签署"] },
    {
      k: "file", l: "合同原件", t: "file", full: 1,
      accept: "image/jpeg,image/png,image/webp,image/gif,application/pdf",
      tip: "可上传盖章扫描件 PDF 或手机拍照件，单个不超过 8 MB。图片会在本地压缩后上传，PDF 原样保存。"
    }
  ];
  const m = modal({
    title: "录入合同", width: "620px", body: formHtml(fields),
    footer: `<button class="btn btn-o" data-x="0">取消</button><button class="btn btn-p" data-x="1">保存</button>`
  });

  let picked = null;
  bindFilePicker(m, "file", (f, err) => {
    if (err) { picked = null; toast(err, "warn"); return; }
    picked = f;
    const nameInput = m.querySelector('[name="name"]');
    if (nameInput && !nameInput.value.trim()) {
      nameInput.value = f.name.replace(/\.[^.]+$/, "").slice(0, 80);
    }
  });

  m.querySelector('[data-x="0"]').onclick = () => m.classList.remove("open");
  const btn = m.querySelector('[data-x="1"]');
  btn.onclick = async () => {
    if (!validate(m, fields)) return;
    const v = readForm(m);
    btn.disabled = true;
    try {
      let meta = {};
      if (picked) {
        btn.textContent = "上传中 0%";
        const up = await api.upload(picked, {
          onProgress: (p) => { btn.textContent = `上传中 ${Math.round(p * 100)}%`; }
        });
        meta = { file_key: up.key, file_name: up.name, file_size: up.size, file_mime: up.mime };
      }
      btn.textContent = "保存中…";
      const r = await api.post("/api/contracts", { ...v, ...meta, pid });
      // 附件回执和超预算预警都要说，不能因为预警把「原件已附上」吞掉
      const base = picked ? `${r.message}，原件已附上` : r.message;
      toast(r.warning ? `${base}；${r.warning}` : base, r.warning ? "warn" : "ok");
      m.classList.remove("open");
      tab = "contracts";
      await refresh(root, pid);
    } catch (e) {
      toast(e.message, "warn");
      btn.disabled = false;
      btn.textContent = "保存";
    }
  };
}

function openPay(root, pid, d) {
  const fields = [
    { k: "type", l: "付款类型", t: "select", req: 1, opts: state.meta.paymentTypes },
    { k: "payee", l: "收款方", req: 1 },
    { k: "amount", l: "付款金额（元）", t: "number", req: 1 },
    { k: "invoice_no", l: "发票号" },
    { k: "remark", l: "备注", t: "textarea", full: 1, rows: 2 }
  ];
  const m = modal({
    title: "付款申请",
    body: `<div class="gate ok" style="margin-bottom:12px"><b>核销门禁已通过</b>项目「${esc(d.project.name)}」当前状态「${d.project.status}」，允许付款。</div>${formHtml(fields)}`,
    footer: `<button class="btn btn-o" data-x="0">取消</button><button class="btn btn-p" data-x="1">提交申请</button>`
  });
  m.querySelector('[data-x="0"]').onclick = () => m.classList.remove("open");
  m.querySelector('[data-x="1"]').onclick = async () => {
    if (!validate(m, fields)) return;
    try {
      const r = await api.post("/api/payments", { ...readForm(m), pid });
      toast(r.message, "ok");
      m.classList.remove("open");
      tab = "payments";
      await refresh(root, pid);
    } catch (e) { toast(e.message, "warn"); }
  };
}

function openException(root, pid, d) {
  const fields = [
    { k: "step_no", l: "对应步骤", t: "select", req: 1, opts: d.verification.steps.map((s) => ({ v: s.no, l: `第 ${s.no} 步 · ${s.name}` })) },
    { k: "reason", l: "例外原因", t: "textarea", req: 1, full: 1, rows: 3 }
  ];
  const m = modal({ title: "提交例外单", body: `<div class="hint" style="margin-bottom:12px">例外单需财务审批通过后，对应步骤记为「已解例外」，方可继续核销。</div>${formHtml(fields)}`,
    footer: `<button class="btn btn-o" data-x="0">取消</button><button class="btn btn-p" data-x="1">提交</button>` });
  m.querySelector('[data-x="0"]').onclick = () => m.classList.remove("open");
  m.querySelector('[data-x="1"]').onclick = async () => {
    if (!validate(m, fields)) return;
    try {
      const r = await api.post(`/api/projects/${pid}/exceptions`, readForm(m));
      toast(r.message, "ok");
      m.classList.remove("open");
      await refresh(root, pid);
    } catch (e) { toast(e.message, "warn"); }
  };
}

function openMaterial(root, pid) {
  const fields = [
    { k: "kind", l: "材料类别", t: "select", req: 1, opts: state.meta.materialKinds },
    { k: "name", l: "材料名称", req: 1, ph: "如：签到表-终版.pdf" },
    { k: "version", l: "版本", v: "v1" },
    {
      k: "file", l: "附件", t: "file", full: 1,
      accept: "image/jpeg,image/png,image/webp,image/gif,application/pdf",
      tip: "支持 JPG / PNG / WebP / PDF，单张不超过 8 MB。图片会在本地自动压缩后再上传。"
    }
  ];
  const m = modal({
    title: "登记材料",
    width: "620px",
    body: `<div class="hint" style="margin-bottom:12px">登记后即计入 8 类齐备校验；带附件的材料可在列表中直接预览或下载。</div>${formHtml(fields)}`,
    footer: `<button class="btn btn-o" data-x="0">取消</button><button class="btn btn-p" data-x="1">保存</button>`
  });

  let picked = null;
  bindFilePicker(m, "file", (f, err) => {
    if (err) { picked = null; toast(err, "warn"); return; }
    picked = f;
    const nameInput = m.querySelector('[name="name"]');
    if (nameInput && !nameInput.value.trim()) nameInput.value = f.name;
  });

  m.querySelector('[data-x="0"]').onclick = () => m.classList.remove("open");
  const btn = m.querySelector('[data-x="1"]');
  btn.onclick = async () => {
    if (!validate(m, fields)) return;
    const v = readForm(m);
    if (!v.name && picked) v.name = picked.name;
    if (!String(v.name || "").trim()) { toast("请填写材料名称或选择附件", "warn"); return; }

    btn.disabled = true;
    try {
      let meta = {};
      if (picked) {
        btn.textContent = "上传中 0%";
        const up = await api.upload(picked, {
          onProgress: (p) => { btn.textContent = `上传中 ${Math.round(p * 100)}%`; }
        });
        meta = { file_key: up.key, file_name: up.name, file_size: up.size, file_mime: up.mime };
      }
      btn.textContent = "保存中…";
      const r = await api.post(`/api/projects/${pid}/materials`, { ...v, ...meta });
      toast(r.message || "已登记", "ok");
      m.classList.remove("open");
      await refresh(root, pid);
    } catch (e) {
      toast(e.message, "warn");
      btn.disabled = false;
      btn.textContent = "保存";
    }
  };
}

async function delMaterial(root, pid, id) {
  if (!await confirmBox("确认删除该材料？", { ok: "删除", danger: true })) return;
  try {
    await api.del(`/api/materials/${id}`);
    toast("已删除", "ok");
    await refresh(root, pid);
  } catch (e) { toast(e.message, "warn"); }
}

function openMember(root, pid, d) {
  const used = new Set(d.members.map((m) => m.id));
  api.get("/api/users").then(({ rows }) => {
    const cand = rows.filter((u) => !used.has(u.id) && u.active);
    const m = modal({
      title: "增加项目成员",
      body: `<div class="hint" style="margin-bottom:12px">成员可访问该项目数据（执行 / 财务 / 嘉宾视角的数据范围按成员关系计算）。</div>
        <div class="fld"><label>选择用户<span class="req">*</span></label>
          <select name="user_id">${cand.map((u) => `<option value="${u.id}">${esc(u.name)}（${esc(u.role_name)}）</option>`).join("")}</select></div>`,
      footer: `<button class="btn btn-o" data-x="0">取消</button><button class="btn btn-p" data-x="1">加入</button>`
    });
    m.querySelector('[data-x="0"]').onclick = () => m.classList.remove("open");
    m.querySelector('[data-x="1"]').onclick = async () => {
      try {
        const r = await api.post(`/api/projects/${pid}/members`, { user_id: Number(m.querySelector("select").value) });
        toast(r.message, "ok");
        m.classList.remove("open");
        await refresh(root, pid);
      } catch (e) { toast(e.message, "warn"); }
    };
  });
}

async function delMember(root, pid, uid) {
  if (!await confirmBox("确认将该成员移出项目？", { ok: "移出", danger: true })) return;
  try {
    await api.post(`/api/projects/${pid}/members`, { user_id: Number(uid), remove: true });
    toast("已移出", "ok");
    await refresh(root, pid);
  } catch (e) { toast(e.message, "warn"); }
}

function openEdit(root, pid, p) {
  const fields = [
    { k: "name", l: "会议名称", req: 1, full: 1 },
    { k: "assoc", l: "所属协会", t: "select", req: 1, opts: state.meta.assocs },
    { k: "form", l: "会议形式", t: "select", req: 1, opts: state.meta.forms },
    { k: "date", l: "会议日期", t: "date", req: 1 },
    { k: "days", l: "会期（天）", t: "number" },
    { k: "budget", l: "预算（元）", t: "number", req: 1 },
    { k: "people", l: "预计人数", t: "number" },
    { k: "owner", l: "负责人", req: 1 },
    { k: "phone", l: "联系电话" },
    { k: "dept", l: "承办部门", t: "select", opts: state.meta.depts },
    { k: "agenda", l: "议程要点", t: "textarea", req: 1, full: 1, rows: 3 }
  ];
  const m = modal({ title: "编辑项目资料", width: "640px", body: formHtml(fields, p),
    footer: `<button class="btn btn-o" data-x="0">取消</button><button class="btn btn-p" data-x="1">保存</button>` });
  m.querySelector('[data-x="0"]').onclick = () => m.classList.remove("open");
  m.querySelector('[data-x="1"]').onclick = async () => {
    if (!validate(m, fields)) return;
    try {
      const r = await api.patch(`/api/projects/${pid}`, readForm(m));
      toast(r.message, "ok");
      m.classList.remove("open");
      await refresh(root, pid);
    } catch (e) { toast(e.message, "warn"); }
  };
}

async function openChange(root, pid) {
  const v = await promptBox({ title: "提交变更申请", label: "变更内容", ph: "如：议程调整：新增 1 个圆桌环节", ok: "提交" });
  if (!v) return;
  try {
    const r = await api.post(`/api/projects/${pid}/change`, { title: v });
    toast(r.message, "ok");
    await refresh(root, pid);
  } catch (e) { toast(e.message, "warn"); }
}
