import { api, can } from "../lib/api.js";
import { bindPager, esc, formHtml, modal, pager, panel, readForm, table, toast, validate } from "../lib/ui.js";
import { checkFile, compressImage, fileUrl, UPLOAD_ACCEPT, UPLOAD_TIP } from "../lib/upload.js";
import { openContractMaterialReplace } from "../lib/contract-material-replace.js";

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
        { t: "版本", w: "56px" }, { t: "上传人", w: "76px" }, { t: "时间", w: "130px" }, { t:"操作",w:"78px" }],
        d.rows.map((m) => ({
          c: [`<a class="link" data-go="projects/${m.pid}">${esc(m.pname)}</a>`, esc(m.kind)+(m.kind==="权益照片"?`<div class="hint">${esc(m.sponsor_enterprise||"未关联赞助合同")} · ${esc(m.sponsor_right_category||"未关联权益类目")}</div>`:""),
            esc(m.name),
            m.file_key
              ? (m.file_mime === "application/pdf" || /\.(doc|docx|ppt|pptx|xls|xlsx|csv|txt)$/i.test(m.file_key)
                  ? `<a class="link" href="${fileUrl(m.file_key)}" target="_blank" rel="noopener">${esc(m.file_name || "下载附件")}</a>`
                  : `<a href="${fileUrl(m.file_key)}" target="_blank" rel="noopener"><img class="thumb" src="${fileUrl(m.file_key)}" alt=""></a>`)
              : '<span style="color:var(--mute)">—</span>',
            esc(m.version || ""), esc(m.uploader || ""), `<span class="mono">${esc(m.created_at)}</span>`,
            can("material:file:replace") && m.file_key && !["已核销","已结算","已归档"].includes(m.pstatus)
              ? `<button class="link" data-replace-material="${Number(m.id)}">修改</button>` : "—"]
        })),
        { empty: "暂无材料" })}
      ${pager(d, { unit: "条" })}
    </div>
`;

  bindPager(root, (n) => { curPage = n; render(root); });

  const add = root.querySelector("#add");
  if (add) add.onclick = () => openMaterialRegistration(root, d.projects, d.kinds);
  root.querySelectorAll("[data-replace-material]").forEach(btn=>{
    btn.onclick=()=>{
      const item=d.rows.find(x=>Number(x.id)===Number(btn.dataset.replaceMaterial));
      if(item)openContractMaterialReplace(item,()=>render(root));
    };
  });
}

export function openMaterialRegistration(root, projects, kinds, defaultPid="", onSaved=null) {
  const fields = [
    { k: "pid", l: "所属项目", t: "select", req: 1, v:defaultPid, opts: projects.map((p) => ({ v: p.id, l: `${p.id} ${p.name}` })) },
    { k: "kind", l: "材料类别", t: "select", req: 1, custom: 1, ph: "如：盖章会议通知 / 招商函 / 终版议程 / 讲者照片",
      opts: [...kinds, "会议通知", "招商函", "终版议程", "课件", "串场", "劳务表", "劳务收集表", "讲者照片", "权益照片"].filter((v, i, a) => a.indexOf(v) === i),
      tip: "可任选类别或自定义类别；不要求固定类别全部上传。至少上传一份实际附件即可满足流程材料条件。" },
    { k: "sponsor_right_id", l: "权益照片 · 二级类目（从赞助合同自动生成，可自定义）", t:"select",opts:[],
      tip:"先选择项目及赞助合同权益，再上传对应照片。" },
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
  const saveButton=m.querySelector('[data-x="1"]');
  const rightSelect=m.querySelector('[name="sponsor_right_id"]');
  const rightField=rightSelect.closest(".fld");
  const pidSelect=m.querySelector('[name="pid"]');
  let availableRights=[];
  const loadRights=async()=>{
    availableRights=[];
    if(!pidSelect.value)return;
    try{
      const data=await api.get("/api/projects/"+encodeURIComponent(pidSelect.value)+"/sponsor-rights");
      const sponsors=new Map((data.contracts||[]).filter(c=>c.status!=="已驳回").map(c=>[c.id,c]));
      availableRights=(data.rights||[]).filter(x=>sponsors.has(x.sponsor_id))
        .map(x=>({...x,enterprise:sponsors.get(x.sponsor_id).enterprise}));
    }catch(err){if(kindSelect.value==="权益照片")toast("读取权益二级类目失败："+err.message,"warn");}
    const old=rightSelect.value;
    rightSelect.innerHTML='<option value="">选择赞助合同 → 权益二级类目</option>'+
      availableRights.map(x=>'<option value="'+x.id+'">'+esc(x.enterprise)+" · "+esc(x.category)+(x.confirmed?"":"（待确认）")+'</option>').join("");
    if(availableRights.some(x=>String(x.id)===old))rightSelect.value=old;
  };
  pidSelect.addEventListener("change",loadRights);
  loadRights();

  // 终版议程只需上传一个文件，名称自动取文件名，版本自动确认为终版。
  const syncAgendaForm=()=>{
    const final=kindSelect.value==="终版议程";
    const photo=kindSelect.value==="讲者照片";
    const rightsPhoto=kindSelect.value==="权益照片";
    rightField.style.display=rightsPhoto?"":"none";
    for(const field of ["name","version"]){
      const el=m.querySelector('[name="'+field+'"]');
      if(el?.closest(".fld"))el.closest(".fld").style.display=final?"none":"";
    }
    picker.multiple=!final&&!photo;
    picker.accept=photo||rightsPhoto?".jpg,.jpeg,.png,.webp":UPLOAD_ACCEPT;
    if(saveButton)saveButton.textContent=final?"确定终版议程":"保存";
    const tip=m.querySelector(".upload")?.closest(".fld")?.querySelector(".tip");
    if(tip)tip.textContent=final
      ? "上传一份终版议程原件，点击「确定终版议程」即完成；无需额外的讲者、课题或待办流程。"
      : photo ? "每次登记一位讲者的 JPG/PNG/WebP 照片，材料名称必须填写对应讲者姓名，供核销第2步逐人核对。"
        : rightsPhoto ? "选择赞助合同对应的权益二级类目，可为同一权益上传多张 JPG/PNG/WebP 照片。"
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
    if(kindSelect.value==="讲者照片"&&(files.length!==1||!/^image\/(jpeg|png|webp)$/.test(files[0].type||"") &&
      !/\.(jpg|jpeg|png|webp)$/i.test(files[0].name||""))){
      toast("讲者照片每次只能上传一张 JPG/PNG/WebP 图片","warn");picker.value="";picked=[];return;
    }
    if(kindSelect.value==="权益照片"&&files.some(f=>!/\.(jpe?g|png|webp)$/i.test(f.name||""))){
      toast("权益照片仅支持 JPG/PNG/WebP 图片","warn");picker.value="";picked=[];return;
    }
    picked=files;
    const count=m.querySelector(".upload .fn");
    if(count)count.textContent=files.length?files.length+" 份文件已选择":"未选择";
    const name=m.querySelector('[name="name"]');
    if(name&&!name.value.trim()&&files[0])name.value=files[0].name;
  };

  m.querySelector('[data-x="0"]').onclick = () => m.classList.remove("open");
  const btn = saveButton;
  btn.onclick = async () => {
    const isFinalAgenda=kindSelect.value==="终版议程";
    if(kindSelect.value==="权益照片"&&!availableRights.some(x=>String(x.id)===rightSelect.value)){
      toast("请先选择当前合同的权益二级类目；识别失败请到赞助收入页面人工补录","warn");return;
    }
    if(!validate(m,isFinalAgenda?fields.filter(f=>f.k!=="name"):fields))return;
    if(isFinalAgenda&&picked.length!==1){toast("请先选择一份终版议程文件","warn");return;}
    if(kindSelect.value==="讲者照片"&&picked.length!==1){
      toast("讲者照片请一次选择一位讲者的一张图片","warn");return;
    }
    const v=readForm(m);
    if(kindSelect.value==="权益照片")v.sponsor_right_id=Number(rightSelect.value);
    else delete v.sponsor_right_id;
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
      btn.textContent = isFinalAgenda ? "确定终版议程" : "保存";
    }
  };
}
