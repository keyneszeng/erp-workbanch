import { api, can, state } from "../lib/api.js";
import { badge, bindSearchRefresh, confirmBox, promptBox, esc, formHtml, modal, money, panel, readForm, table, toast, validate } from "../lib/ui.js";
import { bindFilePicker, UPLOAD_ACCEPT, UPLOAD_TIP } from "../lib/upload.js";
import { flowHint, flowOf, openContractDetail } from "../lib/contract-detail.js";
import { openContractMaterialReplace } from "../lib/contract-material-replace.js";
import {canEditContractCategory,openContractCategoryEdit,contractDeleteButton,deleteContract} from "../lib/contract-category-edit.js";

let q = "";
let renderSeq = 0;
const views = new WeakMap();
const matches=(row,query)=>!query||[row.id,row.name,row.vendor,row.pname,row.pid,row.category].some(v=>String(v||"").toLowerCase().includes(query.trim().toLowerCase()));

/** 按唯一项目编号归类，避免同名会议混在一起；仅使用已授权合同数据。 */
function groupContracts(rows,projects){
  const index=new Map(projects.map(p=>[p.id,p]));
  const groups=new Map();
  for(const row of rows){
    if(!groups.has(row.pid)){
      const p=index.get(row.pid);
      groups.set(row.pid,{id:row.pid,name:p?.name||row.pname||row.pid,assoc:p?.assoc||"",status:p?.status||row.pstatus||"",rows:[]});
    }
    groups.get(row.pid).rows.push(row);
  }
  return [...groups.values()];
}
function projectDirectory(groups){
  return table([{t:"项目编号",w:"135px"},{t:"项目名称"},{t:"所属协会",w:"150px"},{t:"项目状态",w:"100px"},{t:"合同数",w:"80px",cls:"num"},{t:"支出合同金额",w:"130px",cls:"num"},{t:"赞助合同金额",w:"130px",cls:"num"},{t:"操作",w:"100px"}],groups.map(g=>{
    const sum=category=>g.rows.filter(r=>r.status!=="已终止"&&(r.category==="企业赞助")===category).reduce((n,r)=>n+Number(r.amount||0),0);
    const href="contracts/"+esc(g.id);
    return {c:[`<span class="mono">${esc(g.id)}</span>`,`<button class="link" data-go="${href}"><b>${esc(g.name)}</b></button>`,esc(g.assoc||"—"),badge(g.status),String(g.rows.length),"¥"+money(sum(false)),"¥"+money(sum(true)),`<button class="link" data-go="${href}">查看合同</button>`]};
  }),{empty:"暂无匹配的会议合同项目"});
}

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

export async function render(root, params) {
  const view=params!==undefined?{pid:params[0]||"",query:""}:views.get(root)||{pid:"",query:""};
  views.set(root,view);
  const seq = ++renderSeq;
  const [c, proj] = await Promise.all([api.get("/api/contracts"), api.get("/api/projects")]);
  if (seq !== renderSeq) return;
  const all=c.rows||[],projects=proj.rows||[],allGroups=groupContracts(all,projects);
  const groups=allGroups.filter(g=>matches({id:g.id,name:g.name,vendor:g.assoc},q)||g.rows.some(r=>matches(r,q)));
  const selected=view.pid?(allGroups.find(g=>g.id===view.pid)||projects.find(p=>p.id===view.pid)):null;
  const rows=view.pid?all.filter(r=>r.pid===view.pid&&matches(r,view.query)):groups.flatMap(g=>g.rows);
  const expenseRows=rows.filter(r=>r.category!=="企业赞助"&&r.status!=="已终止");
  const total = expenseRows.reduce((s, r) => s + Number(r.amount || 0), 0);
  const signed = expenseRows.filter((r) => r.status === "已签署").reduce((s, r) => s + Number(r.amount || 0), 0);
  const sponsorTotal=rows.filter(r=>r.category==="企业赞助"&&r.status!=="已终止").reduce((s,r)=>s+Number(r.amount||0),0);
  const withFile = rows.filter((r) => r.file_key).length;

  root.innerHTML = `<div class="phead">
      <div><h2>合同台账</h2><p>企业赞助合同、会务协议、劳务协议均在此统一上传与归档；会务费用关联核销第6项，劳务合同关联第5项。</p></div>
      <div class="acts">
        ${can("export:any") ? '<button class="btn btn-o" id="exp">导出 CSV</button>' : ""}
        ${can("contract:write") ? '<button class="btn btn-p" id="newC">+ 录入合同</button>' : ""}
      </div>
    </div>
    <div class="grid g4">
      <div class="kpi"><div class="t">合同数</div><div class="v">${rows.length}<span class="u">份</span></div></div>
      <div class="kpi k2"><div class="t">支出合同总额</div><div class="v">¥${money(total)}</div></div>
      <div class="kpi k4"><div class="t">已签署支出合同</div><div class="v">¥${money(signed)}</div></div>
      <div class="kpi k3"><div class="t">赞助合同金额（收入）</div><div class="v">¥${money(sponsorTotal)}</div></div>
    </div>
    <div class="panel mt">
      <div class="panel-h"><h2>${view.pid?"合同清单 · "+esc(selected?.name||view.pid):"合同清单 · 项目目录"}</h2><span class="hint">${view.pid?"":groups.length+" 个项目 · "}${rows.length} 份 · 原件 ${withFile} 份</span></div>
      <div class="filters">${view.pid?'<button class="btn btn-o" data-go="contracts">← 返回项目目录</button>':""}<input type="search" id="q" placeholder="${view.pid?"搜索本项目合同 / 签约方 / 类别":"搜索项目 / 合同 / 签约方 / 协会"}" value="${esc(view.pid?view.query:q)}"></div>
      ${!view.pid?'<div class="hint" style="padding:0 16px 12px">按会议项目汇总，点击项目名称或查看合同进入该项目的完整清单。</div>'+projectDirectory(groups):table(
        [{ t: "合同编号", w: "112px" }, { t: "项目", w: "170px" }, { t: "合同名称" }, { t: "签约方", w: "150px" },
         { t: "金额", w: "104px", cls: "num" }, { t: "签署日期", w: "100px" }, { t: "状态", w: "80px" },
         { t: "原件", w: "104px" }, { t: "操作", w: "200px" }],
        rows.map((r) => ({
          c: [`<span class="mono">${r.id}</span>`, `<a class="link" data-go="projects/${r.pid}">${esc(r.pname)}</a>`,
            `${esc(r.name)}<span class="cat">${esc(r.category || "未分类")}</span>`,
            esc(r.vendor), `¥${money(r.amount)}`, `<span class="mono">${esc(r.sign_date || "—")}</span>`,
            badge(r.status), fileCell(r), flowBtn(r)+(r.status==="待签署"&&can("contract:approve")?` <button class="link danger" data-cflow="${r.id}" data-caction="reject">驳回</button>`:"")+
            (canEditContractCategory(r)
              ? ` <button class="link" data-edit-contract-category="${esc(r.id)}">修改</button>` : "")+
             (can("material:file:replace") && r.file_key && r.material_id &&
              !["已核销","已结算","已归档"].includes(r.pstatus)
              ? ` <button class="link" data-replace-ledger-file="${r.material_id}">更换原件</button>` : "")+contractDeleteButton(r)]
        })), { empty: "暂无合同" })}
    </div>`;

  bindSearchRefresh(root, "#q", value => { if(view.pid)view.query=value;else q=value; }, () => render(root));
  const expBtn = root.querySelector("#exp");
  if (expBtn) expBtn.onclick = async () => {
    try { const r = await api.download("/api/export/contracts"); toast(`已导出 ${r.name}`, "ok"); }
    catch (e) { toast(e.message, "warn"); }
  };
  const nb = root.querySelector("#newC");
  if (nb) nb.onclick = () => openCreate(root, projects, view.pid);
  root.querySelectorAll("[data-cflow]").forEach((b) => b.onclick = () => {
    if(b.dataset.caction==="sign") {
      const row=rows.find(c=>c.id===b.dataset.cflow);
      if(row){openContractDetail(row,{startConfirm:true,onDone:()=>render(root)});return;}
    }
    return contractFlow(root,b.dataset.cflow,b.dataset.caction);
  });
  // 详情弹窗：从当前过滤后的 rows 里取，避免为了看一眼原件再打一次接口
  root.querySelectorAll("[data-edit-contract-category]").forEach(b=>b.onclick=()=>{
    const row=rows.find(r=>r.id===b.dataset.editContractCategory);
    if(row)openContractCategoryEdit(row,()=>render(root));
  });
  root.querySelectorAll("[data-delete-contract]").forEach(b=>b.onclick=()=>{
    const row=rows.find(r=>r.id===b.dataset.deleteContract);
    if(row)deleteContract(row,()=>render(root));
  });
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

function openCreate(root, projects, preferredPid="") {
  const fields=[
    { k:"pid",l:"所属项目",t:"select",req:1,opts:projects.map(p=>({v:p.id,l:p.id+" "+p.name})) },
    { k:"name",l:"合同名称",req:1,full:1 },
    { k:"vendor",l:"签约方",req:1 },
    { k:"amount",l:"合同金额（元）",t:"number",req:1,
      tip:"劳务专家类合同优先识别原件中的劳动报酬／劳务报酬，OCR 仅预填，请人工核对。" },
    { k:"category",l:"合同类别",t:"select",req:1,opts:[{v:"会务需求",l:"会务协议"},{v:"劳务专家",l:"劳务协议"},{v:"企业赞助",l:"企业赞助合同"}],
      tip:"企业赞助属于会议收入，不计入会务支出、付款或核销第6项合同金额。" },
    { k:"rightsCategories",l:"权益内容（每行一项）",t:"textarea",rows:4,full:1,
      ph:"主会场背景板 LOGO 露出\n企业展位展示" },
    { k:"sign_date",l:"签署日期",t:"date" },
    { k:"status",l:"状态",t:"select",opts: ["草稿", "待签署"],
      tip:"录入后须有权限人员确认签署。企业赞助会同步到会议收入。" },
    { k:"file",l:"合同原件",t:"file",full:1,accept:UPLOAD_ACCEPT,
      tip:UPLOAD_TIP+" 上传后会自动扫描签约方、合同金额（含劳动报酬）及赞助权益。" }
  ];
  const m=modal({title:"录入合同",width:"650px",
    body:'<div class="hint" style="padding-bottom:12px">合同编号由系统自动分配（HT-年份-流水号），不用填写。上传合同后可自动识别并预填，保存前请核对原件。</div>'+
      formHtml(fields,{pid:preferredPid})+'<div class="hint" role="status" data-contract-scan style="padding:10px 0">尚未选择合同文件。</div>',
    footer:'<button class="btn btn-o" data-x="0">取消</button><button class="btn btn-p" data-x="1">保存</button>'
  });
  const btn=m.querySelector('[data-x="1"]');
  const category=m.querySelector('[name="category"]'),project=m.querySelector('[name="pid"]');
  const note=m.querySelector("[data-contract-scan]");
  const rightsField=m.querySelector('[name="rightsCategories"]').closest(".fld");
  let picked=null,uploaded=null,token=0,busy=false,lastScan=null;
  function syncCategory(){
    const sponsor=category.value==="企业赞助";
    rightsField.style.display=sponsor?"":"none";
    const vendor=m.querySelector('[name="vendor"]');
    if(lastScan&&vendor&&!vendor.dataset.userEdited){
      vendor.value=(sponsor?lastScan.fields?.enterprise:"")||lastScan.fields?.vendor||vendor.value;
    }
  }
  syncCategory();
  category.addEventListener("change",()=>{category.dataset.userEdited="1";syncCategory();});
  m.querySelector('[name="vendor"]').addEventListener("input",e=>{e.target.dataset.userEdited="1";});
  m.querySelector('[name="amount"]').addEventListener("input",e=>{e.target.dataset.userEdited="1";});
  project.addEventListener("change",()=>{
    token++;picked=null;uploaded=null;lastScan=null;busy=false;btn.disabled=false;
    const input=m.querySelector('[name="file"]');if(input)input.value="";
    const filename=input?.closest(".upload")?.querySelector(".fn");
    if(filename)filename.textContent="未选择";
    note.textContent="项目已切换，请重新选择合同原件。";
  });
  bindFilePicker(m,"file",(file,err)=>{
    const seq=++token;picked=err?null:file;uploaded=null;lastScan=null;
    const amountField=m.querySelector('[name="amount"]');
    if(amountField&&!amountField.dataset.userEdited&&amountField.dataset.ocrFilled==="1"){
      amountField.value="";delete amountField.dataset.ocrFilled;
    }
    if(err){note.textContent=err;toast(err,"warn");return;}
    if(!picked||!project.value)return;
    const name=m.querySelector('[name="name"]');
    if(name&&!name.value.trim())name.value=file.name.replace(/\.[^.]+$/,"").slice(0,80);
    if(!category.dataset.userEdited&&/劳务|劳动|专家|讲课|授课|讲师|讲者|酬金/.test(file.name))category.value="劳务专家";
    busy=true;btn.disabled=true;
    note.textContent="正在上传并识别合同金额／劳动报酬…";
    (async()=>{
      const saved=await api.upload(file,{pid:project.value});
      if(seq!==token)return;
      uploaded=saved;
      const scan=await api.post("/api/contracts/scan",{pid:project.value,file_key:saved.key,category:category.value});
      if(seq!==token)return;
      lastScan=scan;
      const party=m.querySelector('[name="vendor"]'),amount=m.querySelector('[name="amount"]'),rights=m.querySelector('[name="rightsCategories"]');
      const f=scan.fields||{},sponsor=category.value==="企业赞助";
      if(party&&!party.dataset.userEdited&&(sponsor?f.enterprise||f.vendor:f.vendor||f.enterprise))
        party.value=(sponsor?f.enterprise||f.vendor:f.vendor||f.enterprise);
      if(f.amount!==null&&f.amount!==undefined&&amount&&!amount.dataset.userEdited){amount.value=String(f.amount);amount.dataset.ocrFilled="1";}
      if(Array.isArray(f.rightsContent)&&f.rightsContent.length&&rights)rights.value=f.rightsContent.join("\n");
      note.textContent=(scan.note||"扫描完成，请核对原件后保存。")+
        (f.amount!==null&&f.amount!==undefined?" 已预填"+(f.amountSource==="劳动报酬"?"劳动报酬":"合同")+"金额：¥"+f.amount:"");
    })().catch(e=>{
      if(seq===token)note.textContent="扫描未完成："+e.message+"。可手工填写后保存。";
    }).finally(()=>{
      if(seq===token){busy=false;btn.disabled=false;}
    });
  });
  m.querySelector('[data-x="0"]').onclick=()=>{token++;m.classList.remove("open");};
  btn.onclick=async()=>{
    if(busy){toast("文件正在扫描，请核对结果后提交","warn");return;}
    if(!validate(m,fields))return;
    const v=readForm(m);
    if(v.category==="企业赞助"&&!picked){toast("企业赞助合同必须上传合同原件","warn");return;}
    if(v.category==="企业赞助"){
      const rights=String(v.rightsCategories||"").split(/[\n；;]+/).map(x=>x.trim()).filter(Boolean);
      if(rights.length)v.rightsCategories=rights;else delete v.rightsCategories;
    }else delete v.rightsCategories;
    btn.disabled=true;
    try{
      let meta={};
      if(picked){
        btn.textContent=uploaded?"保存中…":"上传中…";
        const up=uploaded||await api.upload(picked,{pid:v.pid});
        meta={file_key:up.key,file_name:up.name,file_size:up.size,file_mime:up.mime};
      }
      btn.textContent="保存中…";
      const r=await api.post("/api/contracts",{...v,...meta});
      const base=(r.message||"合同已登记")+(r.sponsorId?"；已关联会议收入 "+r.sponsorId:"");
      toast(r.warning?base+"；"+r.warning:base,r.warning?"warn":"ok");
      m.classList.remove("open");
      // 保存后直接定位所属会议，避免新合同混在其他会议的清单中。
      if(views.get(root)?.pid===v.pid){views.get(root).query="";await render(root);}
      else location.hash="#/contracts/"+v.pid;
    }catch(e){toast(e.message,"warn");btn.disabled=false;btn.textContent="保存";}
  };
}
