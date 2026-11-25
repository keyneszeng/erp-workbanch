import {openPaymentExecution} from "../lib/payment-execution.js";
import {openPaymentVoucher} from "../lib/payment-voucher.js";
import { api, can, state } from "../lib/api.js";
import {bindPayeePicker} from "../lib/payee-picker.js";
import {renderIncomeWorkbench} from "../lib/income-workbench.js";
import {renderSettlementBreakdown} from "../lib/settlement-breakdown.js";
import { badge, bindPager, closeModal, confirmBox, esc, formHtml, modal, money, pager, panel, readForm, table, toast, validate } from "../lib/ui.js";


/** 项目内付款明细；审批状态仅作为历史记录提示，不再作为筛选入口。 */
function paymentOnePageTable(rows,options=[],pid=""){
  const canPay=can("payment:pay");
  const norm=v=>String(v||"").normalize("NFKC").replace(/\s+/g,"").trim();
  // 已存在关联或同名历史付款的收款方不自动生成新付款事项，避免重复登记。
  // 分期或同名多个合同须通过人工核对后的直接登记入口处理。
  const active=rows.filter(y=>y.status!=="已驳回");
  const candidates=options.filter(o=>Number(o.amount)>0&&!active.some(y=>
    y.payee_source_id===o.id||(!y.payee_source_id&&norm(y.payee)===norm(o.payee))));
  const existing=rows.map(y=>({
    attrs:' data-row="'+esc(y.id)+'" data-pid="'+esc(y.pid)+'"',
    c:[
      '<b>'+esc(y.payee)+'</b><div class="hint">'+esc(y.type)+(y.period?' · '+esc(y.period):'')+' · '+esc(y.id)+'</div>',
      '¥'+money(y.amount),
      y.status==="已付款"
        ? '<span class="hint">✓ 已付款</span><div class="hint">'+esc(y.paid_at||"")+'</div>'
        : y.status==="已审批"&&canPay
          ? '<button class="btn btn-p btn-sm" data-pay="'+esc(y.id)+'">确认已付款</button>'
          : badge(y.status)+(y.status==="待审批"&&can("payment:approve")?'<div><button class="link" data-ok="'+esc(y.id)+'">审批</button> <button class="link danger" data-no="'+esc(y.id)+'">驳回</button></div>':""),
      y.receipt_file_key
        ? canPay
          ? '<a class="link" href="/api/uploads/'+encodeURIComponent(y.receipt_file_key)+'" target="_blank" rel="noopener">查看付款凭证</a><div class="hint">'+esc(y.receipt_file_name||"")+'</div>'
          : '<span class="hint">凭证已归档</span>'
        : y.status==="已付款"&&canPay
          ? '<button class="link" data-receipt="'+esc(y.id)+'" data-pid="'+esc(y.pid)+'">上传付款凭证</button>'
          : y.status==="已审批"&&canPay?'<button class="link" data-pay="'+esc(y.id)+'">上传付款凭证</button>':'<span class="hint">付款后上传</span>'
    ]
  }));
  const pending=candidates.map(o=>({c:[
    '<b>'+esc(o.payee)+'</b><div class="hint">'+esc(o.label||"核销收款资料")+'</div>',
    '¥'+money(o.amount),
    canPay?'<button class="btn btn-p btn-sm" data-pay-source="'+esc(o.id)+'">确认已付款</button>':'<span class="hint">待登记付款</span>',
    canPay?'<button class="link" data-pay-source="'+esc(o.id)+'">上传付款凭证</button>':'<span class="hint">待上传</span>'
  ]}));
  return table([{t:"收款方"},{t:"金额",w:"120px",cls:"num"},{t:"付款按钮",w:"160px"},{t:"凭证详情",w:"180px"}],
    [...existing,...pending],{empty:"暂无付款明细，可核对合同及劳务资料后登记付款"});
}
function directPayForm(projects,focusPid,types){
  if(!projects.length)return '<div class="gate">当前没有已核销、可登记付款的项目。</div>';
  const fld=(label,element)=>'<div class="fld"><label>'+label+'</label>'+element+'</div>';
  const projectsHtml=projects.map(p=>'<option value="'+esc(p.id)+'"'+(p.id===focusPid?' selected':'')+'>'+
    esc(p.id)+' '+esc(p.name)+'</option>').join('');
  const typesHtml=types.map(t=>'<option value="'+esc(t)+'">'+esc(t)+'</option>').join('');
  return '<section id="financeDirect" style="border:1px solid var(--line);border-radius:12px;padding:16px;margin:14px 0;background:var(--card)">'+
    '<div class="panel-h"><h3>财务直接付款 · 单页登记</h3><span class="hint">线下已完成转账后勾选并上传回单</span></div>'+
    '<div class="fgrid">'+
    fld('会议项目 <span class="req">*</span>','<select name="pid">'+projectsHtml+'</select>')+
    fld('类目 <span class="req">*</span>','<select name="type">'+typesHtml+'</select>')+
    fld('按核销资料选择收款方','<select name="payee_option_id"><option value="">载入中…</option></select>')+
    fld('收款方 <span class="req">*</span>','<input name="payee" placeholder="合同单位或劳务人员">')+
    fld('金额（元） <span class="req">*</span>','<input type="number" name="amount" min="0.01" step="0.01" placeholder="0.00">')+
    fld('期次（分期付款填）','<input name="period" maxlength="20" placeholder="第1期 / 尾款">')+
    fld('开户行 <span class="req">*</span>','<input name="payee_bank" placeholder="核对实际收款账户">')+
    fld('银行账号 <span class="req">*</span>','<input name="payee_account" placeholder="10～25位数字；核验劳务账户可自动关联">')+
    fld('凭证详情 <span class="req">*</span>','<input type="file" data-direct-voucher aria-label="上传付款凭证" accept=".pdf,.jpg,.jpeg,.png,.webp,.doc,.docx,.xls,.xlsx"><p class="hint">上传实际转账回单，最大20MB。</p>')+
    fld('付款说明','<input name="remark" maxlength="300" placeholder="可选">')+
    '</div><div style="display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-top:12px">'+
    '<label><input type="checkbox" data-direct-paid> 付款（勾选）：银行实际转账已完成，收款方与金额已核对</label>'+
    '<button type="button" class="btn btn-p" data-direct-submit>登记已付款并上传凭证</button></div></section>';
}

// 只有「已核销」可由财务直接登记已付款，保留历史审批记录但不新增申请
const PAYABLE = ["已核销"];

/**
 * 从工作台「待付款」待办点进来时 params[0] 是项目号。
 * 付款列表默认分页 50 条，目标那笔很可能不在第一页 —— 所以要按 pid 让后端过滤，
 * 而不是渲染完再找（找不到就成了「点了没反应」）。
 */
export async function render(root, params = []) {
  const focusPid = params[0] || "";
  const settlementReadable=state.super||state.role?.modules?.includes("finance")||can("settle:create");
  const [st,proj]=await Promise.all([
    settlementReadable?api.get("/api/settlements"):Promise.resolve({rows:[],total:0}),
    api.get("/api/projects")
  ]);
  const payableProjects=(proj.rows||[]).filter(p=>PAYABLE.includes(p.status));
  const selected=payableProjects.find(p=>p.id===focusPid);
  const financeDirect=can("payment:pay");
  const incomeReadable=state.user?.role==="finance"||["contract:write","contract:approve","payment:pay","payment:approve"].some(perm=>can(perm));
  let pay={rows:[],total:0,summary:{}},options=[],detailsError="",optionsError="";
  if(selected){
    const result=await Promise.allSettled([
      api.get("/api/payments?pid="+encodeURIComponent(selected.id)),
      financeDirect||can("payment:create")?api.get("/api/projects/"+encodeURIComponent(selected.id)+"/payee-options"):Promise.resolve({rows:[]})
    ]);
    if(result[0].status==="fulfilled")pay=result[0].value;
    else detailsError=result[0].reason?.message||"付款记录读取失败";
    if(result[1].status==="fulfilled")options=result[1].value.rows||[];
    else optionsError=result[1].reason?.message||"核销收款方资料读取失败";
  }
  const projectList=payableProjects.length?payableProjects.map(p=>
    '<button type="button" class="btn '+(p.id===selected?.id?'btn-p':'btn-o')+'" data-go="finance/'+esc(p.id)+'" aria-pressed="'+(p.id===selected?.id)+'" style="width:100%;justify-content:space-between;text-align:left;white-space:normal;gap:12px;padding:12px 16px"><span><b>'+esc(p.name)+'</b><br><span style="font-size:12px;opacity:.8">'+esc(p.id)+' · '+esc(p.assoc||"")+'</span></span><span>查看付款明细 ›</span></button>'
  ).join(""):'<div class="empty">当前账号范围内暂无已核销会议</div>';
  root.innerHTML = `<div class="phead">
      <div><h2>会议收入、付款与结算</h2><p>按会议编号归集付款与结算；具有付款执行权限的人员在核销通过后可直接登记已付款并上传凭证，无需先发起付款申请。</p></div>
      <div class="acts">
        ${state.super ? '<button class="btn btn-o" data-go="project-ledger">项目台账</button>' : ""}
        ${can("export:any") ? `<button class="btn btn-o" id="expPay">导出付款明细</button>
        ${settlementReadable?'<button class="btn btn-o" id="expSt">导出结算汇总</button>':""}` : ""}

      </div>
    </div>

    ${incomeReadable ? '<div id="incomeWorkbench"></div>' : ""}
    <div class="ux-finance-tabs" role="navigation" aria-label="财务业务分区">
       ${incomeReadable ? '<button class="ux-finance-tab active" data-finance-jump="incomeWorkbench">企业赞助</button>' : ""}
       <button class="ux-finance-tab ${incomeReadable ? "" : "active"}" data-finance-jump="fin-payments">付款登记与凭证</button>
       ${settlementReadable?'<button class="ux-finance-tab" data-finance-jump="fin-settlements">结算与归档</button>':""}
     </div>
    <div class="ux-finance-rule">适用核销项通过 → 财务核实线下付款 → 勾选已付并上传银行回单 → 付款与凭证登记 → 结算。历史审批单仍保留原审批流程。</div>
    <div class="panel mt" id="fin-payments">
      <div class="panel-h"><h2>付款记录</h2><span class="hint">已核销会议 · ${payableProjects.length} 场</span></div>
      <div class="hint" style="margin-bottom:10px">仅展示当前账号授权范围内、已完成核销且尚未结算的会议。选择会议后查看付款明细。</div>
      <div id="paymentProjects" style="display:grid;gap:8px;max-height:360px;overflow:auto">${projectList}</div>
      ${selected?`<section id="paymentDetails" style="margin-top:18px">
        <div class="panel-h"><h3>${esc(selected.name)} · 付款明细表</h3>${financeDirect&&!detailsError?'<button class="btn btn-o btn-sm" id="goDirectPay">+ 登记其他付款</button>':""}</div>
        ${detailsError?'<div class="gate">'+esc(detailsError)+'，请刷新后重试。</div>':
          (optionsError?'<div class="hint">'+esc(optionsError)+'；已登记记录仍可查看。</div>':"")+paymentOnePageTable(pay.rows||[],options,selected.id)}
        ${financeDirect&&!detailsError?`<details id="paymentDirectPanel" style="margin-top:12px"><summary style="cursor:pointer">登记付款 · 核对收款方并上传凭证</summary>${directPayForm([selected],selected.id,state.meta?.paymentTypes||[])}</details>`:""}
      </section>`:'<div class="hint" style="padding:20px 0;text-align:center">请选择会议项目查看付款明细。</div>'}
    </div>

    <div class="panel" id="fin-settlements" ${settlementReadable?"":"hidden"}>
      <div class="panel-h"><h2>结算单</h2><div><span class="hint">${st.total ?? st.rows.length} 张 · 生成即冻结核销结论</span></div></div>
      ${table(
        [{ t: "结算单号", w: "112px" }, { t: "项目" }, { t: "项目预算", w: "96px", cls: "num" },
         { t: "已付支出", w: "96px", cls: "num" }, { t: "结余", w: "96px", cls: "num" },
         { t: "生成人", w: "70px" }, { t: "时间", w: "120px" },{ t:"操作",w:"100px" }],
        st.rows.map((x) => ({
          c: [`<span class="mono">${x.id}</span>`, `<a class="link" data-go="projects/${x.pid}">${esc(x.name)}</a>`,
            `¥${money(x.income)}`, `¥${money(x.expense)}`,
            `<span class="${x.profit >= 0 ? "pos" : "neg"}">¥${money(x.profit)}</span>`,
            esc(x.created_by || ""), `<span class="mono">${esc(x.created_at)}</span>`,
            `<button type="button" class="link" aria-expanded="false" data-settlement-detail="${esc(x.id)}">查看结算单</button>`]
        })), { empty: "暂无结算单" })}
      <div id="settlementDetail" aria-live="polite"></div>
    </div>

    <div class="foot-note">门禁说明：七项核销规则中所有适用项通过后才可登记付款，否则接口返回 <code>VERIFY_GATE</code>；
      「已付款」指内部系统记录，不是自动发起银行转账。结算后相关账目和原件被冻结。</div>`;

  if (incomeReadable) renderIncomeWorkbench(root.querySelector("#incomeWorkbench"),
    proj.rows.filter(p=>!["已归档"].includes(p.status)),focusPid).catch(e=>toast(e.message,"warn"));
  root.querySelectorAll("[data-finance-jump]").forEach(b=>b.onclick=()=>{
    root.querySelectorAll("[data-finance-jump]").forEach(x=>x.classList.toggle("active",x===b));
    root.querySelector("#"+b.dataset.financeJump)?.scrollIntoView({behavior:"smooth",block:"start"});
  });
  root.querySelectorAll("[data-ok]").forEach((b) => b.onclick = () => act(root, b.dataset.ok, "approve",params));
  root.querySelectorAll("[data-no]").forEach((b) => b.onclick = () => act(root, b.dataset.no, "reject",params));
  root.querySelectorAll("[data-pay]").forEach((b) => b.onclick = () => act(root, b.dataset.pay, "pay",params));
  // 「登记账户」已并入执行付款弹窗（payment-execution.js），列表不再单独提供入口。
  const settleSlot=root.querySelector("#settlementDetail");
  root.querySelectorAll("[data-settlement-detail]").forEach(button=>button.onclick=async()=>{
    const id=button.dataset.settlementDetail;
    if(settleSlot.dataset.active===id){
      settleSlot.replaceChildren();
      delete settleSlot.dataset.active;
      button.setAttribute("aria-expanded","false");
      return;
    }
    root.querySelectorAll("[data-settlement-detail]").forEach(x=>x.setAttribute("aria-expanded","false"));
    settleSlot.dataset.active=id;
    button.setAttribute("aria-expanded","true");
    settleSlot.innerHTML='<div class="hint" style="padding:16px">正在读取结算单明细…</div>';
    try{
      const detail=await api.get("/api/settlements/"+encodeURIComponent(id)+"/breakdown");
      if(settleSlot.dataset.active!==id)return;
      settleSlot.innerHTML=renderSettlementBreakdown(detail);
      settleSlot.scrollIntoView({block:"nearest",behavior:"smooth"});
    }catch(err){
      if(settleSlot.dataset.active!==id)return;
      settleSlot.innerHTML='<div class="empty">结算单明细读取失败，请稍后重试</div>';
      toast(err.message,"warn");
    }
  });
  const ep = root.querySelector("#expPay");
  if (ep) ep.onclick = () => openPaymentExport(focusPid);
  const es = root.querySelector("#expSt");
  if (es) es.onclick = () => dl("/api/export/settlements");
  const directPanel=root.querySelector("#paymentDirectPanel");
  const revealForm=()=>{if(directPanel){directPanel.open=true;directPanel.scrollIntoView({behavior:"smooth",block:"nearest"});}};
  root.querySelector("#goDirectPay")?.addEventListener("click",revealForm);
  const form=root.querySelector("#financeDirect");
  if(form){
    const select=form.querySelector('[name="pid"]');
    const ready=bindPayeePicker(form,select.value,false).catch(e=>toast("收款方资料加载失败："+e.message,"warn"));
    root.querySelectorAll("[data-pay-source]").forEach(b=>b.onclick=async()=>{
      revealForm();await ready;
      const source=options.find(o=>o.id===b.dataset.paySource);
      const picker=form.querySelector('[name="payee_option_id"]');
      if(!source||!Array.from(picker.options).some(o=>o.value===source.id)){toast("收款方资料已变化，请刷新后重试","warn");return;}
      picker.value=source.id;picker.dispatchEvent(new Event("change"));
      form.querySelector('[name="amount"]').value=source.amount;
      if(source.source==="labor"||String(source.label).includes("劳务专家"))
        form.querySelector('[name="type"]').value="专家费";
      else form.querySelector('[name="type"]').value="学会公付";
      form.querySelector("[data-direct-paid]").checked=false;
      form.querySelector("[data-direct-voucher]").value="";
    });
    const btn=form.querySelector("[data-direct-submit]");
    btn.onclick=async()=>{
      const pid=select.value,confirmed=form.querySelector("[data-direct-paid]").checked;
      const receipt=form.querySelector("[data-direct-voucher]").files?.[0];
      const raw=readForm(form);
      if(!raw.type||!raw.payee?.trim()||!(Number(raw.amount)>0)){
        toast("请填写类目、收款方和有效金额","warn");return;
      }
      if(!raw.payee_bank?.trim()||(!raw.payee_account?.trim()&&!raw.payee_option_id)){
        toast("请核对开户行、银行账号或已核验的劳务账户","warn");return;
      }
      if(!confirmed){toast("请先勾选确认实际银行转账已完成","warn");return;}
      if(!receipt||receipt.size>20*1024*1024){toast("请上传不超过20MB的付款凭证","warn");return;}
      if(!await confirmBox("确认线下已向「"+esc(raw.payee)+"」付款 ¥"+money(raw.amount)+"？系统只登记已发生的银行付款，并归档回单。",{ok:"确认已付款并归档"}))return;
      btn.disabled=true;btn.textContent="正在上传并登记…";
      try{
        const uploaded=await api.upload(receipt,{pid});
        const out=await api.post("/api/payments/direct",{
          ...raw,pid,confirm_paid:true,receipt_file_key:uploaded.key,receipt_file_name:uploaded.name
        });
        toast(out.message,"ok");
        await render(root,params);
      }catch(e){toast(e.message,"warn");btn.disabled=false;btn.textContent="登记已付款并上传凭证";}
    };
  }
  root.querySelectorAll("[data-receipt]").forEach(b=>b.onclick=()=>openPaymentVoucher(b.dataset.receipt,b.dataset.pid,()=>render(root,params)));

  if(selected)root.querySelector("#paymentDetails")?.scrollIntoView({block:"nearest",behavior:"smooth"});
  else if(focusPid)toast("该会议不在当前账号已核销待结算列表内","warn");
}

/**
 * 导出付款明细：先勾选 1～300 场本人有权限的会议，再合并导出为一份 CSV。
 * 本页的付款列表可能仅加载 50 行，因此会议候选要通过项目列表独立获取。
 */
async function openPaymentExport(focusPid="") {
  let projects;
  try {
    const res=await api.get("/api/projects");
    projects=(res.rows||[]).filter(p=>p.id&&p.name);
  }catch(e){toast("会议列表读取失败："+e.message,"warn");return;}
  if(!projects.length){toast("当前没有可选择的会议","warn");return;}
  const selected=new Set(focusPid&&projects.some(p=>p.id===focusPid)?[focusPid]:[]);
  const m=modal({title:"按会议导出付款明细（支持多选）",width:"min(700px, 94vw)",body:`
    <div class="hint" style="line-height:1.7;margin-bottom:12px">勾选需要导出的会议（可跨不同协会，但仅限本人有权查看的会议），所有选中会议的付款记录将合并为一份 CSV。未发生付款的会议不会产生明细行。</div>
    <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:12px">
      <input type="search" data-payment-search placeholder="搜索会议名称、编号或协会" aria-label="搜索可导出会议" style="flex:1;min-width:200px;padding:9px 12px;border:1px solid var(--line);border-radius:8px">
      <button type="button" class="btn btn-o btn-sm" data-payment-select-visible>全选筛选结果</button>
      <button type="button" class="btn btn-o btn-sm" data-payment-clear>清空选择</button>
    </div>
    <div data-payment-count role="status" class="hint" style="margin-bottom:8px"></div>
    <div data-payment-projects role="group" aria-label="选择导出的会议" style="border:1px solid var(--line);border-radius:10px;max-height:360px;overflow-y:auto;padding:4px 12px"></div>
    <div class="hint" style="margin-top:10px">导出包含付款单号、会议编号、会议名称、收款方、金额、付款状态及原有财务字段。最多一次选择 300 场会议。</div>
    <div style="display:flex;justify-content:flex-end;gap:10px;margin-top:18px">
      <button type="button" class="btn btn-o" data-payment-cancel>取消</button>
      <button type="button" class="btn btn-p" data-payment-confirm disabled>导出所选付款明细</button>
    </div>`});
  const search=m.querySelector("[data-payment-search]");
  const list=m.querySelector("[data-payment-projects]");
  const counter=m.querySelector("[data-payment-count]");
  const exportBtn=m.querySelector("[data-payment-confirm]");
  const visibleBtn=m.querySelector("[data-payment-select-visible]");
  let filtered=projects;
  let downloading=false;
  const redraw=()=>{
    const q=search.value.trim().toLowerCase();
    filtered=projects.filter(p=>
      [p.name,p.id,p.assoc].some(x=>String(x||"").toLowerCase().includes(q)));
    counter.textContent="已选择 "+selected.size+" 场会议 · 当前匹配 "+filtered.length+" 场";
    list.innerHTML=filtered.length?filtered.map(p=>`
      <label style="display:flex;gap:10px;align-items:center;padding:10px 4px;border-bottom:1px solid var(--line);cursor:pointer">
        <input type="checkbox" data-payment-pid="${esc(p.id)}" ${selected.has(p.id)?"checked":""} ${downloading?"disabled":""} style="width:17px;height:17px;flex-shrink:0">
        <span style="flex:1;min-width:0">
          <strong style="display:block;font-size:13px;overflow-wrap:anywhere">${esc(p.name)}</strong>
          <span class="hint">${esc(p.id)} · ${esc(p.assoc||"未标注协会")} · ${esc(p.status||"")}${Number.isFinite(Number(p.pay_cnt))?" · "+Number(p.pay_cnt)+" 笔付款":""}</span>
        </span>
      </label>`).join(""):'<div class="hint" style="padding:18px;text-align:center">没有匹配的会议</div>';
    list.querySelectorAll("[data-payment-pid]").forEach(c=>{
      c.onchange=()=>{
        if(c.checked){
          if(selected.size>=300){c.checked=false;toast("单次最多选择 300 场会议","warn");return;}
          selected.add(c.dataset.paymentPid);
        }else selected.delete(c.dataset.paymentPid);
        redraw();
      };
    });
    exportBtn.disabled=downloading||selected.size===0;
    visibleBtn.disabled=downloading||!filtered.length;
    search.disabled=downloading;
    m.querySelector("[data-payment-clear]").disabled=downloading||!selected.size;
  };
  search.oninput=redraw;
  visibleBtn.onclick=()=>{
    const next=new Set([...selected,...filtered.map(p=>p.id)]);
    if(next.size>300){toast("所选会议超过 300 场，请先搜索缩小范围","warn");return;}
    for(const id of next)selected.add(id);
    redraw();
  };
  m.querySelector("[data-payment-clear]").onclick=()=>{selected.clear();redraw();};
  m.querySelector("[data-payment-cancel]").onclick=closeModal;
  exportBtn.onclick=async()=>{
    if(!selected.size||downloading)return;
    downloading=true;redraw();
    exportBtn.textContent="导出中…";
    try{
      const r=await api.download("/api/export/payments",{
        method:"POST",body:{pids:[...selected]}});
      closeModal();
      toast("已导出 "+selected.size+" 场会议："+r.name,"ok");
    }catch(e){
      downloading=false;exportBtn.textContent="导出所选付款明细";
      redraw();toast(e.message,"warn");
    }
  };
  redraw();
}

async function dl(path) {
  try { const r = await api.download(path); toast(`已导出 ${r.name}`, "ok"); }
  catch (e) { toast(e.message, "warn"); }
}

async function act(root, id, kind, params=[]) {
  try {
    if (kind === "pay") {
      return openPaymentExecution(id,()=>render(root,params));
    } else {
      const r = await api.post(`/api/payments/${id}/approve`, { approve: kind === "approve" });
      toast(r.message, "ok");
    }
    await render(root,params);
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

