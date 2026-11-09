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
 * step_no = 0 表示「不属于 7 步中任何一步」，显示提交人自己写的事项名；
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
    [{ t: "单号", w: "104px" }, { t: "类型", w: "82px" }, { t: "收款方" }, { t: "金额／期次", w: "112px", cls: "num" },
     { t: "发票号", w: "120px" }, { t: "状态", w: "72px" }],
    list.map((y) => ({
      c: [`<span class="mono">${y.id}</span>`, esc(y.type), esc(y.payee),
        `${fmt(y.amount)}${y.period ? `<div class="hint">期次：${esc(y.period)}</div>` : ""}`, `<span class="mono">${esc(y.invoice_no || "—")}</span>`, badge(y.status)]
    }))
  );
}

/** 按步骤组装「这一步到底要核什么」的原始数据 */
export function stepBody(d,no){
  /**
   * 这里必须用**材料类别（kind）的真实取值**，且要与 server/lib/meeting-sop.js
   * 的校验保持一致——页面上写「要核 A」，服务端却要求 B，核销人就会一直撞墙。
   *
   * 第 1 步关联当前终版议程、串场和盖章函件，并核对三份原件；
   * 第 4 步仅要求课件原件和当前已确认的终版议程；不需要串场或 Logo 材料。
   */
  const names={
    1:["会议通知","招商函","终版议程","串场"],2:["终版议程","讲者照片"],
    3:["签到表"],4:["终版议程","课件"],
    5:["劳务表","劳务登记表","劳务收集表"],6:[],7:["权益照片"]
  };
  const note={
    1:"关联当前已确认的终版议程、串场材料及盖章函件原件；核对会议名称、日期与主办方是否一致，并人工确认函件盖章。",
    2:"只关联当前终版议程与讲者照片，提取议程讲者姓名并与照片原文件名逐人核对；签到表在第3项处理。",
    3:"线上有效讲者在线时长 >30 分钟；线下有签到原件；混合两项都需要。",
    4:"只关联当前终版议程与课件原件，核对课件主题是否逐个出现在议程中；不引用串场或其他材料。",
    5:"仅核对劳务登记表与劳务专家合同：逐人核对姓名、时间、角色、金额、银行账号五字段；会务合同和赞助合同不参与本项。",
    6:"有已建立会务需求表即必核：核对会务需求表预算与已签会务合同金额一致，并确认已关联会务发票原件；不比对发票金额。",
    7:"有赞助权益内容或权益照片即必核：只关联赞助合同和权益照片，逐项核实交付内容及照片真实性。"
  };
  const isLaborContract=m=>{
    if(!m?.file_key)return false;
    const linked=(d.contracts||[]).filter(c=>c.file_key===m.file_key);
    if(linked.length)return linked.length===1&&linked[0].category==="劳务专家";
    if(["劳务专家合同","专家劳务合同","劳务合同","专家合同"].includes(m.kind))return true;
    if(m.kind!=="合同")return false;
    const title=String(m.name||"")+" "+String(m.file_name||"");
    return /劳务专家|专家劳务|劳务合同|专家合同|讲课合同|讲师合同|讲者合同|授课合同|劳务服务合同/.test(title)&&
      !/赞助合同|企业赞助|招商合同|会务合同|会务协议|会议服务合同|场地合同|酒店合同|采购合同|设备合同/.test(title);
  };
  const ledgerByKey=new Map((d.contracts||[]).filter(x=>x.file_key).map(x=>[x.file_key,x]));
  const meetingAgreement=m=>{
    if(!m?.file_key||m.version==="历史版")return false;
    const linked=ledgerByKey.get(m.file_key);
    if(linked)return linked.category==="会务需求";
    return m.kind==="会务协议"||(m.kind==="合同"&&
      /会务协议|会务合同|会议服务合同|会议执行合同|会务执行合同/.test((m.name||"")+" "+(m.file_name||"")));
  };
  const meetingInvoice=m=>m.file_key&&(m.kind==="会务发票"||
    (m.kind==="发票"&&/会务|会议服务|会议执行/.test((m.name||"")+" "+(m.file_name||""))));
  const sponsorKeys=new Set((d.sponsorRights?.contracts||[]).map(x=>x.file_key).filter(Boolean));
  const selected=(d.materials||[]).filter(m=>((names[no]||[]).includes(m.kind)&&\n    !(m.kind==="终版议程"&&m.version!=="终版"))||
    (no===5&&isLaborContract(m))||
    (no===6&&(meetingAgreement(m)||meetingInvoice(m)))||
    (no===7&&["赞助合同","合同"].includes(m.kind)&&sponsorKeys.has(m.file_key)));
  const step=d.verification.steps.find(x=>x.no===no);
  const contractTotal=(d.contracts||[]).filter(x=>x.status==="已签署" && x.category==="会务需求")
    .reduce((sum,x)=>sum+Number(x.amount||0),0);
  const meetingDemandTotal=Number(d.demand?.budgetTotal||0);
  const matchedContractIds=new Set(step?.evidence?.matchedContractMaterialIds||[]);
  const linkedContracts=(d.materials||[]).filter(x=>isLaborContract(x)&&
    matchedContractIds.has(Number(x.id)));
  const evidence=step?.evidence;
  return `<div class="dsec"><h4>业务核验规则</h4><div class="dchk">${esc(note[no]||"请核对资料")}</div></div>
    <div class="dsec"><h4>已登记的关联材料</h4>${matList(selected,"请在材料中心补充对应原件")}</div>
    ${no===6?'<div class="dsec"><h4>会务需求表（业务原始单据）</h4>'+
      '<div class="dchk">状态：'+(d.demand?.archived?'已确认归档':'尚未确认归档')+
      ' · 预算总额：'+fmt(d.demand?.budgetTotal||0)+'</div></div>':""}
    ${no===7?'<div class="dsec"><h4>赞助合同原件</h4>'+
      (d.sponsorRights?.contracts||[]).map(s=>'<div class="dchk"><b>'+esc(s.enterprise||s.id)+'</b> · '+
        esc(s.status||"未确认")+' · '+(s.file_key?
        '<a class="link" target="_blank" rel="noopener" href="/api/uploads/'+encodeURIComponent(s.file_key)+'">'+
        esc(s.file_name||"查看赞助合同原件")+'</a>':'合同原件缺失')+'</div>').join('')+'</div>'+
      '<div class="dsec"><h4>赞助合同权益逐项关联</h4>'+
      (d.sponsorRights?.requiredRights||[]).map(r=>{
        const sponsor=(d.sponsorRights?.contracts||[]).find(x=>x.id===r.sponsor_id);
        const photos=(d.sponsorRights?.photos||[]).filter(x=>Number(x.sponsor_right_id)===Number(r.id)&&x.file_key);
        return '<div class="dchk"><b>'+esc(sponsor?.enterprise||r.sponsor_id)+' · '+esc(r.category)+'</b> · '+(r.confirmed?'权益已确认':'待校正')+' · '+photos.length+' 张照片'+matList(photos,'请按权益二级类目上传照片')+'</div>';
      }).join("")+'</div>':""}
    ${no===6?`<div class="dgrid">${cell("会务需求总预算",fmt(meetingDemandTotal))}${cell("已签会务合同总额",fmt(contractTotal))}</div>${!d.demand?.archived?"<div class=\"dhint\">需求表尚未确认归档，不能完成第6项核验。</div>":""}`:""}
    ${no===5?`<div class="dsec"><h4>已关联劳务专家合同（材料库）</h4>
      ${matList(linkedContracts,"尚未匹配劳务专家合同，请上传对应专家的合同原件。")}
      <div class="hint">仅关联劳务专家合同；会务合同、赞助合同不进入核销第5项。合同正文与人员信息仍需人工核对。</div></div>`:""}
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
