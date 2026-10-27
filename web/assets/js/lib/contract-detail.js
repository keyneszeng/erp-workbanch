import { api, can } from "./api.js";
import { badge, closeModal, esc, modal, money, toast } from "./ui.js";
import { fileUrl, formatBytes } from "./upload.js";

/**
 * 合同详情弹窗 —— 台账与项目详情共用。
 *
 * 老板 2026-10-27 提的：原件列只有一个「PDF」二字或 40px 缩略图，点开是新窗口里的裸文件，
 * 想核对条款还得自己找上下文；他要的是「点详情直接看原件」，
 * 并且能在同一个地方把下一步动作做掉（提交签署 / 确认签署）。
 *
 * 所以这个弹窗一次给全三样：
 *   1. 这份合同是谁、跟谁签、多少钱、什么状态（不用回列表里对）；
 *   2. 原件本身 —— 图片直接铺开，PDF 内嵌预览，不用跳出去；
 *   3. 当前状态下该做的那个动作，就在底部，不用关掉再回列表找按钮。
 *
 * 流转仍走同一个接口，权限口径与列表里的按钮完全一致（flowOf 与两处列表同源）。
 */

/** 当前状态下可做的流转动作；没有就是 null。口径与列表按钮一致 */
export function flowOf(c) {
  if (c.status === "草稿" && can("contract:write")) {
    return { action: "submit", label: "提交签署", perm: "contract:write" };
  }
  if (c.status === "待签署" && can("contract:approve")) {
    return { action: "sign", label: "确认签署", perm: "contract:approve" };
  }
  return null;
}

/** 为什么这一步点不了 —— 让置灰的按钮自己说明原因，而不是让人猜 */
export function flowHint(c) {
  if (c.status === "草稿") return can("contract:write") ? "" : "需要合同录入权限";
  if (c.status === "待签署") return can("contract:approve") ? "" : "待协会管理员确认签署";
  return "";
}

const dt = (s) => String(s || "").slice(0, 16).replace("T", " ");

function cell(k, v) {
  return `<div><div class="cdk">${k}</div><div class="cdv">${v}</div></div>`;
}

/** 原件预览：图片铺开、PDF 内嵌，都没有就说清楚没有 */
function fileBlock(c) {
  if (!c.file_key) {
    return `<div class="cdfile">
      <div class="cdfile-h"><b>合同原件</b><span>尚未上传</span></div>
      <div class="cdfile-empty">这份合同还没有原件。录入人或会务执行补传后才能核对条款 ——
        台账的「已传原件」指标也会把它算作缺件。</div>
    </div>`;
  }
  const url = fileUrl(c.file_key);
  const name = esc(c.file_name || `${c.id} 原件`);
  const size = c.file_size ? formatBytes(c.file_size) : "";
  const isPdf = c.file_mime === "application/pdf";

  const body = isPdf
    ? `<iframe class="cdpdf" src="${url}#view=FitH" title="${name}"></iframe>`
    : `<div class="cdimg-wrap"><img class="cdimg" src="${url}" alt="${name}"></div>`;

  return `<div class="cdfile">
    <div class="cdfile-h">
      <b>合同原件</b>
      <span>${name}${size ? ` · ${size}` : ""}</span>
      <div style="flex:1"></div>
      <a class="link" href="${url}" target="_blank" rel="noopener">新窗口打开</a>
    </div>
    ${body}
    ${isPdf
      ? `<div class="cdfile-tip">PDF 预览受浏览器支持情况影响；显示不全时点右上「新窗口打开」。</div>`
      : ""}
  </div>`;
}

/**
 * @param {object} c        合同行（/api/contracts 或项目详情里的 contracts 项）
 * @param {object} opt
 *   opt.pname    项目名称（项目详情里没有 pname，传 p.name 进来）
 *   opt.locked   项目已封存（已结算 / 已归档）—— 封存后不给流转按钮
 *   opt.onDone   流转成功后的刷新回调
 */
export function openContractDetail(c, opt = {}) {
  const pname = opt.pname || c.pname || c.pid || "—";
  const flow = opt.locked ? null : flowOf(c);
  const hint = opt.locked ? "" : flowHint(c);

  const body = `
    <div class="cdtop">
      <div class="cdname"><span class="mono">${esc(c.id)}</span> ${esc(c.name)}</div>
      <span class="cat">${esc(c.category || "未分类")}</span>
      ${badge(c.status)}
    </div>
    <div class="cdgrid">
      ${cell("所属项目", `<a class="link" data-go="projects/${esc(c.pid)}">${esc(pname)}</a>`)}
      ${cell("签约方", esc(c.vendor || "—"))}
      ${cell("合同金额", `<b class="num">¥${money(c.amount)}</b>`)}
      ${cell("签署日期", `<span class="mono">${esc(c.sign_date || "—")}</span>`)}
      ${cell("录入", `${esc(c.created_by_name || "—")}${c.created_at ? ` · ${esc(dt(c.created_at))}` : ""}`)}
      ${cell("备注", esc(c.remark || "—"))}
    </div>
    ${fileBlock(c)}
    ${opt.locked ? `<div class="cdgate">项目已封存（${esc(opt.locked === true ? "已结算 / 已归档" : opt.locked)}），合同状态不可再流转。</div>` : ""}
    ${!flow && hint && !opt.locked ? `<div class="cdgate">${esc(hint)}</div>` : ""}`;

  const m = modal({
    title: `合同详情 · ${esc(c.id)}`,
    width: "860px",
    body,
    footer: `<button class="btn btn-o" data-x="0">关闭</button>
      ${flow ? `<button class="btn btn-p" data-x="1">${flow.label}</button>` : ""}`
  });

  // 关闭一律走 closeModal()，不能只摘 .open 类 ——
  // 摘类只是藏起来，里面的 PDF iframe 还在后台继续加载，白耗流量，
  // 而且会让后续任何等 networkidle 的操作一直等不到。
  m.querySelector('[data-x="0"]').onclick = () => closeModal();
  // 弹窗里的「项目」链接：先关掉弹窗再跳，否则路由切换后弹窗还盖在上面
  m.querySelectorAll("[data-go]").forEach((a) => {
    a.onclick = (e) => {
      e.preventDefault();
      closeModal();
      location.hash = `#/${a.dataset.go}`;
    };
  });

  const act = m.querySelector('[data-x="1"]');
  if (!act) return;

  const run = async (btn) => {
    btn.disabled = true;
    btn.textContent = "处理中…";
    try {
      const r = await api.post(`/api/contracts/${c.id}/transition`, { action: flow.action });
      toast(r.message, "ok");
      closeModal();
      if (typeof opt.onDone === "function") opt.onDone();
    } catch (e) {
      toast(e.message, "warn");
      btn.disabled = false;
      btn.textContent = flow.label;
    }
  };

  // 确认签署在弹窗**内部**二次确认，不另开 confirmBox：
  // #modal 是单例，confirmBox 会把详情弹窗整个覆盖掉 ——
  // 用户点「取消」回来时，刚才看的原件已经没了，得重新找一遍。
  const askSign = () => {
    const bar = m.querySelector(".mf");
    bar.innerHTML = `<span class="cdconfirm">确认后签署日期记为今天（${todayStr()}），台账里可核对</span>
      <button class="btn btn-o" data-back="1">取消</button>
      <button class="btn btn-p" data-ok="1">确认签署</button>`;
    bar.querySelector('[data-ok="1"]').onclick = (e) => run(e.currentTarget);
    bar.querySelector('[data-back="1"]').onclick = () => {
      // 退回原来的底部，详情内容原样还在（不是把弹窗关掉重开）
      bar.innerHTML = `<button class="btn btn-o" data-x="0">关闭</button>
        <button class="btn btn-p" data-x="1">${flow.label}</button>`;
      bar.querySelector('[data-x="0"]').onclick = () => closeModal();
      bar.querySelector('[data-x="1"]').onclick = (e) =>
        flow.action === "sign" ? askSign() : run(e.currentTarget);
    };
  };

  act.onclick = (e) => (flow.action === "sign" ? askSign() : run(e.currentTarget));
}

/** 今天，YYYY-MM-DD —— 与后端 transition 的默认签署日期同口径 */
function todayStr() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
