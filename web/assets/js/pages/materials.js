import { api, can } from "../lib/api.js";
import { bindPager, esc, formHtml, modal, pager, panel, readForm, table, toast, validate } from "../lib/ui.js";
import { bindFilePicker, fileUrl } from "../lib/upload.js";

const PAGE_SIZE = 50;
let curPage = 1;

export async function render(root) {
  const d = await api.get(`/api/materials?page=${curPage}&size=${PAGE_SIZE}`);
  const complete = d.projects.filter((p) => p.missing.length === 0).length;

  root.innerHTML = `<div class="phead">
      <div><h2>材料中心</h2><p>归档必备 8 类：${d.kinds.join(" / ")}</p></div>
      <div class="acts">${can("material:write") ? '<button class="btn btn-p" id="add">+ 登记材料</button>' : ""}</div>
    </div>
    <div class="grid g4">
      <div class="kpi"><div class="t">材料条目</div><div class="v">${d.total}<span class="u">条</span></div></div>
      <div class="kpi k2"><div class="t">在管项目</div><div class="v">${d.projects.length}<span class="u">个</span></div></div>
      <div class="kpi k4"><div class="t">8 类齐备</div><div class="v">${complete}<span class="u">个</span></div></div>
      <div class="kpi k3"><div class="t">待补齐</div><div class="v">${d.projects.length - complete}<span class="u">个</span></div></div>
    </div>

    <div class="panel mt">
      <div class="panel-h"><h2>项目齐备情况</h2><span class="hint">缺项项目无法归档</span></div>
      ${table([{ t: "项目" }, { t: "状态", w: "84px" }, { t: "齐备度", w: "110px" }, { t: "缺失类别" }, { t: "操作", w: "90px" }],
        d.projects.map((p) => ({
          c: [`<a class="link" data-go="projects/${p.id}">${esc(p.name)}</a>`,
            p.status, `<b class="${p.missing.length ? "neg" : "pos"}">${8 - p.missing.length}/8</b>`,
            p.missing.length ? `<span style="color:var(--orange)">${p.missing.join("、")}</span>` : '<span style="color:var(--green)">齐备</span>',
            `<button class="link" data-go="projects/${p.id}">去补</button>`]
        })), { empty: "暂无项目" })}
    </div>

    <div class="panel">
      <div class="panel-h"><h2>材料清单</h2><span class="hint">共 ${d.total} 条</span></div>
      ${table([{ t: "项目", w: "170px" }, { t: "类别", w: "92px" }, { t: "名称" }, { t: "附件", w: "86px" },
        { t: "版本", w: "56px" }, { t: "上传人", w: "76px" }, { t: "时间", w: "130px" }],
        d.rows.map((m) => ({
          c: [`<a class="link" data-go="projects/${m.pid}">${esc(m.pname)}</a>`, esc(m.kind),
            esc(m.name),
            m.file_key
              ? (m.file_mime === "application/pdf" || /\.(docx|pptx|xlsx)$/i.test(m.file_key)
                  ? `<a class="link" href="${fileUrl(m.file_key)}" target="_blank" rel="noopener">${esc(m.file_name || "下载附件")}</a>`
                  : `<a href="${fileUrl(m.file_key)}" target="_blank" rel="noopener"><img class="thumb" src="${fileUrl(m.file_key)}" alt=""></a>`)
              : '<span style="color:var(--mute)">—</span>',
            esc(m.version || ""), esc(m.uploader || ""), `<span class="mono">${esc(m.created_at)}</span>`]
        })),
        { empty: "暂无材料" })}
      ${pager(d, { unit: "条" })}
    </div>`;

  bindPager(root, (n) => { curPage = n; render(root); });

  const add = root.querySelector("#add");
  if (add) add.onclick = () => openAdd(root, d.projects, d.kinds);
}

function openAdd(root, projects, kinds) {
  const fields = [
    { k: "pid", l: "所属项目", t: "select", req: 1, opts: projects.map((p) => ({ v: p.id, l: `${p.id} ${p.name}` })) },
    { k: "kind", l: "材料类别", t: "select", req: 1, custom: 1, ph: "如：会议纪要 / 专家简历",
      opts: [...kinds, "终版议程", "课件", "串场", "劳务收集表", "劳务协议", "讲者照片"].filter((v, i, a) => a.indexOf(v) === i),
      tip: "8 类是归档必备，建议优先选；确实不属于这 8 类的，选「自定义填入」自己写，能登记能查，但不顶替必备的那 8 类" },
    { k: "name", l: "材料名称", req: 1, ph: "如：签到表-终版.pdf" },
    { k: "version", l: "版本", v: "v1" },
    {
      k: "file", l: "附件", t: "file", full: 1,
      accept: "image/jpeg,image/png,image/webp,image/gif,application/pdf,.docx,.pptx,.xlsx",
      tip: "支持图片、PDF、DOCX、PPTX、XLSX（Office 2007 及以上格式），每份不超过 8 MB；讲者照片请在名称栏填写讲者姓名。图片可自动压缩。"
    }
  ];
  const m = modal({
    title: "登记材料",
    width: "620px",
    body: formHtml(fields),
    footer: `<button class="btn btn-o" data-x="0">取消</button><button class="btn btn-p" data-x="1">保存</button>`
  });

  let picked = null;
  bindFilePicker(m, "file", (f, err) => {
    if (err) { picked = null; toast(err, "warn"); return; }
    picked = f;
    // 名称留空时自动用文件名，省一次输入
    const nameInput = m.querySelector('[name="name"]');
    if (nameInput && !nameInput.value.trim()) nameInput.value = f.name;
  });

  m.querySelector('[data-x="0"]').onclick = () => m.classList.remove("open");
  const btn = m.querySelector('[data-x="1"]');
  btn.onclick = async () => {
    if (!validate(m, fields)) return;
    const v = readForm(m);
    if (!v.name && picked) v.name = picked.name;
    if (!String(v.name || "").trim()) { toast("请填写材料名称或选择附件", "warn"); return; }

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
      await api.post(`/api/projects/${v.pid}/materials`, { ...v, ...meta });
      toast(picked ? "材料与附件已登记" : "材料已登记", "ok");
      m.classList.remove("open");
      await render(root);
    } catch (e) {
      toast(e.message, "warn");
      btn.disabled = false;
      btn.textContent = "保存";
    }
  };
}
