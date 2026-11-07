import { badge, esc, modal, money, table } from "./ui.js";

/**
 * 核销 7 步 SOP 的「详情」面板。
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
    1:["会议通知","招商函","串场"],2:["终版议程","签到表","讲者照片"],
    3:["签到表"],4:["终版议程","课件"],
    5:["劳务表","劳务收集表"],6:["终版议程","会务协议","合同","发票","会务发票"],7:["权益照片"]
  };
  const note={
    1:"盖章函件已盖章且为终版；核对函件与串场的会议名称、日期及主办方一致。",
    2:"以终版议程的讲者姓名为唯一标准，逐一核对签到表与讲者照片是否缺失、多余或重名；只核对这三项材料。",
    3:"线上有效讲者在线时长 >30 分钟；线下有签到原件；混合两项都需要。",
    4:"材料库中已有课件原件，每个课件主题均能在当前已确认的终版议程中找到；不再核验串场、主办方或药企 Logo。",
    5:"劳务表原件上传后核对五字段，并按完整姓名逐人匹配材料库个人合同；缺失或多份同名不能通过，合同台账总合同不能代替。",
    6:"仅有实际会务需求才核：终版议程与终版会务协议的会议主题/时间/形式一致、会务协议甲方与协会主体一致；会务需求总预算＝已签会务合同总额＝会务发票总金额。",
    7:"仅有已签署赞助合同才核：对照合同权益清单及二级类目逐项核对对应照片的实际交付内容。自动识别只推荐权益类目，照片内容必须人工确认。"
  };
  const selected=(d.materials||[]).filter(m=>(names[no]||[]).includes(m.kind));
  const step=d.verification.steps.find(x=>x.no===no);
  const contractTotal=(d.contracts||[]).filter(x=>x.status==="已签署" && x.category!=="劳务专家").reduce((sum,x)=>sum+Number(x.amount||0),0);
  const meetingDemandTotal=Number(d.demand?.budgetTotal||0);
  const matchedContractIds=new Set(step?.evidence?.matchedContractMaterialIds||[]);
  const linkedContracts=(d.materials||[]).filter(x=>x.kind==="合同" && x.file_key && matchedContractIds.has(Number(x.id)));
  const expertPayments=(d.payments||[]).filter(x=>["专家费","个人报销"].includes(x.type));
  const evidence=step?.evidence;
  return `<div class="dsec"><h4>业务核验规则</h4><div class="dchk">${esc(note[no]||"请核对资料")}</div></div>
    <div class="dsec"><h4>已登记的关联材料</h4>${matList(selected,"请在材料中心补充对应原件")}</div>
    ${no===7?'<div class="dsec"><h4>赞助合同权益逐项关联</h4>'+
      (d.sponsorRights?.requiredRights||[]).map(r=>{
        const sponsor=(d.sponsorRights?.contracts||[]).find(x=>x.id===r.sponsor_id);
        const photos=(d.sponsorRights?.photos||[]).filter(x=>Number(x.sponsor_right_id)===Number(r.id)&&x.file_key);
        return '<div class="dchk"><b>'+esc(sponsor?.enterprise||r.sponsor_id)+' · '+esc(r.category)+'</b> · '+(r.confirmed?'权益已确认':'待校正')+' · '+photos.length+' 张照片'+matList(photos,'请按权益二级类目上传照片')+'</div>';
      }).join("")+'</div>':""}
    ${no===6?`<div class="dgrid">${cell("会务需求总预算",fmt(meetingDemandTotal))}${cell("已签会务合同总额",fmt(contractTotal))}${cell("会务发票核验金额",step?.invoiceAmount==null?"未核对":fmt(step.invoiceAmount))}</div>${!d.demand?.archived?"<div class=\"dhint\">会务需求尚未归档，不能完成第6项通过判定。</div>":""}`:""}
    ${no===5?`<div class="dsec"><h4>已关联个人合同（材料库）</h4>
      ${matList(linkedContracts,"尚未通过OCR比对关联个人合同，请直接检查材料库的合同原件。")}
      <div class="hint">此处仅按姓名关联合同原件，不代表已自动核对合同正文内容。</div>
      <h4>专家费 / 个人报销（付款类别，核销通过后申请）</h4>
      ${payRows(expertPayments)}</div>`:""}
    <div class="dsec"><h4>OCR比对与人工判定留痕</h4>
      ${evidence?`<pre class="hint" style="white-space:pre-wrap">${esc(JSON.stringify(evidence,null,2))}</pre>`:
      '<div class="dhint">尚未核销判定；点击「判定」将直接扫描文件、提取要点并智能比对，无需再次填写表格。</div>'}</div>`;
}

/**
 * 打开某一步的详情弹窗。
 * @param {object} d    核销/项目详情数据
 * @param {number} no   步骤号 1~7
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
