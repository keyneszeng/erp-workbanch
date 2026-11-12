import { api, can, state } from "../lib/api.js";
import { badge, confirmBox, esc, modal, money, panel, readForm, table, toast } from "../lib/ui.js";
import { exStepLabel, openStepDetail } from "../lib/verify-detail.js";
import {openOcrJudge} from "../lib/verify-ocr-judge.js";

export async function render(root, params) {
  if (params && params[0]) return renderOne(root, params[0]);
  await renderList(root);
}

async function renderList(root) {
  const d = await api.get("/api/projects");
  const rows = d.rows.filter((p) => ["待核销", "已核销", "已结算", "已归档"].includes(p.status));
  const pending = rows.filter((p) => p.status === "待核销").length;

  root.innerHTML = `<div class="phead">
      <div><h2>7步核销看板</h2><p>共7项，前4项必核、后3项按条件适用；核销项任意顺序办理 · 第5项按劳务表、第6项按会务需求、第7项按权益内容或权益照片自动决定是否必核</p></div>
      <div class="acts">${can("export:any") ? '<button class="btn btn-o" id="exp">导出核销明细</button>' : ""}</div>
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
          const total = p.v_total || 4;
          const pct = Math.round((passed / total) * 100);
          return {
            c: [`<span class="mono">${p.id}</span>`, esc(p.name), `<span class="mono">${esc(p.date)}</span>`, badge(p.status),
              `<div style="display:flex;align-items:center;gap:8px">
                 <div style="flex:1;height:6px;background:#eef2f7;border-radius:4px;overflow:hidden">
                   <div style="width:${pct}%;height:100%;background:${passed === total ? "var(--green)" : "var(--blue)"}"></div></div>
                 <b style="font-size:12px" class="num">${passed}/${total}</b></div>`,
              p.ex_open ? `<span class="badge b-orange">${p.ex_open} 待审批</span>` : '<span style="color:var(--mute)">—</span>',
              p.st_id ? `<span class="mono">${p.st_id}</span>` : '<span style="color:var(--mute)">未生成</span>',
              `<div class="tacts"><button class="link" data-go="verify/${p.id}">核销</button>
               <button class="link" data-go="projects/${p.id}">详情</button></div>`]
          };
        }), { empty: "暂无进入核销阶段的项目" })}
    </div>`;
  const expBtn = root.querySelector("#exp");
  if (expBtn) expBtn.onclick = async () => {
    try { const r = await api.download("/api/export/verify"); toast(`已导出 ${r.name}`, "ok"); }
    catch (e) { toast(e.message, "warn"); }
  };
}

async function renderOne(root, pid) {
  const d = await api.get(`/api/projects/${pid}/verify`);
  const p = d.project;
  const v = d.verification;
  const frozen = !!d.settlement;
  // 任何一份有效上传原件满足最低材料门槛；七项核销的适用检查和财务审批另行完成
  const materialReady = d.materialsStatus.ok;
  const canJudge = can("verify:check") && !frozen && materialReady
    && (p.status === "待核销" || (p.status === "已核销" && state.super));

  root.innerHTML = `
  <div class="crumb"><a data-go="verify">核销看板</a> / <span class="mono">${p.id}</span></div>
  <div class="phead">
    <div><h2>${esc(p.name)} ${badge(p.status)}</h2>
      <p>${esc(p.assoc)} · ${esc(p.date)} · 预算 ¥${money(p.budget)} · 负责人 ${esc(p.owner || "")}</p></div>
    <div class="acts">
      <button class="btn btn-o" data-go="projects/${p.id}">项目详情</button>
      ${can("verify:conclude") && p.status === "待核销"
        ? `<button class="btn ${v.complete && materialReady ? "btn-g" : "btn-o"}" id="passBtn"
             ${v.complete && materialReady ? "" : `disabled title="${materialReady ? "适用的核销项目未全部通过，或存在未决例外单" : "请至少上传一份材料附件"}"`}>核销通过</button>` : ""}
    </div>
  </div>

  ${materialReady ? "" : `<div class="gate" style="margin-bottom:12px"><b>尚无已上传材料原件</b>
    任意类别（含「权益照片」）上传至少一份有效附件即可满足材料条件，无需凑齐固定类别。
    <a class="link" data-go="projects/${p.id}">去项目详情的材料页签登记 →</a></div>`}
  <div class="panel">
    <div class="panel-h"><h2>七项核销 SOP · 原件识别与智能比对 → 人工判定</h2>
      <div><span class="hint">已通过 ${v.passed}/${v.total} 项必核${v.openExceptions ? ` · ${v.openExceptions} 张例外单待处理或待复核` : ""}</span></div></div>
    <div class="vsteps">${v.steps.map((s) => {
      const cls = s.required === false ? "s-na" : ["通过", "已解例外"].includes(s.result) ? "s-pass" : s.result === "不通过" ? "s-fail" : "s-wait";
      return `<div class="vstep ${cls}">
        <div class="vh"><span class="no">${s.no}</span><span class="nm">${esc(s.name)}</span><span class="who">${esc(s.who)}</span></div>
        <div class="desc">${esc(s.desc)}</div>
        <div class="res">${badge(s.required===false?"不适用":s.result)}
          ${s.remark ? `<span class="rm">${esc(s.remark)}</span>` : ""}
          ${s.checked_by ? `<span style="color:var(--mute)">· ${esc(s.checked_by)} ${esc(s.checked_at)}</span>` : ""}
          ${s.evidence ? `<span class="hint">· 核验依据及人工判定已留痕</span>` : ""}
          <div style="flex:1"></div>
          <button class="btn btn-o btn-sm" data-detail="${s.no}">详情</button>
          ${canJudge && s.required!==false && s.result === "待判定" ? `<button class="btn btn-o btn-sm" data-judge="${s.no}">判定</button>` : ""}
          ${canJudge && s.required!==false && s.result !== "待判定" ? `<button class="btn btn-o btn-sm" data-judge="${s.no}">重新判定</button>` : ""}
        </div></div>`;
    }).join("")}</div>
    ${frozen ? '<div class="gate ok" style="margin-top:12px"><b>结论已冻结</b>结算单已生成，核销结论不可修改。</div>' : ""}
    ${!["待核销", "已核销"].includes(p.status) ? `<div class="gate" style="margin-top:12px"><b>当前状态不可判定</b>只有「待核销」项目可判定，当前为「${p.status}」。</div>` : ""}
  </div>

  ${panel("例外单", `${v.exceptions.length} 张`, table(
    [{ t: "例外单号", w: "112px" }, { t: "步骤", w: "60px" }, { t: "原因" }, { t: "状态", w: "80px" }, { t: "审批人", w: "80px" }, { t: "操作", w: "110px" }],
    v.exceptions.map((e) => ({ c: [`<span class="mono">${e.id}</span>`, exStepLabel(e), esc(e.reason), badge(e.status), esc(e.approved_by || "—"),
      e.status === "待审批" && can("verify:exception_approve")
        ? `<div class="tacts"><button class="link" data-ex="${e.id}" data-ok="1">通过</button><button class="link danger" data-ex="${e.id}" data-ok="0">驳回</button></div>`
        : e.status === "待复核" && !e.resolved_at && can("verify:exception")
        ? `<button class="link" data-resolve="${e.id}">提交整改结果</button>`
        : e.status === "待复核" && e.resolved_at && Number(e.step_no)===0 && can("verify:exception_approve")
        ? `<button class="link" data-close-ex="${e.id}">财务确认闭环</button>`
        : e.status === "待复核" && e.resolved_at
        ? `<span class="hint">已整改，请回第 ${e.step_no} 步复核</span>` : "—"] })),
    { empty: "无例外单" }))}

  ${panel("材料上传情况", `已上传 ${d.materialsStatus.uploadedCount || 0} 份附件`,
    `<div class="chips">${d.materialsStatus.have.map(k=>`<span class="chip"><i>✓</i><b>${esc(k)}</b></span>`).join("")}</div>
    ${d.materialsStatus.ok
      ? '<div class="gate ok"><b>材料条件已满足</b>可以继续核销流程；无需固定类别齐全。</div>'
      : '<div class="gate"><b>还没有有效上传附件</b>请先上传至少一份任意类别的材料。</div>'}`)}
  `;

  root.querySelectorAll("[data-judge]").forEach((b) => b.onclick = () => openJudge(root, pid, Number(b.dataset.judge), d));
  root.querySelectorAll("[data-detail]").forEach((b) => b.onclick = () =>
    openStepDetail(d, Number(b.dataset.detail), {
      canJudge,
      onJudge: (no) => openJudge(root, pid, no, d)
    }));
  root.querySelectorAll("[data-ex]").forEach((b) => b.onclick = () => decideEx(root, pid, b.dataset.ex, b.dataset.ok === "1"));
  root.querySelectorAll("[data-resolve]").forEach(b=>b.onclick=()=>submitRemediation(root,pid,b.dataset.resolve,d));
  root.querySelectorAll("[data-close-ex]").forEach(b=>b.onclick=()=>closeGlobalException(root,pid,b.dataset.closeEx));
  const pb = root.querySelector("#passBtn");
  if (pb) pb.onclick = async () => {
    if (!await confirmBox("确认核销通过？通过后必须先完成付款申请、管理员审批和财务付款，才能生成结算单。", { ok: "确认通过" })) return;
    try { const r = await api.post(`/api/projects/${pid}/transition`, { action: "verify_pass" }); toast(r.message, "ok"); render(root, [pid]); }
    catch (e) { toast(e.message, "warn"); }
  };
}

function openJudge(root,pid,no,d){return openOcrJudge(pid,no,d,()=>render(root,[pid]));}

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

async function submitRemediation(root,pid,id,d){
  const candidates=(d.materials||[]).filter(m=>m.file_key);
  const m=modal({title:"例外单处理记录 · 证据与处理结果",
    body:`<div class="fld"><label>已上传整改证据原件（必选）</label>
       <select name="materialId"><option value="">选择附件材料</option>
       ${candidates.map(x=>`<option value="${x.id}">${esc(x.kind)} · ${esc(x.name)}</option>`).join("")}</select></div>
       <div class="fld"><label>处理结果与依据</label><textarea name="resolution" rows="4" placeholder="说明处理人完成了哪些整改、原件如何证明问题已修正"></textarea></div>`,
    footer:'<button class="btn btn-o" data-cancel>取消</button><button class="btn btn-p" data-save>记录整改并进入待复核</button>'});
  m.querySelector("[data-cancel]").onclick=()=>m.classList.remove("open");
  m.querySelector("[data-save]").onclick=async()=>{
    const materialId=Number(m.querySelector('[name="materialId"]').value);
    const resolution=m.querySelector('[name="resolution"]').value.trim();
    try{const r=await api.post("/api/exceptions/"+id+"/resolve",{materialId,resolution});
      toast(r.message,"ok");m.classList.remove("open");await render(root,[pid]);}
    catch(e){toast(e.message,"warn");}
  };
}
async function closeGlobalException(root,pid,id){
  const m=modal({title:"非步骤例外 · 财务确认闭环",
    body:'<div class="fld"><label>核验意见</label><textarea name="comment" rows="4" placeholder="写明证据审阅结果"></textarea></div>',
    footer:'<button class="btn btn-o" data-cancel>取消</button><button class="btn btn-p" data-save>确认闭环</button>'});
  m.querySelector("[data-cancel]").onclick=()=>m.classList.remove("open");
  m.querySelector("[data-save]").onclick=async()=>{
    try{const r=await api.post("/api/exceptions/"+id+"/close",{comment:m.querySelector('[name="comment"]').value.trim()});
      toast(r.message,"ok");m.classList.remove("open");await render(root,[pid]);}
    catch(e){toast(e.message,"warn");}
  };
}
