import { api, can } from "../lib/api.js";
import { bindPager, esc, formHtml, modal, pager, panel, readForm, table, toast, validate } from "../lib/ui.js";
import { checkFile, compressImage, fileUrl, UPLOAD_ACCEPT, UPLOAD_TIP } from "../lib/upload.js";

const PAGE_SIZE = 50;
let curPage = 1;

export async function render(root) {
  const d = await api.get(`/api/materials?page=${curPage}&size=${PAGE_SIZE}`);
  const complete = d.projects.filter((p) => p.uploadedCount > 0).length;

  root.innerHTML = `<div class="phead">
      <div><h2>材料中心</h2><p>材料类别自由选择 · 上传后按会议归档，不再要求固定类别</p></div>
      <div class="acts">${can("material:write") ? '<button class="btn btn-p" id="add">+ 登记材料</button>' : ""}</div>
    </div>
    <div class="grid g4">
      <div class="kpi"><div class="t">材料条目</div><div class="v">${d.total}<span class="u">条</span></div></div>
      <div class="kpi k2"><div class="t">在管项目</div><div class="v">${d.projects.length}<span class="u">个</span></div></div>
      <div class="kpi k4"><div class="t">已有附件项目</div><div class="v">${complete}<span class="u">个</span></div></div>
      <div class="kpi k3"><div class="t">尚未上传附件</div><div class="v">${d.projects.length - complete}<span class="u">个</span></div></div>
    </div>

    <div class="panel mt">
      <div class="panel-h"><h2>项目材料上传情况</h2><span class="hint">任意类别上传至少一份附件即可进入后续流程</span></div>
      ${table([{ t: "项目" }, { t: "状态", w: "84px" }, { t: "上传原件", w: "110px" }, { t: "类别数" }, { t: "操作", w: "90px" }],
        d.projects.map((p) => ({
          c: [`<a class="link" data-go="projects/${p.id}">${esc(p.name)}</a>`,
            p.status, `<b class="${p.uploadedCount ? "pos" : "neg"}">${p.uploadedCount || 0} 份</b>`,
            esc(String(p.have?.length || 0))+" 类 · "+(p.uploadedCount ? "已满足材料条件" : "待上传附件"),
            `<button class="link" data-go="projects/${p.id}">查看</button>`]
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
              ? (m.file_mime === "application/pdf" || /\.(doc|docx|ppt|pptx|xls|xlsx|csv|txt)$/i.test(m.file_key)
                  ? `<a class="link" href="${fileUrl(m.file_key)}" target="_blank" rel="noopener">${esc(m.file_name || "下载附件")}</a>`
                  : `<a href="${fileUrl(m.file_key)}" target="_blank" rel="noopener"><img class="thumb" src="${fileUrl(m.file_key)}" alt=""></a>`)
              : '<span style="color:var(--mute)">—</span>',
            esc(m.version || ""), esc(m.uploader || ""), `<span class="mono">${esc(m.created_at)}</span>`]
        })),
        { empty: "暂无材料" })}
      ${pager(d, { unit: "条" })}
    </div>
`;

  bindPager(root, (n) => { curPage = n; render(root); });

  const add = root.querySelector("#add");
  if (add) add.onclick = () => openMaterialRegistration(root, d.projects, d.kinds);
}

export function openMaterialRegistration(root, projects, kinds, defaultPid="", onSaved=null) {
  const fields = [
    { k: "pid", l: "所属项目", t: "select", req: 1, v:defaultPid, opts: projects.map((p) => ({ v: p.id, l: `${p.id} ${p.name}` })) },
    { k: "kind", l: "材料类别", t: "select", req: 1, custom: 1, ph: "如：盖章会议通知 / 招商函 / 终版议程 / 讲者照片",
      opts: [...kinds, "会议通知", "招商函", "终版议程", "课件", "串场", "劳务收集表", "劳务协议", "讲者照片", "权益照片"].filter((v, i, a) => a.indexOf(v) === i),
      tip: "可任选类别或自定义类别；不要求固定类别全部上传。至少上传一份实际附件即可满足流程材料条件。" },
    { k: "name", l: "材料名称", req: 1, ph: "如：签到表-终版.pdf" },
    { k: "version", l: "版本", v: "v1" },
    {
      k: "file", l: "附件", t: "file", full: 1,
      accept: UPLOAD_ACCEPT,
      tip: UPLOAD_TIP+" 讲者照片请在名称栏填写讲者姓名。"
    }
  ];
  const m = modal({
    title: "登记材料",
    width: "620px",
    body: formHtml(fields),
    footer: `<button class="btn btn-o" data-x="0">取消</button><button class="btn btn-p" data-x="1">保存</button>`
  });

  // 每个文件独立登记一个材料记录，保留既有原件/审计/版本约束。
  const picker=m.querySelector('input[name="file"]');
  picker.multiple=true;
  let picked=[];
  const kindSelect=m.querySelector('[name="kind"]');
  // 终版议程只需上传一个文件，名称自动取文件名，版本自动确认为终版。
  const syncAgendaForm=()=>{
    const final=kindSelect.value==="终版议程";
    for(const field of ["name","version"]){
      const el=m.querySelector('[name="'+field+'"]');
      if(el?.closest(".fld"))el.closest(".fld").style.display=final?"none":"";
    }
    picker.multiple=!final;
    const tip=m.querySelector(".upload")?.closest(".fld")?.querySelector(".tip");
    if(tip)tip.textContent=final
      ? "仅需上传一份终版议程文件，保存即确认；无需填写讲者、课题或生成待办。"
      : UPLOAD_TIP+" 讲者照片请在名称栏填写讲者姓名。";
  };
  kindSelect.addEventListener("change",syncAgendaForm);
  syncAgendaForm();
  picker.onchange=()=>{
    const files=[...(picker.files||[])];
    if(files.length>20){toast("单次最多选择 20 份附件","warn");picker.value="";picked=[];return;}
    const error=files.map(checkFile).find(Boolean);
    if(error){toast(error,"warn");picker.value="";picked=[];return;}
    if(kindSelect.value==="终版议程"&&files.length!==1){toast("终版议程只能上传一份文件","warn");picker.value="";picked=[];return;}
    picked=files;
    const count=m.querySelector(".upload .fn");
    if(count)count.textContent=files.length?files.length+" 份文件已选择":"未选择";
    const name=m.querySelector('[name="name"]');
    if(name&&!name.value.trim()&&files[0])name.value=files[0].name;
  };

  m.querySelector('[data-x="0"]').onclick = () => m.classList.remove("open");
  const btn = m.querySelector('[data-x="1"]');
  btn.onclick = async () => {
    const isFinalAgenda=kindSelect.value==="终版议程";
    if(!validate(m,isFinalAgenda?fields.filter(f=>f.k!=="name"):fields))return;
    if(isFinalAgenda&&picked.length!==1){toast("请先选择一份终版议程文件","warn");return;}
    const v=readForm(m);
    if(isFinalAgenda){
      v.name=picked[0].name;
      v.version="终版";
    }else if(!v.name&&picked.length){
      v.name=picked[0].name;
    }
    if(!String(v.name||"").trim()){toast("请填写材料名称或选择附件","warn");return;}

    btn.disabled = true;
    try {
      if(!picked.length){
        await api.post(`/api/projects/${v.pid}/materials`,v);
      }else{
        let saved=0;
        for(const file of picked){
          const payload=await compressImage(file);
          btn.textContent=`正在上传 ${saved+1}/${picked.length}`;
          const up=await api.upload(payload,{pid:v.pid});
          await api.post(`/api/projects/${v.pid}/materials`,{
            ...v,name:picked.length===1?v.name:`${v.name} · ${file.name}`,
            file_key:up.key,file_name:up.name,file_size:up.size,file_mime:up.mime
          });
          saved++;
        }
      }
      toast(isFinalAgenda?"终版议程已上传并确认":picked.length?`已登记 ${picked.length} 份材料附件`:"材料已登记","ok");
      m.classList.remove("open");
      if(onSaved)await onSaved(); else await render(root);
    } catch (e) {
      toast(e.message, "warn");
      btn.disabled = false;
      btn.textContent = "保存";
    }
  };
}
