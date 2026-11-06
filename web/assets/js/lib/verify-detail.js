import { badge, esc, modal, money, table } from "./ui.js";

/**
 * 核销 6 步 SOP 的「详情」面板。
 *
 * 判定人必须能当场看到这一步要核的原始数据——议程、签到表、票据、合同、付款金额，
 * 而不是凭印象点「通过」，否则核销就退化成橡皮图章。
 * 核销看板与项目详情页共用同一份实现，避免两处口径分叉。
 *
 * 依赖的数据形状（GET /api/projects/:id 与 GET /api/projects/:id/verify 一致）：
 *   project / verification / materials / contracts / payments / paidTotal
 */

const fmt = (n) => `¥${money(Number(n) || 0)}`;
const dt = (s) => String(s || "").slice(0, 16).replace("T", " ");

/**
 * 金额比较一律换算成「分」。
 * 合同总额与已付款都是两位小数，但浮点相加会留尾巴，
 * 用 diff !== 0 判断「有差额」会把 0.0000000000000009 当成真的差钱。
 */
const cents = (n) => Math.round((Number(n) || 0) * 100);
const round2 = (n) => cents(n) / 100;

/** 议程要点按 / 、；换行 拆成环节 */
function agendaItems(p) {
  return String(p.agenda || "")
    .split(/[\/\n；;、]+/)
    .map((x) => x.trim())
    .filter(Boolean);
}

const matsOf = (d, kind) => (d.materials || []).filter((m) => m.kind === kind);

/**
 * 例外单「步骤」列的显示文本。
 * step_no = 0 表示「不属于 6 步中任何一步」，显示提交人自己写的事项名；
 * 直接拼「第 0 步」会让人以为流程里真有第 0 步。
 */
export const exStepLabel = (e) =>
  Number(e.step_no) === 0 ? esc(e.step_label || "其他事项") : `第 ${e.step_no} 步`;

function matList(list, emptyText) {
  if (!list.length) return `<div class="dhint">${emptyText}</div>`;
  return `<ul class="dlist">${list.map((m) => `<li>
      <b>${esc(m.name)}</b>
      ${m.version ? `<span class="dtag">${esc(m.version)}</span>` : ""}
      ${m.file_name ? `<span class="dtag">${esc(m.file_name)}</span>` : ""}
      <span class="dm">${esc(m.uploader || "—")} · ${esc(dt(m.created_at))}</span>
      ${m.file_key
        ? `<a class="link" href="/api/uploads/${encodeURIComponent(m.file_key)}" target="_blank" rel="noopener" title="点击打开原件">${esc(m.file_name || m.name)} · 点击原件查看</a>`
        : `<span class="dm" style="margin-left:0">无附件</span>`}
    </li>`).join("")}</ul>`;
}

function cell(k, v, warn) {
  return `<div class="dcell${warn ? " warn" : ""}"><div class="k">${k}</div><div class="v">${v}</div></div>`;
}

function payRows(list) {
  if (!list.length) return `<div class="dhint">没有符合条件的付款记录</div>`;
  return table(
    [{ t: "单号", w: "104px" }, { t: "类型", w: "82px" }, { t: "收款方" }, { t: "金额", w: "96px", cls: "num" },
     { t: "发票号", w: "120px" }, { t: "状态", w: "72px" }],
    list.map((y) => ({
      c: [`<span class="mono">${y.id}</span>`, esc(y.type), esc(y.payee),
        fmt(y.amount), `<span class="mono">${esc(y.invoice_no || "—")}</span>`, badge(y.status)]
    }))
  );
}

/** 按步骤组装「这一步到底要核什么」的原始数据 */
export function stepBody(d,no){
  /**
   * 这里必须用**材料类别（kind）的真实取值**，且要与 server/lib/meeting-sop.js
   * 的校验保持一致——页面上写「要核 A」，服务端却要求 B，核销人就会一直撞墙。
   *
   * 第 1 步服务端校验盖章函件（会议通知 / 招商函）与串场两份原件；
   * 第 4 步仅要求课件原件和当前已确认的终版议程；不需要串场或 Logo 材料。
   */
  const names={
    1:["会议通知","招商函","串场"],2:["终版议程","劳务表","劳务收集表","签到表","讲者照片"],
    3:["签到表"],4:["终版议程","课件"],
    5:["劳务表","劳务收集表","合同"],6:["合同","发票"]
  };
  const note={
    1:"盖章函件已盖章且为终版；核对函件与串场的会议名称、日期及主办方一致。",
    2:"终版议程、签到表、讲者照片逐人比对；有劳务表时再核对其中讲者名单。合同在合同台账查看，无需单独协议。",
    3:"线上有效讲者在线时长 >30 分钟；线下有签到原件；混合两项都需要。",
    4:"材料库中已有课件原件，每个课件主题均能在当前已确认的终版议程中找到；不再核验串场、主办方或药企 Logo。",
    5:"仅有劳务表原件时必核姓名/时间/角色/金额/银行账号完整、无重复；合同查看现有合同台账，账号不进入核销证据。",
    6:"已签合同总额须等于拟请款总额，发票金额须等于需开票合同总额；专家劳务按已签署合同分类处理。"
  };
  const selected=(d.materials||[]).filter(m=>(names[no]||[]).includes(m.kind));
  const step=d.verification.steps.find(x=>x.no===no);
  const contractTotal=(d.contracts||[]).filter(x=>x.status==="已签署").reduce((sum,x)=>sum+Number(x.amount||0),0);
  const laborContracts=(d.contracts||[]).filter(x=>x.category==="劳务专家");
  const expertPayments=(d.payments||[]).filter(x=>["专家费","个人报销"].includes(x.type));
  const evidence=step?.evidence;
  return `<div class="dsec"><h4>业务核验规则</h4><div class="dchk">${esc(note[no]||"请核对资料")}</div></div>
    <div class="dsec"><h4>已登记的关联材料</h4>${matList(selected,"请在材料中心补充对应原件")}</div>
    ${no===6?`<div class="dgrid">${cell("已签合同总额",fmt(contractTotal))}${cell("核销发票总金额",step?.invoiceAmount==null?"未核对":fmt(step.invoiceAmount))}</div>`:""}
    ${no===5?`<div class="dsec"><h4>劳务 / 专家类合同（合同分类）</h4>
      ${laborContracts.length?table([{t:"合同名称"},{t:"合同收款方"},{t:"金额"},{t:"原件"}],
      laborContracts.map(x=>({c:[esc(x.name),esc(x.vendor),fmt(x.amount),x.file_key?`<a class="link" href="/api/uploads/${encodeURIComponent(x.file_key)}" target="_blank" rel="noopener">点击合同原件查看</a>`:"未上传"]}))):'<div class="dhint">暂无劳务专家类合同，请先到合同台账核验分类</div>'}
      <h4>专家费 / 个人报销（付款类别，需核销后申请）</h4>
      ${payRows(expertPayments)}</div>`:""}
    <div class="dsec"><h4>结构化核验结果</h4>
      ${evidence?`<pre class="hint" style="white-space:pre-wrap">${esc(JSON.stringify(evidence,null,2))}</pre>`:
      '<div class="dhint">尚未完成本步骤核验。结构化证据由人工录入，文件内容 OCR 尚未启用。</div>'}</div>`;
}

/**
 * 打开某一步的详情弹窗。
 * @param {object} d    核销/项目详情数据
 * @param {number} no   步骤号 1~6
 * @param {object} opt  { canJudge:boolean, onJudge:Function } —— 看完数据可直接判定
 */
export function openStepDetail(d, no, opt = {}) {
  const s = d.verification.steps.find((x) => x.no === no);
  // 各项独立判定：查看任意步骤详情都可直接执行本步骤判定。
  const canJudgeThis = !!opt.canJudge && s?.required!==false;

  const m = modal({
    title: `第 ${no} 步 · ${esc(s.name)}`,
    width: "780px",
    body: `<div class="dchk" style="margin-bottom:16px">
        <b>核对要点</b>：${esc(s.desc)}　<span class="dtag">负责：${esc(s.who)}</span>
        ${s.result !== "待判定" ? `　<span class="dtag">当前判定：${esc(s.result)}</span>` : ""}
      </div>
      ${stepBody(d, no)}`,
    footer: `<button class="btn btn-o" data-x="0">关闭</button>
      ${canJudgeThis
        ? `<button class="btn btn-p" data-x="1">${s.result === "待判定" ? "判定" : "重新判定"}</button>`
        : ""}`
  });
  m.querySelector('[data-x="0"]').onclick = () => m.classList.remove("open");
  if (canJudgeThis && typeof opt.onJudge === "function") {
    m.querySelector('[data-x="1"]').onclick = () => {
      m.classList.remove("open");
      opt.onJudge(no);
    };
  }
}
