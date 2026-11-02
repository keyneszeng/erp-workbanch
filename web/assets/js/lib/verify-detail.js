import { badge, esc, modal, money, table } from "./ui.js";
import { fileLink } from "./file-preview.js";
import { api } from "./api.js";

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
        ? fileLink(m.file_key, m.file_name || m.name, `${m.file_name || m.name} · 在线查看原件`)
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
   * 关联材料直接读接口返回的 step.materials —— 与服务端 meeting-sop.js 校验用的是
   * 同一份定义（server/lib/constants.js 的 VERIFY_STEPS）。
   *
   * 以前这里硬编码了一份显示名（终版议程 / 参会数据 / 拟结算单），
   * 和服务端真正校验的材料类别对不上，页面说「要核 A」、系统却要求 B，
   * 核销人一直撞墙。现在只保留一份，前端不再自己维护。
   */
  const step=d.verification.steps.find(x=>x.no===no);
  const names=(step?.materials||[]).slice();
  // 同一份材料在不同环节叫法不同（劳务表/劳务收集表、签到表/参会数据），
  // 服务端两种都认，页面也要列出来，否则只传了其中一种的人会以为缺件。
  for(const alt of step?.altMaterials||[]) if(!names.includes(alt)) names.push(alt);
  const note={
    1:"盖章函件与立项信息逐项核对：会议名称/日期/主办方/招商主体。",
    2:"终版议程、劳务收集表、劳务协议名单三处互相覆盖，无冒领/漏发；劳务协议以已签署的劳务/专家类合同为准。",
    3:"线上有效讲者在线时长 >30 分钟；线下有签到；混合两项都需要。",
    4:"课件课题匹配终版议程，串场题目及主办方 logo 匹配；药企 logo 只允许首页、尾页、鸣谢页。",
    5:"劳务收集表与劳务/专家类合同逐人比对姓名/时间/角色/金额/银行账号；银行账号不保存在核销证据中。",
    6:"已签合同总额须等于拟请款总额，发票金额须等于需开票合同总额；专家劳务按第五步核验的协议与劳务表免票请款。"
  };
  const selected=(d.materials||[]).filter(m=>names.includes(m.kind));
  const contractTotal=(d.contracts||[]).filter(x=>x.status==="已签署").reduce((sum,x)=>sum+Number(x.amount||0),0);
  const laborContracts=(d.contracts||[]).filter(x=>x.category==="劳务专家");
  const expertPayments=(d.payments||[]).filter(x=>["专家费","个人报销"].includes(x.type));
  const evidence=step?.evidence;
  return `<div class="dsec"><h4>业务核验规则</h4><div class="dchk">${esc(note[no]||"请核对资料")}</div></div>
    <div class="dsec"><h4>已登记的关联材料（${esc(names.join(" / ")||"—")}）</h4>${matList(selected,"请在材料中心补充对应原件")}</div>
    ${selected.length?`<div class="dsec"><h4>文件内容 OCR</h4>
      <div class="dhint" style="margin-bottom:8px">把本步关联的原件识别成文字，方便逐项对照；结果仅供辅助，判定仍须以原件为准。</div>
      <button class="btn btn-o btn-sm" type="button" data-step-ocr="${no}">识别本步 ${selected.length} 份原件</button>
      <span class="hint" data-step-ocr-hint style="margin-left:8px"></span>
      <div data-step-ocr-out></div>
      <div data-step-names-out></div>
    </div>`:""}
    ${no===6?`<div class="dgrid">${cell("已签合同总额",fmt(contractTotal))}${cell("核销发票总金额",step?.invoiceAmount==null?"未核对":fmt(step.invoiceAmount))}</div>`:""}
    ${[2,5].includes(no)?`<div class="dsec"><h4>劳务 / 专家类合同（合同分类）${no===2?"· 可代替劳务协议":""}</h4>
      ${laborContracts.length?table([{t:"合同名称"},{t:"合同收款方"},{t:"金额"},{t:"原件"}],
      laborContracts.map(x=>({c:[esc(x.name),esc(x.vendor),fmt(x.amount),x.file_key?fileLink(x.file_key,x.file_name||`${x.name}原件`,"在线查看合同原件"):"未上传"]}))):'<div class="dhint">暂无劳务专家类合同，请先到合同台账核验分类</div>'}
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
/** 复制到剪贴板：优先用 Clipboard API，非 HTTPS 环境退回复制文本域 */
async function copyText(text) {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {}
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.style.cssText = "position:fixed;left:-9999px;top:0";
  document.body.appendChild(ta);
  ta.select();
  let ok = false;
  try { ok = document.execCommand("copy"); } catch {}
  document.body.removeChild(ta);
  return ok;
}

/**
 * 第 2 步的姓名面板：合并名单可直接复制，差异项单独提示。
 * 判定人要的是「三处名单一致」，所以一致的部分不用细看，差异才是重点。
 */
function renderNames(box, names) {
  if (!box) return;
  if (!names || !names.union.length) { box.innerHTML = ""; return; }
  const diff = (names.onlyIn || []).filter((x) => x.names.length);
  box.innerHTML = `
    <div style="margin-top:14px;padding:12px 14px;border:1px solid var(--line);border-radius:8px;background:#fbfcfe">
      <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
        <b>姓名提取</b>
        <span class="hint">共 ${names.union.length} 人 · 来自 ${names.bySource.length} 份材料</span>
        <span style="flex:1"></span>
        <button class="btn btn-o btn-sm" type="button" data-copy-names>复制全部姓名</button>
      </div>
      <div class="dchk" style="margin-top:8px">合并名单（去重）：<b>${esc(names.union.join("、"))}</b></div>
      <div style="margin-top:8px">
        ${names.bySource.map((s) => `<div class="hint">· ${esc(s.kind)}（${s.names.length} 人）：${esc(s.names.join("、") || "未提取到")}</div>`).join("")}
      </div>
      ${names.bySource.length < 2
        ? `<div class="hint" style="margin-top:8px">只有 1 份材料提取到姓名，无法做三处比对；请确认其余原件是否已上传。</div>`
        : diff.length
          ? `<div class="fp-note" style="margin-top:10px"><b>需要人工核对：以下姓名没有出现在全部材料里</b>
               ${diff.map((x) => `${esc(x.kind)} 独有 ${esc(x.names.join("、"))}`).join("；")}</div>`
          : `<div class="hint" style="margin-top:8px">✓ 各来源姓名完全一致（共 ${names.common.length} 人）</div>`}
    </div>`;
  const btn = box.querySelector("[data-copy-names]");
  if (btn) btn.onclick = async () => {
    const ok = await copyText(names.union.join("\n"));
    btn.textContent = ok ? "已复制" : "复制失败";
    setTimeout(() => { btn.textContent = "复制全部姓名"; }, 1600);
  };
}

export function openStepDetail(d, no, opt = {}) {
  const s = d.verification.steps.find((x) => x.no === no);
  const prevUnjudged = d.verification.steps.some((x) => x.no < no && !["通过","已解例外"].includes(x.result));
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
  const ocrBtn = m.querySelector("[data-step-ocr]");
  if (ocrBtn) {
    const out = m.querySelector("[data-step-ocr-out]");
    const hint = m.querySelector("[data-step-ocr-hint]");
    const label = ocrBtn.textContent;
    ocrBtn.onclick = async () => {
      ocrBtn.disabled = true;
      ocrBtn.textContent = "识别中，请稍候（首次可能要十几秒）…";
      hint.textContent = "";
      try {
        const r = await api.post(`/api/projects/${d.project.id}/verify/steps/${no}/ocr`, {});
        if (r.message) { hint.textContent = r.message; return; }
        const ok = r.items.filter((x) => !x.error).length;
        hint.textContent = `已识别 ${ok}/${r.items.length} 份`;
        out.innerHTML = r.items.map((it) => it.error
          ? `<div class="fp-note" style="margin-top:10px"><b>${esc(it.kind)} · ${esc(it.name)}</b><br>识别失败：${esc(it.error)}</div>`
          : `<details style="margin-top:10px">
               <summary><b>${esc(it.kind)}</b> · ${esc(it.name)}
                 <span class="dtag">${esc(it.engine)}</span>${it.cached ? '<span class="dtag">已缓存</span>' : ""}</summary>
               <pre style="white-space:pre-wrap;max-height:240px;overflow:auto;font-size:12px;background:#f6f8fb;padding:10px;border-radius:6px">${esc(it.text || "（未识别到文字）")}</pre>
             </details>`).join("");
        // 姓名提取只属于第 2 步；其他步骤即使接口带了也不渲染
        if (no === 2) renderNames(m.querySelector("[data-step-names-out]"), r.names);
      } catch (e) {
        hint.textContent = e.message;
      } finally {
        ocrBtn.disabled = false;
        ocrBtn.textContent = label.replace(/^识别/, "重新识别");
      }
    };
  }

  m.querySelector('[data-x="0"]').onclick = () => m.classList.remove("open");
  if (canJudgeThis && typeof opt.onJudge === "function") {
    m.querySelector('[data-x="1"]').onclick = () => {
      m.classList.remove("open");
      opt.onJudge(no);
    };
  }
}
