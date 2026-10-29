import { api, state } from "../lib/api.js";
import { esc, toast, confirmBox } from "../lib/ui.js";

let selectedPid = "";
let selectedType = "enterprise";

function emptyMsg(text) {
  return '<div class="panel" style="padding:28px;color:var(--sub)">' + esc(text) + "</div>";
}
function recordHtml(x) {
  const target = x.recipient_org || x.recipient_name || "—";
  return '<tr><td class="mono">' + esc(x.id) + '</td><td>' + esc(x.template_name) +
    '</td><td>' + esc(target) + '</td><td>' + esc(x.status) + '</td><td>' +
    (x.sent_at ? esc(x.sent_at.slice(0,16)) : "—") +
    '</td><td><button class="link" data-pdf="' + esc(x.id) + '">下载 PDF</button>' +
    (["已确认","已拒绝","已撤销"].includes(x.status) ? "" :
      ' <button class="link" data-email="' + esc(x.id) + '">邮件发送</button>' +
      ' <button class="link" data-share="' + esc(x.id) + '">微信分享路径</button>') + "</td></tr>";
}

export async function render(root) {
  const projects = (await api.get("/api/projects")).rows || [];
  const eligible = projects.filter(p=>["已立项","筹备中"].includes(p.status));
  if (!selectedPid || !projects.some(p=>p.id===selectedPid)) selectedPid=(eligible[0]||{}).id||"";
  let items = [], templates = [];
  if(selectedPid) {
    const [info, rows] = await Promise.all([
      api.get("/api/projects/"+selectedPid+"/prep/templates"),
      api.get("/api/projects/"+selectedPid+"/prep/invitations")
    ]);
    items=rows.rows; templates=info.templates;
  }
  root.innerHTML = '<div class="phead"><div><h2>会议项目 · 筹备邀请</h2>' +
    '<p>立项通过后自动匹配企业邀请（招商）与嘉宾邀请函模板；负责人填写受邀名头即可生成 PDF。</p></div></div>' +
    (eligible.length ? '<div class="panel"><div class="panel-h"><h2>选择筹备会议</h2></div>' +
      '<select id="prepPid" style="max-width:560px">' +
      eligible.map(p=>'<option value="'+esc(p.id)+'"'+(p.id===selectedPid?" selected":"")+'>'+esc(p.id+" · "+p.name)+'</option>').join("") +
      '</select><p class="hint">仅显示已立项/筹备中会议；其他阶段可查看历史已生成邀请。</p></div>' :
      emptyMsg("当前没有已立项或筹备中的会议；审批通过后自动开放内置模板。")) +
    (selectedPid ? '<div class="panel"><div class="panel-h"><h2>生成个性化邀请函</h2></div>' +
      '<div class="filters"><label>模板类型 <select id="templateType">' +
      templates.map(t=>'<option value="'+esc(t.key)+'"'+(t.key===selectedType?' selected':'')+'>'+esc(t.name)+'</option>').join("") +
      '</select></label></div>' +
      '<div class="filters"><label>受邀单位（企业邀请）<input id="recipientOrg" placeholder="如：某某医药有限公司"></label>' +
      '<label>受邀姓名（嘉宾邀请）<input id="recipientName" placeholder="如：张教授"></label>' +
      '<label>称谓/职务<input id="recipientTitle" placeholder="如：董事长、主任医师、教授"></label></div>' +
      '<div class="filters"><label>嘉宾角色<input id="guestRole" placeholder="如：特邀讲者"></label>' +
      '<label>课题<input id="topic" placeholder="如：某某主题"></label>' +
      '<label>电子邮箱<input id="recipientEmail" type="email" placeholder="可在生成后发送"></label></div>' +
      '<button id="makeInvitation" class="btn btn-p">生成专属 PDF 邀请函</button>' +
      '<p class="hint">项目名称、协会、会议日期、形式、议程及负责人从会议项目自动填充。生成时保存文档快照；不会自动发送。</p></div>' +
      '<div class="panel"><div class="panel-h"><h2>历史邀请函与发送记录</h2></div>' +
      '<div class="table-wrap"><table><thead><tr><th>邀请编号</th><th>模板</th><th>受邀对象</th><th>状态</th><th>发送时间</th><th>操作</th></tr></thead><tbody>' +
      items.map(recordHtml).join("") + '</tbody></table></div></div>' : "");
  if (!selectedPid) return;
  root.querySelector("#prepPid").onchange=e=>{ selectedPid=e.target.value;render(root); };
  root.querySelector("#templateType").onchange=e=>{
    selectedType=e.target.value;
    const isGuest=selectedType==="guest";
    root.querySelector("#recipientName").closest("label").style.display=isGuest?"":"none";
    root.querySelector("#recipientOrg").closest("label").style.display=isGuest?"none":"";
    root.querySelector("#guestRole").closest("label").style.display=isGuest?"":"none";
    root.querySelector("#topic").closest("label").style.display=isGuest?"":"none";
  };
  root.querySelector("#templateType").dispatchEvent(new Event("change"));
  root.querySelector("#makeInvitation").onclick=async()=>{
    const b={
      type:selectedType,
      recipient_org:root.querySelector("#recipientOrg").value.trim(),
      recipient_name:root.querySelector("#recipientName").value.trim(),
      recipient_title:root.querySelector("#recipientTitle").value.trim(),
      recipient_email:root.querySelector("#recipientEmail").value.trim(),
      guest_role:root.querySelector("#guestRole").value.trim(),
      topic:root.querySelector("#topic").value.trim()
    };
    try {
      const r=await api.post("/api/projects/"+selectedPid+"/prep/invitations",b);
      toast("已生成个性化邀请函 "+r.invitation.id+"，请预览后选择发送", "ok");
      await render(root);
    } catch(e) { toast(e.message,"warn"); }
  };
  root.querySelectorAll("[data-pdf]").forEach(btn=>btn.onclick=()=>{
    location.href="/api/projects/"+selectedPid+"/prep/invitations/"+encodeURIComponent(btn.dataset.pdf)+"/pdf";
  });
  root.querySelectorAll("[data-email]").forEach(btn=>btn.onclick=async()=>{
    const row=items.find(x=>x.id===btn.dataset.email);
    if(!row) return;
    if(!row.recipient_email) return toast("请创建邀请时填写收件人邮箱","warn");
    const ok=await confirmBox("确定向 "+esc(row.recipient_email)+" 发送专属邀请函 PDF？",{title:"确认邮件发送",ok:"确认发送"});
    if(!ok)return;
    try { await api.post("/api/projects/"+selectedPid+"/prep/invitations/"+row.id+"/email", {});
      toast("邮件服务已受理，请按邮件服务状态跟进送达", "ok");await render(root);
    } catch(e) { toast(e.message,"warn"); }
  });
  root.querySelectorAll("[data-share]").forEach(btn=>btn.onclick=async()=>{
    try {
      const r=await api.post("/api/projects/"+selectedPid+"/prep/invitations/"+btn.dataset.share+"/wechat-share",{});
      if (navigator.clipboard && navigator.clipboard.writeText) await navigator.clipboard.writeText(r.path);
      toast("已生成小程序分享路径；需在已发布的小程序中由负责人分享，并非已发送", "ok");
      await render(root);
    } catch(e) { toast(e.message,"warn"); }
  });
}
