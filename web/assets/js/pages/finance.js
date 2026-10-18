import { api, can, state } from "../lib/api.js";
import { badge, confirmBox, esc, formHtml, modal, money, panel, readForm, table, toast, validate } from "../lib/ui.js";

let filterStatus = "";
const PAYABLE = ["已核销", "已结算", "已归档"];

export async function render(root) {
  const [pay, st, proj] = await Promise.all([
    api.get("/api/payments" + (filterStatus ? `?status=${encodeURIComponent(filterStatus)}` : "")),
    api.get("/api/settlements"),
    api.get("/api/projects")
  ]);
  const payableProjects = proj.rows.filter((p) => PAYABLE.includes(p.status));
  const all = pay.rows;
  const pendingAmt = all.filter((r) => r.status === "待审批").reduce((s, r) => s + r.amount, 0);
  const approvedAmt = all.filter((r) => r.status === "已审批").reduce((s, r) => s + r.amount, 0);
  const paidAmt = all.filter((r) => r.status === "已付款").reduce((s, r) => s + r.amount, 0);
  const blocked = proj.rows.filter((p) => ["待核销", "执行中", "筹备中"].includes(p.status)).length;

  root.innerHTML = `<div class="phead">
      <div><h2>付款与结算</h2><p>付款门禁：项目必须「已核销」才可提交付款；结算单生成后核销结论冻结</p></div>
      <div class="acts">
        <button class="btn btn-o" id="expPay">导出付款明细</button>
        <button class="btn btn-o" id="expSt">导出结算汇总</button>
        ${can("payment:create") ? '<button class="btn btn-p" id="newPay">+ 付款申请</button>' : ""}
      </div>
    </div>

    <div class="grid g4">
      <div class="kpi k3"><div class="t">待审批</div><div class="v">${all.filter((r) => r.status === "待审批").length}<span class="u">笔</span></div>
        <div style="font-size:12px;color:var(--sub);margin-top:4px">¥${money(pendingAmt)}</div></div>
      <div class="kpi"><div class="t">已审批待付</div><div class="v">${all.filter((r) => r.status === "已审批").length}<span class="u">笔</span></div>
        <div style="font-size:12px;color:var(--sub);margin-top:4px">¥${money(approvedAmt)}</div></div>
      <div class="kpi k2"><div class="t">已付款</div><div class="v">¥${money(paidAmt)}</div></div>
      <div class="kpi k4"><div class="t">付款门禁锁定中</div><div class="v">${blocked}<span class="u">个项目</span></div>
        <div style="font-size:12px;color:var(--sub);margin-top:4px">未核销不可付款</div></div>
    </div>

    <div class="panel mt">
      <div class="panel-h"><h2>付款记录</h2><div><span class="hint">${all.length} 笔</span></div></div>
      <div class="tabs">${["", "待审批", "已审批", "已付款", "已驳回"].map((s) =>
        `<button data-st="${s}" class="${filterStatus === s ? "on" : ""}">${s || "全部"}</button>`).join("")}</div>
      ${table(
        [{ t: "付款单号", w: "112px" }, { t: "项目" }, { t: "类型", w: "84px" }, { t: "收款方", w: "150px" },
         { t: "金额", w: "96px", cls: "num" }, { t: "发票号", w: "96px" }, { t: "申请人", w: "70px" },
         { t: "状态", w: "78px" }, { t: "操作", w: "120px" }],
        all.map((y) => ({
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
    </div>

    <div class="panel">
      <div class="panel-h"><h2>结算单</h2><div><span class="hint">${st.rows.length} 张 · 生成即冻结核销结论</span></div></div>
      ${table(
        [{ t: "结算单号", w: "112px" }, { t: "项目" }, { t: "收入", w: "100px", cls: "num" },
         { t: "支出", w: "100px", cls: "num" }, { t: "结余", w: "100px", cls: "num" },
         { t: "生成人", w: "76px" }, { t: "时间", w: "130px" }],
        st.rows.map((s) => ({
          c: [`<span class="mono">${s.id}</span>`, `<a class="link" data-go="projects/${s.pid}">${esc(s.name)}</a>`,
            `¥${money(s.income)}`, `¥${money(s.expense)}`,
            `<span class="${s.profit >= 0 ? "pos" : "neg"}">¥${money(s.profit)}</span>`,
            esc(s.created_by || ""), `<span class="mono">${esc(s.created_at)}</span>`]
        })), { empty: "暂无结算单" })}
    </div>

    <div class="foot-note">门禁说明：未通过 6 步核销的项目，付款接口会返回 <code>VERIFY_GATE</code> 并记录审计；
      已生成结算单的项目，核销结论与资料修改均被冻结（总管理员可例外操作，同样留痕）。</div>`;

  root.querySelectorAll("[data-st]").forEach((b) => b.onclick = () => { filterStatus = b.dataset.st; render(root); });
  root.querySelectorAll("[data-ok]").forEach((b) => b.onclick = () => act(root, b.dataset.ok, "approve"));
  root.querySelectorAll("[data-no]").forEach((b) => b.onclick = () => act(root, b.dataset.no, "reject"));
  root.querySelectorAll("[data-pay]").forEach((b) => b.onclick = () => act(root, b.dataset.pay, "pay"));
  root.querySelector("#expPay").onclick = () => dl("/api/export/payments");
  root.querySelector("#expSt").onclick = () => dl("/api/export/settlements");
  const np = root.querySelector("#newPay");
  if (np) np.onclick = () => openPay(root, payableProjects);
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
    { k: "pid", l: "付款项目", t: "select", req: 1, opts: projects.map((p) => ({ v: p.id, l: `${p.id} ${p.name}（${p.status}）` })) },
    { k: "type", l: "付款类型", t: "select", req: 1, opts: state.meta.paymentTypes },
    { k: "payee", l: "收款方", req: 1 },
    { k: "amount", l: "付款金额（元）", t: "number", req: 1 },
    { k: "invoice_no", l: "发票号" },
    { k: "remark", l: "备注", t: "textarea", full: 1, rows: 2 }
  ];
  const m = modal({ title: "付款申请", body: `<div class="gate ok" style="margin-bottom:12px"><b>核销门禁</b>仅列出「已核销 / 已结算 / 已归档」项目，未核销项目不在可选范围。</div>${formHtml(fields)}`,
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
