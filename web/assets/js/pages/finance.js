import { api, can, state } from "../lib/api.js";
import {bindPayeePicker} from "../lib/payee-picker.js";
import {renderIncomeWorkbench} from "../lib/income-workbench.js";
import { badge, bindPager, confirmBox, esc, formHtml, modal, money, pager, panel, readForm, table, toast, validate } from "../lib/ui.js";

const PAGE_SIZE = 50;
let filterStatus = "";
let curPage = 1;
// 只有「已核销」可申请付款：协会管理员审批后由财务支付，全部完成后才能结算
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
      <div><h2>付款与结算</h2><p>按唯一会议编号归集所有业务记录；核销核票→付款申请→协会管理员/总管理员审批→财务完成付款→生成结算单；未付款不得结算</p></div>
      <div class="acts">
        ${state.super ? '<button class="btn btn-o" data-go="project-ledger">项目台账</button>' : ""}
        ${can("export:any") ? `<button class="btn btn-o" id="expPay">导出付款明细</button>
        <button class="btn btn-o" id="expSt">导出结算汇总</button>` : ""}
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

    <div id="incomeWorkbench"></div>
    <div class="ux-finance-tabs" role="navigation" aria-label="财务业务分区">
       <button class="ux-finance-tab active" data-finance-jump="fin-payments">付款申请与执行</button>
       <button class="ux-finance-tab" data-finance-jump="fin-settlements">结算与归档</button>
     </div>
    <div class="ux-finance-rule">核销六步全部通过 → 付款申请 → 协会审批 → 财务执行 → 金额对齐后结算；发票号随付款记录核对。</div>
    <div class="panel mt" id="fin-payments">
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
            esc(y.type),
            // 收款方 + 账户一起给：财务打款时看的就是这两行
            `${esc(y.payee)}<div style="font-size:11px;color:var(--mute)">
              ${y.payee_account
                ? `${esc(y.payee_bank || "")} · <span class="mono">${esc(y.payee_account)}</span>`
                : '<span style="color:var(--warn)">未登记收款账户</span>'}
            </div>`,
            `¥${money(y.amount)}`, `<span class="mono">${esc(y.invoice_no || "—")}</span>`,
            esc(y.req_user || ""), badge(y.status),
            `<div class="tacts">
              ${y.status === "待审批" && can("payment:approve") ? `<button class="link" data-ok="${y.id}">审批</button><button class="link danger" data-no="${y.id}">驳回</button>` : ""}
              ${y.status === "已审批" && can("payment:pay") && y.payee_account ? `<button class="link" data-pay="${y.id}">付款</button>` : ""}
              ${y.status !== "已付款" && can("payment:approve") && !y.payee_account ? `<button class="link" data-acct="${y.id}">登记账户</button>` : ""}
              ${y.status === "已付款" ? `<span style="font-size:11.5px;color:var(--mute)">${esc(y.paid_at || "")}</span>` : ""}
            </div>`]
        })), { empty: "暂无付款记录" })}
      ${pager(pay, { unit: "笔" })}
    </div>

    <div class="panel" id="fin-settlements">
      <div class="panel-h"><h2>结算单</h2><div><span class="hint">${st.total ?? st.rows.length} 张 · 生成即冻结核销结论</span></div></div>
      ${table(
        [{ t: "结算单号", w: "112px" }, { t: "项目" }, { t: "预算", w: "96px", cls: "num" },
         { t: "已付款", w: "110px", cls: "num" }, { t: "结余", w: "96px", cls: "num" },
         { t: "生成人", w: "70px" }, { t: "时间", w: "120px" }],
        st.rows.map((x) => {
          // 结算单的 expense 含劳务代扣税，已付款 = expense − 税；明细在项目详情的「财务结算」页签
          const tax = Number(x.tax_withheld || 0);
          const paid = Number(x.expense) - tax;
          return {
            c: [`<span class="mono">${x.id}</span>`, `<a class="link" data-go="projects/${x.pid}">${esc(x.name)}</a>`,
              `¥${money(x.income)}`,
              `¥${money(paid)}${tax > 0
                ? `<div style="font-size:11px;color:var(--mute)">另代扣税 ¥${money(tax)}</div>` : ""}`,
              `<span class="${x.profit >= 0 ? "pos" : "neg"}">¥${money(x.profit)}</span>`,
              esc(x.created_by || ""), `<span class="mono">${esc(x.created_at)}</span>`]
          };
        }), { empty: "暂无结算单" })}
    </div>

    <div class="foot-note">门禁说明：未通过 6 步核销的项目，付款接口会返回 <code>VERIFY_GATE</code> 并记录审计；
      已生成结算单的项目，核销结论与资料修改均被冻结（总管理员可例外操作，同样留痕）。</div>`;

  renderIncomeWorkbench(root.querySelector("#incomeWorkbench"),
    proj.rows.filter(p=>!["已归档"].includes(p.status)),focusPid).catch(e=>toast(e.message,"warn"));
  bindPager(root, (n) => { curPage = n; render(root, params); });
  root.querySelectorAll("[data-st]").forEach((b) => b.onclick = () => { filterStatus = b.dataset.st; curPage = 1; render(root, params); });
  root.querySelectorAll("[data-finance-jump]").forEach(b=>b.onclick=()=>{
    root.querySelectorAll("[data-finance-jump]").forEach(x=>x.classList.toggle("active",x===b));
    root.querySelector("#"+b.dataset.financeJump)?.scrollIntoView({behavior:"smooth",block:"start"});
  });
  root.querySelectorAll("[data-ok]").forEach((b) => b.onclick = () => act(root, b.dataset.ok, "approve"));
  root.querySelectorAll("[data-no]").forEach((b) => b.onclick = () => act(root, b.dataset.no, "reject"));
  root.querySelectorAll("[data-pay]").forEach((b) => b.onclick = () => act(root, b.dataset.pay, "pay"));
  root.querySelectorAll("[data-acct]").forEach((b) => b.onclick = () => openAccount(root, b.dataset.acct));
  const ep = root.querySelector("#expPay");
  if (ep) ep.onclick = () => dl("/api/export/payments");
  const es = root.querySelector("#expSt");
  if (es) es.onclick = () => dl("/api/export/settlements");
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

/**
 * 补录收款账户（V1.2.18）。
 * 账号字段是这一版才加的，老单据没有 —— 没有这个入口，财务要么打不了款，要么绕线下。
 */
function openAccount(root, id) {
  const fields = [
    { k: "payee_bank", l: "开户行", req: 1, ph: "如：中国银行北京朝阳支行" },
    { k: "payee_account", l: "银行账号", req: 1, ph: "10~25 位数字，可含空格分隔" }
  ];
  const m = modal({
    title: `登记收款账户 · ${id}`,
    body: `<div class="hint" style="margin-bottom:12px">这笔付款单还没有收款账户。登记后才能执行付款；已付款的单子不可再改。</div>${formHtml(fields)}`,
    footer: `<button class="btn btn-o" data-x="0">取消</button><button class="btn btn-p" data-x="1">保存</button>`
  });
  m.querySelector('[data-x="0"]').onclick = () => m.classList.remove("open");
  m.querySelector('[data-x="1"]').onclick = async () => {
    if (!validate(m, fields)) return;
    try {
      const r = await api.patch(`/api/payments/${id}/account`, readForm(m));
      toast(r.message, "ok");
      m.classList.remove("open");
      await render(root);
    } catch (e) { toast(e.message, "warn"); }
  };
}

async function openPay(root, projects) {
  if (!projects.length) return toast("当前没有已核销项目可付款", "warn");
  const fields = [
    { k: "pid", l: "付款项目", t: "select", req: 1, opts: projects.map((p) => ({
        v: p.id,
        l: `${p.id} ${p.name}（预算 ¥${Number(p.budget).toLocaleString("zh-CN")}，已付 ¥${Number(p.paid_amt || 0).toLocaleString("zh-CN")}）`
      })) },
    { k: "type", l: "付款类型", t: "select", req: 1, opts: state.meta.paymentTypes },
    { k: "payee_option_id", l: "按核销资料选择收款方", t: "select", opts: [{v:"",l:"载入中…"}],
      tip:"专家费与个人报销优先使用第 5 步核验的劳务表；其他收款方来自已签署合同。" },
    { k: "payee", l: "收款方", req: 1 },
    // V1.2.18：只写收款方名字，财务没法打款
    { k: "payee_bank", l: "开户行", req: 0, ph: "如：中国银行北京朝阳支行" },
    { k: "payee_account", l: "银行账号", req: 0, ph: "10~25 位数字，可含空格分隔" },
    { k: "amount", l: "付款金额（元）", t: "number", req: 1 },
    { k: "remark", l: "备注", t: "textarea", full: 1, rows: 2 }
  ];
  const m = modal({ title: "付款申请", body: `<div class="gate ok" style="margin-bottom:12px"><b>核销门禁</b>仅列出「已核销」项目：未核销项目不可付款，已结算项目账目已封账，已归档项目卷宗已封存。<br><b>预算门禁</b>已占用（待审批 + 已审批 + 已付款）加本笔金额超过预算时，接口返回 <code>OVER_BUDGET</code>，需总管理员特批。</div>${formHtml(fields)}
    <div style="margin-top:10px">
      <button type="button" class="btn btn-o btn-sm" id="bankExtract">从合同原件识别收款账户</button>
      <span class="hint" id="bankExtractMsg" style="margin-left:8px"></span>
    </div>
    <div class="hint" data-payee-tip style="color:#a23b2b"></div>`,
    footer: `<button class="btn btn-o" data-x="0">取消</button><button class="btn btn-p" data-x="1">提交申请</button>` });
  await bindPayeePicker(m,projects[0].id,true);
  // 合同台账里没录开户行/账号时，直接从合同原件里识别一遍再重新载入选项
  m.querySelector("#bankExtract").onclick = async () => {
    const pid = m.querySelector('[name="pid"]').value;
    const btn = m.querySelector("#bankExtract"), msg = m.querySelector("#bankExtractMsg");
    btn.disabled = true; btn.textContent = "识别中，请稍候…"; msg.textContent = "";
    try {
      const r = await api.post(`/api/projects/${encodeURIComponent(pid)}/contracts/bank-extract`, {});
      // 失败的要逐份点名：只说「成功 N 份」时，财务不知道剩下的是缺原件还是原件认不出来
      const bad = (r.results || []).filter(x => x.error).map(x => `${x.id}（${x.error}）`);
      msg.textContent = `扫描 ${r.scanned} 份合同，识别成功 ${r.updated} 份` +
        (bad.length ? `；未识别：${bad.join("、")}` : "");
      if (r.updated) await bindPayeePicker(m, pid, false);
    } catch (e) { msg.textContent = e.message; }
    finally { btn.disabled = false; btn.textContent = "从合同原件识别收款账户"; }
  };
  m.querySelector('[data-x="0"]').onclick = () => m.classList.remove("open");
  m.querySelector('[data-x="1"]').onclick = async () => {
    const selected=m.querySelector('[name="payee_option_id"]')?.value;
    const acct=m.querySelector('[name="payee_account"]')?.value.trim();
    const bank=m.querySelector('[name="payee_bank"]')?.value.trim();
    const rows=m.querySelector('[name="payee_option_id"]')?.__rows||[];
    const source=rows.find(x=>x.id===selected);
    // 选中的收款方若带着已核验账号，服务端会直接解密使用，不需要再手填
    const hasVerifiedAccount = !!(source && source.maskedAccount && !source.accountUnavailable);
    if((!source||!source.bank)&&!bank){toast("请填写收款方开户行","warn");return;}
    if(!hasVerifiedAccount&&!acct){toast("请填写银行账号（或选择带账号的核销收款方）","warn");return;}
    if (!validate(m, fields)) return;
    try {
      const payload = readForm(m);
      // 自动带入的是「尾号 7946」这种展示值，不是账号本身 ——
      // 真账号由服务端按 payee_option_id 解密，这里必须去掉，否则会被当成非法账号拒掉
      const acctEl = m.querySelector('[name="payee_account"]');
      if (acctEl?.dataset.auto === "1") delete payload.payee_account;
      const r = await api.post("/api/payments", payload);
      toast(r.message, "ok");
      m.classList.remove("open");
      await render(root);
    } catch (e) { toast(e.message, "warn"); }
  };
}
