import { api, can, state } from "../lib/api.js";
import { badge, bindPager, confirmBox, esc, formHtml, modal, money, pager, panel, readForm, table, toast, validate } from "../lib/ui.js";

const PAGE_SIZE = 50;
let filterStatus = "";
let curPage = 1;
// 只有「已核销」可付款：已结算 = 账目封账，已归档 = 卷宗封存
const PAYABLE = ["已核销"];

/**
 * 从工作台「待付款」待办点进来时 params[0] 是项目号。
 * 付款列表默认分页 50 条，目标那笔很可能不在第一页 —— 所以要按 pid 让后端过滤，
 * 而不是渲染完再找（找不到就成了「点了没反应」）。
 */
export async function render(root, params = []) {
  const focusPid = params[0] || "";
  const qs = new URLSearchParams();
  if (filterStatus) qs.set("status", filterStatus);
  if (focusPid) qs.set("pid", focusPid);
  qs.set("page", curPage);
  qs.set("size", PAGE_SIZE);

  const [pay, st, proj] = await Promise.all([
    api.get("/api/payments?" + qs.toString()),
    api.get("/api/settlements"),
    api.get("/api/projects")
  ]);
  const payableProjects = proj.rows.filter((p) => PAYABLE.includes(p.status));
  // KPI 全部用后端全量汇总：pay.rows 只是当前页
  const s = pay.summary || { pending: 0, approved: 0, pendingAmount: 0, approvedAmount: 0, paidAmount: 0 };
  const blocked = proj.rows.filter((p) => ["待核销", "执行中", "筹备中"].includes(p.status)).length;
  // 定位态下后端汇总也被 pid 过滤了 —— 不标一句，用户会把「待审批 0 笔」当成全局没有待审批
  const scopeNote = focusPid ? '<span style="font-weight:400;color:var(--mute)">（本项目）</span>' : "";

  root.innerHTML = `<div class="phead">
      <div><h2>付款与结算</h2><p>付款门禁：项目必须「已核销」才可提交付款；结算单生成后核销结论冻结</p></div>
      <div class="acts">
        <button class="btn btn-o" id="expPay">导出付款明细</button>
        <button class="btn btn-o" id="expSt">导出结算汇总</button>
        ${can("payment:create") ? '<button class="btn btn-p" id="newPay">+ 付款申请</button>' : ""}
      </div>
    </div>

    ${focusPid ? `<div class="locate">已定位到项目 <b class="mono">${esc(focusPid)}</b> 的付款记录
      <button class="link" data-go="finance">查看全部付款</button></div>` : ""}

    <div class="grid g4">
      <div class="kpi k3"><div class="t">待审批${scopeNote}</div><div class="v">${s.pending}<span class="u">笔</span></div>
        <div style="font-size:12px;color:var(--sub);margin-top:4px">¥${money(s.pendingAmount)}</div></div>
      <div class="kpi"><div class="t">已审批待付${scopeNote}</div><div class="v">${s.approved}<span class="u">笔</span></div>
        <div style="font-size:12px;color:var(--sub);margin-top:4px">¥${money(s.approvedAmount)}</div></div>
      <div class="kpi k2"><div class="t">已付款${scopeNote}</div><div class="v">¥${money(s.paidAmount)}</div></div>
      <div class="kpi k4"><div class="t">付款门禁锁定中</div><div class="v">${blocked}<span class="u">个项目</span></div>
        <div style="font-size:12px;color:var(--sub);margin-top:4px">未核销不可付款</div></div>
    </div>

    <div class="panel mt">
      <div class="panel-h"><h2>付款记录</h2><div><span class="hint">共 ${pay.total} 笔</span></div></div>
      <div class="tabs">${["", "待审批", "已审批", "已付款", "已驳回"].map((x) =>
        `<button data-st="${x}" class="${filterStatus === x ? "on" : ""}">${x || "全部"}</button>`).join("")}</div>
      ${table(
        [{ t: "付款单号", w: "112px" }, { t: "项目" }, { t: "类型", w: "84px" }, { t: "收款方", w: "150px" },
         { t: "金额", w: "96px", cls: "num" }, { t: "发票号", w: "96px" }, { t: "申请人", w: "70px" },
         { t: "状态", w: "78px" }, { t: "操作", w: "120px" }],
        pay.rows.map((y) => ({
          attrs: ` data-row="${y.id}" data-pid="${y.pid}"`,
          c: [`<span class="mono">${y.id}</span>`,
            `<a class="link" data-go="projects/${y.pid}">${esc(y.pname)}</a>
             <div style="font-size:11px;color:var(--mute)">${esc(y.pstatus)}</div>`,
            esc(y.type), esc(y.payee), `¥${money(y.amount)}`, `<span class="mono">${esc(y.invoice_no || "—")}</span>`,
            esc(y.req_user || ""), badge(y.status),
            `<div class="tacts">
              ${y.status === "待审批" && can("payment:approve") ? `<button class="link" data-ok="${y.id}">审批</button><button class="link danger" data-no="${y.id}">驳回</button>` : ""}
              ${y.status === "已审批" && can("payment:pay") ? `<button class="link" data-pay="${y.id}">付款</button>` : ""}
              ${y.status === "已付款" ? `<span style="font-size:11.5px;color:var(--mute)">${esc(y.paid_at || "")}</span>` : ""}
            </div>`]
        })), { empty: "暂无付款记录" })}
      ${pager(pay, { unit: "笔" })}
    </div>

    <div class="panel">
      <div class="panel-h"><h2>结算单</h2><div><span class="hint">${st.total ?? st.rows.length} 张 · 生成即冻结核销结论</span></div></div>
      ${table(
        [{ t: "结算单号", w: "112px" }, { t: "项目" }, { t: "收入", w: "100px", cls: "num" },
         { t: "支出", w: "100px", cls: "num" }, { t: "结余", w: "100px", cls: "num" },
         { t: "生成人", w: "76px" }, { t: "时间", w: "130px" }],
        st.rows.map((x) => ({
          c: [`<span class="mono">${x.id}</span>`, `<a class="link" data-go="projects/${x.pid}">${esc(x.name)}</a>`,
            `¥${money(x.income)}`, `¥${money(x.expense)}`,
            `<span class="${x.profit >= 0 ? "pos" : "neg"}">¥${money(x.profit)}</span>`,
            esc(x.created_by || ""), `<span class="mono">${esc(x.created_at)}</span>`]
        })), { empty: "暂无结算单" })}
    </div>

    <div class="foot-note">门禁说明：未通过 6 步核销的项目，付款接口会返回 <code>VERIFY_GATE</code> 并记录审计；
      已生成结算单的项目，核销结论与资料修改均被冻结（总管理员可例外操作，同样留痕）。</div>`;

  bindPager(root, (n) => { curPage = n; render(root, params); });
  root.querySelectorAll("[data-st]").forEach((b) => b.onclick = () => { filterStatus = b.dataset.st; curPage = 1; render(root, params); });
  root.querySelectorAll("[data-ok]").forEach((b) => b.onclick = () => act(root, b.dataset.ok, "approve"));
  root.querySelectorAll("[data-no]").forEach((b) => b.onclick = () => act(root, b.dataset.no, "reject"));
  root.querySelectorAll("[data-pay]").forEach((b) => b.onclick = () => act(root, b.dataset.pay, "pay"));
  root.querySelector("#expPay").onclick = () => dl("/api/export/payments");
  root.querySelector("#expSt").onclick = () => dl("/api/export/settlements");
  const np = root.querySelector("#newPay");
  if (np) np.onclick = () => openPay(root, payableProjects);

  if (focusPid) {
    const row = root.querySelector(`tr[data-pid="${focusPid}"]`);
    if (row) {
      row.classList.add("row-focus");
      row.scrollIntoView({ block: "center", behavior: "smooth" });
    } else {
      toast("该项目当前没有付款记录", "warn");
    }
  }
}

async function dl(path) {
  try { const r = await api.download(path); toast(`已导出 ${r.name}`, "ok"); }
  catch (e) { toast(e.message, "warn"); }
}

async function act(root, id, kind) {
  try {
    if (kind === "pay") {
      if (!await confirmBox(`确认对付款单 <b>${id}</b> 执行付款？`, { ok: "确认付款" })) return;
      const r = await api.post(`/api/payments/${id}/pay`, {});
      toast(r.message, "ok");
    } else {
      const r = await api.post(`/api/payments/${id}/approve`, { approve: kind === "approve" });
      toast(r.message, "ok");
    }
    await render(root);
  } catch (e) { toast(e.message, "warn"); }
}

function openPay(root, projects) {
  if (!projects.length) return toast("当前没有已核销项目可付款", "warn");
  const fields = [
    { k: "pid", l: "付款项目", t: "select", req: 1, opts: projects.map((p) => ({
        v: p.id,
        l: `${p.id} ${p.name}（预算 ¥${Number(p.budget).toLocaleString("zh-CN")}，已付 ¥${Number(p.paid_amt || 0).toLocaleString("zh-CN")}）`
      })) },
    { k: "type", l: "付款类型", t: "select", req: 1, opts: state.meta.paymentTypes },
    { k: "payee", l: "收款方", req: 1 },
    { k: "amount", l: "付款金额（元）", t: "number", req: 1 },
    { k: "invoice_no", l: "发票号" },
    { k: "remark", l: "备注", t: "textarea", full: 1, rows: 2 }
  ];
  const m = modal({ title: "付款申请", body: `<div class="gate ok" style="margin-bottom:12px"><b>核销门禁</b>仅列出「已核销」项目：未核销项目不可付款，已结算项目账目已封账，已归档项目卷宗已封存。<br><b>预算门禁</b>已占用（待审批 + 已审批 + 已付款）加本笔金额超过预算时，接口返回 <code>OVER_BUDGET</code>，需总管理员特批。</div>${formHtml(fields)}`,
    footer: `<button class="btn btn-o" data-x="0">取消</button><button class="btn btn-p" data-x="1">提交申请</button>` });
  m.querySelector('[data-x="0"]').onclick = () => m.classList.remove("open");
  m.querySelector('[data-x="1"]').onclick = async () => {
    if (!validate(m, fields)) return;
    try {
      const r = await api.post("/api/payments", readForm(m));
      toast(r.message, "ok");
      m.classList.remove("open");
      await render(root);
    } catch (e) { toast(e.message, "warn"); }
  };
}
