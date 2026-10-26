import { api, can, state } from "../lib/api.js";
import { badge, esc, formHtml, modal, money, panel, readForm, table, toast, validate } from "../lib/ui.js";
import { bindFilePicker, fileUrl } from "../lib/upload.js";

let q = "";

/** 合同原件单元格：图片出缩略图，PDF 出标签，都能新窗口打开 */
function fileCell(c) {
  if (!c.file_key) return '<span style="color:var(--mute)">—</span>';
  const url = fileUrl(c.file_key);
  if (c.file_mime === "application/pdf") {
    return `<a class="link" href="${url}" target="_blank" rel="noopener" title="${esc(c.file_name || "合同原件")}">PDF</a>`;
  }
  return `<a href="${url}" target="_blank" rel="noopener" title="${esc(c.file_name || "合同原件")}">
    <img class="thumb" src="${url}" alt=""></a>`;
}

export async function render(root) {
  const [c, proj] = await Promise.all([api.get("/api/contracts"), api.get("/api/projects")]);
  const rows = c.rows.filter((r) => !q || (r.name + r.vendor + r.pname + r.id).includes(q));
  const total = rows.reduce((s, r) => s + r.amount, 0);
  const signed = rows.filter((r) => r.status === "已签署").reduce((s, r) => s + r.amount, 0);
  const withFile = rows.filter((r) => r.file_key).length;

  root.innerHTML = `<div class="phead">
      <div><h2>合同台账</h2><p>合同金额是核销第 6 步与付款金额的比对基准</p></div>
      <div class="acts">
        <button class="btn btn-o" id="exp">导出 CSV</button>
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
         { t: "原件", w: "70px" }],
        rows.map((r) => ({
          c: [`<span class="mono">${r.id}</span>`, `<a class="link" data-go="projects/${r.pid}">${esc(r.pname)}</a>`,
            esc(r.name), esc(r.vendor), `¥${money(r.amount)}`, `<span class="mono">${esc(r.sign_date || "—")}</span>`,
            badge(r.status), fileCell(r)]
        })), { empty: "暂无合同" })}
    </div>`;

  root.querySelector("#q").addEventListener("input", (e) => { q = e.target.value.trim(); render(root); });
  root.querySelector("#exp").onclick = async () => {
    try { const r = await api.download("/api/export/contracts"); toast(`已导出 ${r.name}`, "ok"); }
    catch (e) { toast(e.message, "warn"); }
  };
  const nb = root.querySelector("#newC");
  if (nb) nb.onclick = () => openCreate(root, proj.rows);
}

function openCreate(root, projects) {
  const fields = [
    { k: "pid", l: "所属项目", t: "select", req: 1, opts: projects.map((p) => ({ v: p.id, l: `${p.id} ${p.name}` })) },
    { k: "name", l: "合同名称", req: 1, full: 1 },
    { k: "vendor", l: "签约方", req: 1 },
    { k: "amount", l: "合同金额（元）", t: "number", req: 1 },
    { k: "sign_date", l: "签署日期", t: "date" },
    { k: "status", l: "状态", t: "select", opts: ["草稿", "待签署", "已签署"] },
    {
      k: "file", l: "合同原件", t: "file", full: 1,
      accept: "image/jpeg,image/png,image/webp,image/gif,application/pdf",
      tip: "可上传盖章扫描件 PDF 或手机拍照件，单个不超过 8 MB。图片会在本地压缩后上传，PDF 原样保存。"
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
          onProgress: (p) => { btn.textContent = `上传中 ${Math.round(p * 100)}%`; }
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
