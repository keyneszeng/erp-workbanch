import { api, can, state } from "../lib/api.js";
import { badge, confirmBox, esc, modal, money, panel, readForm, table, toast } from "../lib/ui.js";

export async function render(root, params) {
  if (params && params[0]) return renderOne(root, params[0]);
  await renderList(root);
}

async function renderList(root) {
  const d = await api.get("/api/projects");
  const rows = d.rows.filter((p) => ["待核销", "已核销", "已结算", "已归档"].includes(p.status));
  const pending = rows.filter((p) => p.status === "待核销").length;

  root.innerHTML = `<div class="phead">
      <div><h2>核销看板</h2><p>6 步 SOP 顺序判定 · 例外单闭环 · 核销是付款的唯一前置门</p></div>
      <div class="acts"><button class="btn btn-o" id="exp">导出核销明细</button></div>
    </div>
    <div class="grid g4">
      <div class="kpi k3"><div class="t">待核销</div><div class="v">${pending}<span class="u">个</span></div></div>
      <div class="kpi"><div class="t">已核销</div><div class="v">${rows.filter((p) => p.status === "已核销").length}<span class="u">个</span></div></div>
      <div class="kpi k2"><div class="t">已结算</div><div class="v">${rows.filter((p) => p.status === "已结算").length}<span class="u">个</span></div></div>
      <div class="kpi k4"><div class="t">已归档</div><div class="v">${rows.filter((p) => p.status === "已归档").length}<span class="u">个</span></div></div>
    </div>
    <div class="panel mt"><div class="panel-h"><h2>核销项目</h2><span class="hint">${rows.length} 个项目</span></div>
      ${table(
        [{ t: "编号", w: "112px" }, { t: "会议名称" }, { t: "会期", w: "92px" }, { t: "状态", w: "84px" },
         { t: "核销进度", w: "150px" }, { t: "例外单", w: "76px" }, { t: "结算单", w: "112px" }, { t: "操作", w: "96px" }],
        rows.map((p) => {
          const passed = p.v_passed || 0;
          const pct = Math.round((passed / 6) * 100);
          return {
            c: [`<span class="mono">${p.id}</span>`, esc(p.name), `<span class="mono">${esc(p.date)}</span>`, badge(p.status),
              `<div style="display:flex;align-items:center;gap:8px">
                 <div style="flex:1;height:6px;background:#eef2f7;border-radius:4px;overflow:hidden">
                   <div style="width:${pct}%;height:100%;background:${passed === 6 ? "var(--green)" : "var(--blue)"}"></div></div>
                 <b style="font-size:12px" class="num">${passed}/6</b></div>`,
              p.ex_open ? `<span class="badge b-orange">${p.ex_open} 待审批</span>` : '<span style="color:var(--mute)">—</span>',
              p.st_id ? `<span class="mono">${p.st_id}</span>` : '<span style="color:var(--mute)">未生成</span>',
              `<div class="tacts"><button class="link" data-go="verify/${p.id}">核销</button>
               <button class="link" data-go="projects/${p.id}">详情</button></div>`]
          };
        }), { empty: "暂无进入核销阶段的项目" })}
    </div>`;
  root.querySelector("#exp").onclick = async () => {
    try { const r = await api.download("/api/export/verify"); toast(`已导出 ${r.name}`, "ok"); }
    catch (e) { toast(e.message, "warn"); }
  };
}

async function renderOne(root, pid) {
  const d = await api.get(`/api/projects/${pid}/verify`);
  const p = d.project;
  const v = d.verification;
  const frozen = !!d.settlement;
  const canJudge = can("verify:check") && !frozen && (p.status === "待核销" || (p.status === "已核销" && state.super));

  root.innerHTML = `
  <div class="crumb"><a data-go="verify">核销看板</a> / <span class="mono">${p.id}</span></div>
  <div class="phead">
    <div><h2>${esc(p.name)} ${badge(p.status)}</h2>
      <p>${esc(p.assoc)} · ${esc(p.date)} · 预算 ¥${money(p.budget)} · 负责人 ${esc(p.owner || "")}</p></div>
    <div class="acts">
      <button class="btn btn-o" data-go="projects/${p.id}">项目详情</button>
      ${can("verify:conclude") && p.status === "待核销"
        ? `<button class="btn ${v.complete ? "btn-g" : "btn-o"}" id="passBtn" ${v.complete ? "" : 'disabled title="6 步未全部通过，或存在未决例外单"'}>核销通过</button>` : ""}
    </div>
  </div>

  <div class="panel">
    <div class="panel-h"><h2>6 步核销 SOP</h2>
      <div><span class="hint">已通过 ${v.passed}/6${v.openExceptions ? ` · ${v.openExceptions} 张例外单待审批` : ""}</span></div></div>
    <div class="vsteps">${v.steps.map((s) => {
      const cls = ["通过", "已解例外"].includes(s.result) ? "s-pass" : s.result === "不通过" ? "s-fail" : "s-wait";
      const prevUnjudged = v.steps.some((x) => x.no < s.no && x.result === "待判定");
      return `<div class="vstep ${cls}">
        <div class="vh"><span class="no">${s.no}</span><span class="nm">${esc(s.name)}</span><span class="who">${esc(s.who)}</span></div>
        <div class="desc">${esc(s.desc)}</div>
        <div class="res">${badge(s.result)}
          ${s.remark ? `<span class="rm">${esc(s.remark)}</span>` : ""}
          ${s.checked_by ? `<span style="color:var(--mute)">· ${esc(s.checked_by)} ${esc(s.checked_at)}</span>` : ""}
          <div style="flex:1"></div>
          ${canJudge && s.result === "待判定" ? `<button class="btn btn-o btn-sm" data-judge="${s.no}" ${prevUnjudged ? 'disabled title="必须按顺序判定"' : ""}>判定</button>` : ""}
          ${canJudge && s.result !== "待判定" ? `<button class="btn btn-o btn-sm" data-judge="${s.no}">重新判定</button>` : ""}
        </div></div>`;
    }).join("")}</div>
    ${frozen ? '<div class="gate ok" style="margin-top:12px"><b>结论已冻结</b>结算单已生成，核销结论不可修改。</div>' : ""}
    ${!["待核销", "已核销"].includes(p.status) ? `<div class="gate" style="margin-top:12px"><b>当前状态不可判定</b>只有「待核销」项目可判定，当前为「${p.status}」。</div>` : ""}
  </div>

  ${panel("例外单", `${v.exceptions.length} 张`, table(
    [{ t: "例外单号", w: "112px" }, { t: "步骤", w: "60px" }, { t: "原因" }, { t: "状态", w: "80px" }, { t: "审批人", w: "80px" }, { t: "操作", w: "110px" }],
    v.exceptions.map((e) => ({ c: [`<span class="mono">${e.id}</span>`, `第 ${e.step_no} 步`, esc(e.reason), badge(e.status), esc(e.approved_by || "—"),
      e.status === "待审批" && can("verify:exception_approve")
        ? `<div class="tacts"><button class="link" data-ex="${e.id}" data-ok="1">通过</button><button class="link danger" data-ex="${e.id}" data-ok="0">驳回</button></div>` : "—"] })),
    { empty: "无例外单" }))}

  ${panel("材料齐备情况", `${8 - d.materialsStatus.missing.length}/8`, `<div class="chips">
    ${d.materialsStatus.required.map((k) => `<span class="chip" style="${d.materialsStatus.have.includes(k) ? "border-color:#c9e8d4;background:#f4fbf6" : "border-color:#efdcc8;background:#fdf7f1"}">
      <i>${d.materialsStatus.have.includes(k) ? "✅" : "⛔"}</i><b>${esc(k)}</b></span>`).join("")}</div>
    ${d.materialsStatus.missing.length ? `<div class="gate"><b>归档材料缺 ${d.materialsStatus.missing.length} 类</b>${d.materialsStatus.missing.join("、")}（归档前必须补齐）</div>` : ""}`)}`;

  root.querySelectorAll("[data-judge]").forEach((b) => b.onclick = () => openJudge(root, pid, Number(b.dataset.judge), d));
  root.querySelectorAll("[data-ex]").forEach((b) => b.onclick = () => decideEx(root, pid, b.dataset.ex, b.dataset.ok === "1"));
  const pb = root.querySelector("#passBtn");
  if (pb) pb.onclick = async () => {
    if (!await confirmBox("确认核销通过？通过后项目进入「已核销」，可结算与付款。", { ok: "确认通过" })) return;
    try { const r = await api.post(`/api/projects/${pid}/transition`, { action: "verify_pass" }); toast(r.message, "ok"); render(root, [pid]); }
    catch (e) { toast(e.message, "warn"); }
  };
}

function openJudge(root, pid, no, d) {
  const s = d.verification.steps.find((x) => x.no === no);
  const m = modal({
    title: `第 ${no} 步 · ${s.name}`,
    body: `<div class="hint" style="margin-bottom:12px">${esc(s.desc)}</div>
      <div class="fld"><label>判定结果<span class="req">*</span></label>
        <select name="result"><option value="通过">通过</option><option value="不通过">不通过（自动生成例外单）</option></select></div>
      <div class="fld" style="margin-top:12px"><label>问题描述 / 备注</label>
        <textarea name="remark" rows="3" placeholder="判定不通过时必填"></textarea></div>`,
    footer: `<button class="btn btn-o" data-x="0">取消</button><button class="btn btn-p" data-x="1">提交判定</button>`
  });
  m.querySelector('[data-x="0"]').onclick = () => m.classList.remove("open");
  m.querySelector('[data-x="1"]').onclick = async () => {
    const val = readForm(m);
    if (val.result === "不通过" && !val.remark.trim()) return toast("判定不通过必须填写问题描述", "warn");
    try {
      const r = await api.post(`/api/projects/${pid}/verify/steps/${no}`, val);
      toast(r.message, "ok");
      m.classList.remove("open");
      render(root, [pid]);
    } catch (e) { toast(e.message, "warn"); }
  };
}

async function decideEx(root, pid, id, ok) {
  const m = modal({
    title: ok ? "通过例外单" : "驳回例外单",
    body: `<div class="fld"><label>审批意见</label><textarea name="comment" rows="3" placeholder="${ok ? "同意，补录议程" : "请说明驳回理由"}"></textarea></div>`,
    footer: `<button class="btn btn-o" data-x="0">取消</button><button class="btn btn-p" data-x="1">${ok ? "通过" : "驳回"}</button>`
  });
  m.querySelector('[data-x="0"]').onclick = () => m.classList.remove("open");
  m.querySelector('[data-x="1"]').onclick = async () => {
    try {
      const r = await api.post(`/api/exceptions/${id}/decide`, { approve: ok, comment: readForm(m).comment });
      toast(r.message, "ok");
      m.classList.remove("open");
      render(root, [pid]);
    } catch (e) { toast(e.message, "warn"); }
  };
}
