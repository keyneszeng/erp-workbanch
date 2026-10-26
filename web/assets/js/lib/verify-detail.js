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

function matList(list, emptyText) {
  if (!list.length) return `<div class="dhint">${emptyText}</div>`;
  return `<ul class="dlist">${list.map((m) => `<li>
      <b>${esc(m.name)}</b>
      ${m.version ? `<span class="dtag">${esc(m.version)}</span>` : ""}
      ${m.file_name ? `<span class="dtag">${esc(m.file_name)}</span>` : ""}
      <span class="dm">${esc(m.uploader || "—")} · ${esc(dt(m.created_at))}</span>
      ${m.file_key
        ? `<a class="link" href="/api/uploads/${m.file_key}" target="_blank" rel="noopener">查看原件</a>`
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
export function stepBody(d, no) {
  const p = d.project;
  const agenda = agendaItems(p);

  if (no === 1) {
    const ag = matsOf(d, "议程");
    const cw = matsOf(d, "课件");
    return `
      <div class="dsec"><h4>登记的议程环节（项目资料）</h4>
        ${agenda.length
          ? `<ul class="dlist">${agenda.map((a, i) => `<li><span class="dtag">${i + 1}</span><b>${esc(a)}</b></li>`).join("")}</ul>`
          : `<div class="dhint">项目资料里没有填写议程要点</div>`}
      </div>
      <div class="dsec"><h4>议程材料（${ag.length} 份）</h4>${matList(ag, "尚未登记「议程」材料")}</div>
      <div class="dsec"><h4>课件材料（${cw.length} 份）</h4>${matList(cw, "尚未登记「课件」材料")}</div>
      <div class="dchk">核对要点：<b>实际执行的议程环节</b>与上面登记的版本是否一致（增、删、调序都算变更）。
        登记议程 ${agenda.length} 个环节，已上传课件 ${cw.length} 份。</div>`;
  }

  if (no === 2) {
    const sign = matsOf(d, "签到表");
    const people = Number(p.people) || 0;
    const gate = Math.ceil(people * 0.85);
    return `
      <div class="dsec"><h4>人数口径</h4>
        <div class="dgrid">
          ${cell("报名人数（项目资料）", people)}
          ${cell("达标门槛（报名 × 85%）", gate)}
          ${cell("已登记签到表", `${sign.length} 份`, sign.length === 0)}
        </div>
      </div>
      <div class="dsec"><h4>签到表材料</h4>${matList(sign, "尚未登记「签到表」材料")}</div>
      <div class="dchk">核对要点：打开签到表原件，<b>实际签到人数 ≥ ${gate}</b>（报名 ${people} 人的 85%），
        且名单可与报名记录逐条对上。签到表没有附件就无法核对，应判不通过并生成例外单。</div>`;
  }

  if (no === 3) {
    const inv = matsOf(d, "发票");
    const pic = matsOf(d, "现场照片");
    const byType = {};
    for (const y of d.payments || []) {
      if (y.status === "已驳回") continue;
      byType[y.type] = round2((byType[y.type] || 0) + Number(y.amount));
    }
    return `
      <div class="dsec"><h4>费用构成（按付款类型，不含已驳回）</h4>
        ${Object.keys(byType).length
          ? `<div class="dgrid">${Object.entries(byType).map(([k, v]) => cell(esc(k), fmt(v))).join("")}</div>`
          : `<div class="dhint">该项目还没有付款记录</div>`}
      </div>
      <div class="dsec"><h4>发票 / 票据材料（${inv.length} 份）</h4>${matList(inv, "尚未登记「发票」材料")}</div>
      <div class="dsec"><h4>现场照片（${pic.length} 份）</h4>${matList(pic, "尚未登记「现场照片」材料")}</div>
      <div class="dchk">核对要点：<b>场地、餐饮、物料</b>三类支出是否都有对应票据，票据金额能否与上面的费用构成对上。
        现场照片用于佐证活动确实举办，本身不是金额凭证。</div>`;
  }

  if (no === 4) {
    const cw = matsOf(d, "课件");
    return `
      <div class="dsec"><h4>议程环节（应各有对应课题）</h4>
        ${agenda.length
          ? `<ul class="dlist">${agenda.map((a, i) => `<li><span class="dtag">${i + 1}</span><b>${esc(a)}</b></li>`).join("")}</ul>`
          : `<div class="dhint">项目资料里没有填写议程要点</div>`}
      </div>
      <div class="dsec"><h4>课件清单（${cw.length} 份）</h4>${matList(cw, "尚未登记「课件」材料")}</div>
      <div class="dchk">核对要点：<b>每一份课件都能对应到上面的某个议程课题</b>。
        议程 ${agenda.length} 个环节、课件 ${cw.length} 份 —— 数量不等不一定有问题（一个环节可能多份课件），
        但出现对不上议程的课件，说明实际内容与立项版本不符。</div>`;
  }

  if (no === 5) {
    const labor = matsOf(d, "劳务表");
    const reimb = (d.payments || []).filter((y) => y.type === "个人报销");
    const contracts = d.contracts || [];
    return `
      <div class="dsec"><h4>劳务表材料（${labor.length} 份）</h4>${matList(labor, "尚未登记「劳务表」材料")}</div>
      <div class="dsec"><h4>合同清单（${contracts.length} 份）</h4>
        ${contracts.length
          ? table([{ t: "编号", w: "104px" }, { t: "合同名称" }, { t: "签约方", w: "140px" },
                   { t: "金额", w: "96px", cls: "num" }, { t: "状态", w: "72px" }],
            contracts.map((c) => ({ c: [`<span class="mono">${c.id}</span>`, esc(c.name), esc(c.vendor),
              fmt(c.amount), badge(c.status)] })))
          : `<div class="dhint">该项目还没有录入合同</div>`}
      </div>
      <div class="dsec"><h4>专家费 / 个人报销类付款（${reimb.length} 笔）</h4>${payRows(reimb)}</div>
      <div class="dchk">核对要点：<b>劳务表签字是否齐全</b>（每位专家都要签），
        专家费金额是否与合同或劳务表约定一致，且与上面的付款记录能对上。</div>`;
  }

  if (no === 6) {
    const inv = matsOf(d, "发票");
    const contracts = d.contracts || [];
    const contractTotal = round2(contracts.reduce((s, c) => s + Number(c.amount), 0));
    const paid = round2(d.paidTotal);
    const diff = round2(contractTotal - paid);
    const hasDiff = cents(contractTotal) !== cents(paid);
    return `
      <div class="dsec"><h4>三方金额对照</h4>
        <div class="dgrid">
          ${cell("合同总额", fmt(contractTotal), contracts.length === 0)}
          ${cell("已付款合计", fmt(paid))}
          ${cell("差额（合同 − 已付）", fmt(diff), hasDiff)}
        </div>
      </div>
      <div class="dsec"><h4>发票材料（${inv.length} 份）</h4>${matList(inv, "尚未登记「发票」材料")}</div>
      <div class="dchk">核对要点：<b>发票金额 = 合同金额 = 付款金额</b>。
        合同 ${contracts.length} 份合计 ${fmt(contractTotal)}，已付款 ${fmt(paid)}。
        ${hasDiff
          ? `两者相差 <b>${fmt(diff)}</b> —— 若差额有正当理由（分期付款 / 部分结算 / 尾款未付），需在备注里写清楚。`
          : "两者一致。"}</div>`;
  }

  return `<div class="dhint">暂无该步骤的核对数据</div>`;
}

/**
 * 打开某一步的详情弹窗。
 * @param {object} d    核销/项目详情数据
 * @param {number} no   步骤号 1~6
 * @param {object} opt  { canJudge:boolean, onJudge:Function } —— 看完数据可直接判定
 */
export function openStepDetail(d, no, opt = {}) {
  const s = d.verification.steps.find((x) => x.no === no);
  const prevUnjudged = d.verification.steps.some((x) => x.no < no && x.result === "待判定");
  const canJudgeThis = !!opt.canJudge && !prevUnjudged;

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
