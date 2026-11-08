import { esc } from "./ui.js";
/** 结构化核销录入：OCR 尚未接入。银行账号只送服务端即时比对，不进入审计或证据留存。 */
const input=(name,label,value="")=>`<div class="fld" style="margin-top:8px"><label>${label}</label><input name="${name}" value="${esc(value||"")}" autocomplete="off"></div>`;
const area=(name,label,placeholder)=>`<div class="fld" style="margin-top:8px"><label>${label}</label><textarea name="${name}" rows="3" placeholder="${esc(placeholder)}"></textarea></div>`;
const ck=(name,label)=>`<label style="display:block;margin-top:9px"><input type="checkbox" name="${name}"> ${label}</label>`;
const names=v=>String(v||"").split(/[\n,，、;；]+/).map(x=>x.trim()).filter(Boolean);
const labor=v=>String(v||"").split(/\n+/).map(line=>line.split("|").map(x=>x.trim()))
  .filter(x=>x.some(Boolean)).map(([name,time,role,amount,bankAccount,bankName])=>({name,time,role,amount,bankAccount,bankName}));
function rightsChecklist(data){
  const rights=data?.requiredRights||[];
  if(!rights.length)return '<div class="gate">没有可核对的已签署赞助合同权益。若存在已签赞助合同，请到「会议收入」先审核权益类目。</div>';
  return '<div class="hint">权益照片必须按赞助合同权益内容上传。请逐一打开照片，对照合同原件，只有实际内容相符才勾选通过；OCR 不自动判定照片合规。</div>'+
    rights.map(r=>{
      const c=(data.contracts||[]).find(x=>x.id===r.sponsor_id);
      const photos=(data.photos||[]).filter(x=>Number(x.sponsor_right_id)===Number(r.id)&&x.file_key);
      return '<div class="fld" style="margin-top:10px;padding:10px;border:1px solid var(--line);border-radius:8px">'+
        '<div><b>'+esc(c?.enterprise||r.sponsor_id)+'</b> · '+esc(r.category)+
        ' · '+(r.confirmed?'已确认权益':'权益尚未人工确认')+' · '+photos.length+' 张照片</div>'+
        photos.map(m=>'<a class="link" href="/api/uploads/'+encodeURIComponent(m.file_key)+'" target="_blank" rel="noopener">'+esc(m.file_name||m.name)+' · 打开照片</a>').join(' · ')+
        (!photos.length?'<div class="hint">尚未上传对应权益照片</div>':'')+
        '<label style="display:block;margin-top:10px"><input type="checkbox" name="rightReviewed" value="'+r.id+'"> 已按合同权益逐项人工审查，确认照片内容一致</label></div>';
    }).join('');
}

export function sopEvidenceForm(no,p,rightsData=null){
  const head=`<div class="gate" style="margin-bottom:9px">以下信息来自人工核验/结构化录入，系统只做字段比较；不具备自动 OCR。原件请先在材料中心上传。</div>`;
  const s={
    1:`<div class="fld"><label>盖章函件原件</label><select name="documentKind"><option value="会议通知">盖章会议通知</option><option value="招商函">盖章招商函</option></select></div>`
       +`<div class="hint">请对照已上传的盖章函件与串场原件，分别填写两份材料中的信息。两边一致才能通过。</div>`
       +input("meetingName","盖章函件 · 会议名称")
       +input("meetingDate","盖章函件 · 会议日期")
       +input("organizer","盖章函件 · 主办方")
       +input("hostMeetingName","串场 · 会议名称")
       +input("hostMeetingDate","串场 · 会议日期")
       +input("hostOrganizer","串场 · 主办方")
       +ck("stamped","确认函件已盖章")+ck("final","确认函件为终版"),
    2:area("agendaSpeakers","终版议程 · 讲者姓名（逗号或换行分隔）","张老师、李老师")
       +area("attendanceSpeakers","签到表 · 仅录入讲者姓名（不含普通参会人员）","张老师、李老师")
       +area("photoSpeakers","讲者照片 · 每张照片对应讲者的姓名","张老师、李老师")
       +`<div class="hint">仅以终版议程的讲者名单为基准，逐一检查签到表和讲者照片是否漏人、多出人员或出现重复姓名。签到表只录入讲者，不包括普通参会人员；第2项不关联劳务表或合同。</div>`
       +ck("noOmissions","已人工核对讲者信息及照片，无冒领、漏发或重复"),
    3:input("onlineMinutes","有效讲者在线时长（分钟，线上/混合须 >30）")
       +ck("signedAttendance","已核验线下签到表（线下/混合必选）"),
    4:area("agendaTopics","终版议程包含的主题（逗号或换行）","主题甲、主题乙")
       +area("courseTopics","已上传课件的主题（逗号或换行）","主题甲")
       +`<div class="hint">只核对两点：材料库已有课件原件；所填每个课件主题都能在已确认的终版议程中找到。终版议程可以包含其他未上传课件的主题。无需核对串场、Logo 或赞助商展示页面。请从原件人工摘录主题。</div>`,
    5:area("collectionRecords","劳务表（每行：姓名|时间|角色|金额|银行账号|开户行（可选））","张老师|2026-11-01|讲者|1000|6222...")
       +`<div class="hint">第5项只关联劳务登记表（含劳务表、劳务收集表）和劳务专家合同。每位专家须有一份姓名对应的劳务专家合同；会务合同、赞助合同及其他总合同不得参与核验。银行账号不写入核销证据。</div><div data-labor-contract-preview></div>`,
    6: `<div class="hint">有已建立的会务需求表即必核。只关联会务需求表、已签署「会务需求」类别合同及会务发票；核对三方总金额是否一致。原件真实性须人工检查。</div>`
       +ck("demandReviewed","已检查本项目已归档的会务需求表")
       +ck("meetingContractReviewed","已逐份检查对应会务需求合同原件")
       +ck("meetingInvoiceReviewed","已检查对应会务发票原件及金额"),
    7:rightsChecklist(rightsData)
  };
  return head+(s[no]||"");
}
export function collectSopEvidence(no,m){
  const get=k=>m.querySelector('[name="'+k+'"]')?.value?.trim()||"";
  const checked=k=>!!m.querySelector('[name="'+k+'"]')?.checked;
  switch(no){
    case 1:return {documentKind:get("documentKind"),meetingName:get("meetingName"),
      meetingDate:get("meetingDate"),organizer:get("organizer"),
      hostMeetingName:get("hostMeetingName"),hostMeetingDate:get("hostMeetingDate"),
      hostOrganizer:get("hostOrganizer"),stamped:checked("stamped"),final:checked("final")};
    case 2:return {agendaSpeakers:names(get("agendaSpeakers")),
      attendanceSpeakers:names(get("attendanceSpeakers")),
      photoSpeakers:names(get("photoSpeakers")),noOmissions:checked("noOmissions")};
    case 3:return {onlineMinutes:Number(get("onlineMinutes")),signedAttendance:checked("signedAttendance")};
    case 4:return {agendaTopics:names(get("agendaTopics")),courseTopics:names(get("courseTopics")),
      hostTitleMatches:checked("hostTitleMatches"),hostNameLogoMatches:checked("hostNameLogoMatches"),
      sponsorLogoPages:["首页","尾页","鸣谢页"].filter(x=>checked("logo"+x))};
    case 5:return {collectionRecords:labor(get("collectionRecords"))};
    case 6:return {demandReviewed:checked("demandReviewed"),
      meetingContractReviewed:checked("meetingContractReviewed"),
      meetingInvoiceReviewed:checked("meetingInvoiceReviewed")};
    case 7:return {verifiedRights:[...m.querySelectorAll('input[name="rightReviewed"]:checked')].map(x=>Number(x.value))};
    default:return {};
  }
}
