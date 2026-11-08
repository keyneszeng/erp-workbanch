import { api, can, state } from "../lib/api.js";
import { badge, bindSearchRefresh, confirmBox, promptBox, esc, formHtml, modal, money, panel, readForm, table, toast, validate } from "../lib/ui.js";
import { bindFilePicker, UPLOAD_ACCEPT, UPLOAD_TIP } from "../lib/upload.js";
import { flowHint, flowOf, openContractDetail } from "../lib/contract-detail.js";
import { openContractMaterialReplace } from "../lib/contract-material-replace.js";

let q = "";
let renderSeq = 0;

/**
 * 合同状态流转按钮：草稿 → 待签署（提交）→ 已签署（确认）。
 * 判断走 lib/contract-detail.js 的 flowOf —— 详情弹窗、台账、项目详情三处同源，
 * 否则改了权限口径很容易只改一处，出现「列表能点、弹窗不能点」。
 */
function flowBtn(c) {
  const f = flowOf(c);
  if (f) return `<button class="link" data-cflow="${c.id}" data-caction="${f.action}">${f.label}</button>`;
  const hint = flowHint(c);
  return hint
    ? `<span style="color:var(--mute)" title="${esc(hint)}">${c.status === "待签署" ? "待协会确认" : "—"}</span>`
    : '<span style="color:var(--mute)">—</span>';
}

/**
 * 原件列：给一个明确的「详情」入口。
 *
 * 原来这里只有一个「PDF」二字或 40px 缩略图，点开是新窗口里的裸文件 ——
 * 责任人要核对条款时，得自己把「哪份合同、跟谁签、多少钱」重新对一遍。
 * 现在点详情直接在弹窗里看原件（PDF 内嵌、图片铺开），上下文和下一步动作都在同一屏。
 */
function fileCell(c) {
  const tag = !c.file_key ? "无原件" : c.file_mime === "application/pdf" ? "PDF" : /^image\//.test(c.file_mime||"") ? "图片" : String(c.file_key).split(".").pop().toUpperCase();
  return `<button class="link" data-cdet="${c.id}"
    title="${esc(c.file_key ? c.file_name || "查看合同原件" : "查看合同详情")}">详情<span class="ftag${c.file_key ? "" : " off"}">${tag}</span></button>`;
}

export async function render(root) {
  const seq = ++renderSeq;
  const [c, proj] = await Promise.all([api.get("/api/contracts"), api.get("/api/projects")]);
  if (seq !== renderSeq) return;
  const rows = c.rows.filter((r) => !q || (r.name + r.vendor + r.pname + r.id).includes(q));
  const total = rows.reduce((s, r) => s + Number(r.amount || 0), 0);
  const signed = rows.filter((r) => r.status === "已签署").reduce((s, r) => s + Number(r.amount || 0), 0);
  const withFile = rows.filter((r) => r.file_key).length;

  root.innerHTML = `<div class="phead">
      <div><h2>合同台账</h2><p>合同按类别归集；会务费用在核销第6项与需求预算、发票比对；劳务个人合同在材料库按姓名核验</p></div>
      <div class="acts">
        ${can("export:any") ? '<button class="btn btn-o" id="exp">导出 CSV</button>' : ""}
        ${can("contract:write") ? '<button class="btn btn-p" id="newC">+ 录入合同</button>' : ""}
      </div>
    </div>
    <div class="grid g4">
      <div class="kpi"><div class="t">合同数</div><div class="v">${rows.length}<span class="u">份</span></div></div>
      <div class="kpi k2"><div class="t">合同总额</div><div class="v">¥${money(total)}</div></div>
      <div class="kpi k4"><div class="t">已签署金额</div><div class="v">¥${money(signed)}</div></div>
      <div class="kpi k3"><div class="t">已传原件</div><div class="v">${withFile}<span class="u">/${rows.length}</span></div></div>
    </div>
    <div class="panel mt">
      <div class="panel-h"><h2>合同清单</h2><span class="hint">${rows.length} 份</span></div>
      <div class="filters"><input type="search" id="q" placeholder="搜索合同 / 签约方 / 项目" value="${esc(q)}"></div>
      ${table(
        [{ t: "合同编号", w: "112px" }, { t: "项目", w: "170px" }, { t: "合同名称" }, { t: "签约方", w: "150px" },
         { t: "金额", w: "104px", cls: "num" }, { t: "签署日期", w: "100px" }, { t: "状态", w: "80px" },
         { t: "原件", w: "104px" }, { t: "操作", w: "150px" }],
        rows.map((r) => ({
          c: [`<span class="mono">${r.id}</span>`, `<a class="link" data-go="projects/${r.pid}">${esc(r.pname)}</a>`,
            `${esc(r.name)}<span class="cat">${esc(r.category || "未分类")}</span>`,
            esc(r.vendor), `¥${money(r.amount)}`, `<span class="mono">${esc(r.sign_date || "—")}</span>`,
            badge(r.status), fileCell(r), flowBtn(r)+(r.status==="待签署"&&can("contract:approve")?` <button class="link danger" data-cflow="${r.id}" data-caction="reject">驳回</button>`:"")+
            (can("material:file:replace") && r.file_key && r.material_id &&
              !["已核销","已结算","已归档"].includes(r.pstatus)
              ? ` <button class="link" data-replace-ledger-file="${r.material_id}">修改</button>` : "")]
        })), { empty: "暂无合同" })}
    </div>`;

  bindSearchRefresh(root, "#q", value => { q = value; }, () => render(root));
  const expBtn = root.querySelector("#exp");
  if (expBtn) expBtn.onclick = async () => {
    try { const r = await api.download("/api/export/contracts"); toast(`已导出 ${r.name}`, "ok"); }
    catch (e) { toast(e.message, "warn"); }
  };
  const nb = root.querySelector("#newC");
  if (nb) nb.onclick = () => openCreate(root, proj.rows);
  root.querySelectorAll("[data-cflow]").forEach((b) => b.onclick = () => {
    if(b.dataset.caction==="sign") {
      const row=rows.find(c=>c.id===b.dataset.cflow);
      if(row){openContractDetail(row,{startConfirm:true,onDone:()=>render(root)});return;}
    }
    return contractFlow(root,b.dataset.cflow,b.dataset.caction);
  });
  // 详情弹窗：从当前过滤后的 rows 里取，避免为了看一眼原件再打一次接口
  root.querySelectorAll("[data-replace-ledger-file]").forEach(b=>b.onclick=()=>{
    const row=rows.find(r=>Number(r.material_id)===Number(b.dataset.replaceLedgerFile));
    if(!row)return;
    openContractMaterialReplace({id:row.material_id,pid:row.pid,kind:"合同",
      name:row.name,file_key:row.file_key,file_name:row.file_name},()=>render(root));
  });
  root.querySelectorAll("[data-cdet]").forEach((b) => {
    b.onclick = () => {
      const row = rows.find((r) => r.id === b.dataset.cdet);
      if (row) openContractDetail(row, { onDone: () => render(root) });
    };
  });
}

/** 合同两步流转：提交签署 → 确认签署（确认时签署日期记为今天，可在台账核对） */
async function contractFlow(root, id, action) {
  let reason="";
  if(action==="reject"){
    reason=await promptBox({title:"驳回合同签署",label:"驳回理由（4～500 字）",ok:"确认驳回"});
    if(!reason)return;
  }
  if (action === "sign") {
    const ok = await confirmBox(
      `确认合同 <b class="mono">${esc(id)}</b> 已签署？<br><br>签署日期默认记为今天，台账里可核对。`,
      { title: "确认签署", ok: "确认签署" }
    );
    if (!ok) return;
  }
  try {
    const r = await api.post(`/api/contracts/${id}/transition`, { action, ...(action==="reject"?{reason}:{}) });
    toast(r.message, "ok");
    await render(root);
  } catch (e) { toast(e.message, "warn"); }
}

function openCreate(root, projects) {
  const fields = [
    { k: "pid", l: "所属项目", t: "select", req: 1, opts: projects.map((p) => ({ v: p.id, l: `${p.id} ${p.name}` })) },
    { k: "name", l: "合同名称", req: 1, full: 1 },
    { k: "vendor", l: "签约方", req: 1 },
    { k: "amount", l: "合同金额（元）", t: "number", req: 1 },
    { k: "category", l: "合同类别", t: "select", opts: state.meta.contractCategories || [],
      tip: "合同类别用于台账和会务费用核对；第5项需在材料库按完整姓名匹配个人劳务合同，不能用台账合同替代。第6项核对实际会务需求、已签会务合同和会务发票。" },
    { k: "sign_date", l: "签署日期", t: "date" },
    // 录入只能选草稿 / 待签署：已签署必须走「确认签署」，
    // 否则两步流转等于没做，台账上的「已签署金额」也没有可信来源
    { k: "status", l: "状态", t: "select", opts: ["草稿", "待签署"], tip: "录入后必须由有权人员确认签署，不能在新建时跳过确认流程" },
    {
      k: "file", l: "合同原件", t: "file", full: 1,
      accept: UPLOAD_ACCEPT,
      tip: UPLOAD_TIP
    }
  ];
  const m = modal({
    title: "录入合同",
    width: "620px",
    body: formHtml(fields),
    footer: `<button class="btn btn-o" data-x="0">取消</button><button class="btn btn-p" data-x="1">保存</button>`
  });

  let picked = null;
  bindFilePicker(m, "file", (f, err) => {
    if (err) { picked = null; toast(err, "warn"); return; }
    picked = f;
    // 名称留空时用文件名去掉扩展名，省一次输入
    const nameInput = m.querySelector('[name="name"]');
    if (nameInput && !nameInput.value.trim()) {
      nameInput.value = f.name.replace(/\.[^.]+$/, "").slice(0, 80);
    }
  });

  m.querySelector('[data-x="0"]').onclick = () => m.classList.remove("open");
  const btn = m.querySelector('[data-x="1"]');
  btn.onclick = async () => {
    if (!validate(m, fields)) return;
    const v = readForm(m);

    btn.disabled = true;
    try {
      let meta = {};
      if (picked) {
        btn.textContent = "上传中 0%";
        const up = await api.upload(picked, {
          onProgress: (p) => { btn.textContent = `上传中 ${Math.round(p * 100)}%`; },
          pid: v.pid
        });
        meta = { file_key: up.key, file_name: up.name, file_size: up.size, file_mime: up.mime };
      }
      btn.textContent = "保存中…";
      const r = await api.post("/api/contracts", { ...v, ...meta });
      // 附件回执和超预算预警都要说，不能因为预警把「原件已附上」吞掉
      const base = picked ? `${r.message}，原件已附上` : r.message;
      toast(r.warning ? `${base}；${r.warning}` : base, r.warning ? "warn" : "ok");
      m.classList.remove("open");
      await render(root);
    } catch (e) {
      toast(e.message, "warn");
      btn.disabled = false;
      btn.textContent = "保存";
    }
  };
}
