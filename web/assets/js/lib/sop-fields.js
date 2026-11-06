import { esc } from "./ui.js";
/** 结构化核销录入：OCR 尚未接入。银行账号只送服务端即时比对，不进入审计或证据留存。 */
const input=(name,label,value="")=>`<div class="fld" style="margin-top:8px"><label>${label}</label><input name="${name}" value="${esc(value||"")}" autocomplete="off"></div>`;
const area=(name,label,placeholder)=>`<div class="fld" style="margin-top:8px"><label>${label}</label><textarea name="${name}" rows="3" placeholder="${esc(placeholder)}"></textarea></div>`;
const ck=(name,label)=>`<label style="display:block;margin-top:9px"><input type="checkbox" name="${name}"> ${label}</label>`;
const names=v=>String(v||"").split(/[\n,，、;；]+/).map(x=>x.trim()).filter(Boolean);
const labor=v=>String(v||"").split(/\n+/).map(line=>line.split("|").map(x=>x.trim()))
  .filter(x=>x.some(Boolean)).map(([name,time,role,amount,bankAccount,bankName])=>({name,time,role,amount,bankAccount,bankName}));
export function sopEvidenceForm(no,p,hasLaborSheet=false){
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
       +(hasLaborSheet?area("collectionSpeakers","已上传劳务表 · 讲者姓名","张老师、李老师"):"")
       +area("attendanceSpeakers","签到表 · 仅录入讲者姓名（不含普通参会人员）","张老师、李老师")
       +area("photoSpeakers","讲者照片 · 每张照片对应讲者的姓名","张老师、李老师")
       +`<div class="hint">终版议程、签到表、讲者照片三处必核；若上传劳务表，增加劳务表讲者名单比对。合同使用现有合同台账，不必另传协议。</div>`
       +ck("noOmissions","已人工核对讲者信息及照片，无冒领、漏发或重复"),
    3:input("onlineMinutes","有效讲者在线时长（分钟，线上/混合须 >30）")
       +ck("signedAttendance","已核验线下签到表（线下/混合必选）"),
    4:area("agendaTopics","终版议程包含的主题（逗号或换行）","主题甲、主题乙")
       +area("courseTopics","已上传课件的主题（逗号或换行）","主题甲")
       +`<div class="hint">只核对两点：材料库已有课件原件；所填每个课件主题都能在已确认的终版议程中找到。终版议程可以包含其他未上传课件的主题。无需核对串场、Logo 或赞助商展示页面。请从原件人工摘录主题。</div>`,
    5:area("collectionRecords","劳务表（每行：姓名|时间|角色|金额|银行账号|开户行（可选））","张老师|2026-11-01|讲者|1000|6222...")
       +`<div class="hint">仅材料库上传劳务表原件时需要判定。合同在现有合同台账核对，协议不重复上传或录入。银行账号不写入核销证据，专用密钥启用时才加密保存已核验收款信息。</div>`,
    6:input("meetingName","拟结算单会议名称",p.name)+input("meetingDate","拟结算单会议日期",p.date)
       +input("draftAmount","拟请款总金额（元，须等于所有已签合同总额；专家费可免发票）")
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
    case 2:return {agendaSpeakers:names(get("agendaSpeakers")),collectionSpeakers:names(get("collectionSpeakers")),
      attendanceSpeakers:names(get("attendanceSpeakers")),
      photoSpeakers:names(get("photoSpeakers")),noOmissions:checked("noOmissions")};
    case 3:return {onlineMinutes:Number(get("onlineMinutes")),signedAttendance:checked("signedAttendance")};
    case 4:return {agendaTopics:names(get("agendaTopics")),courseTopics:names(get("courseTopics")),
      hostTitleMatches:checked("hostTitleMatches"),hostNameLogoMatches:checked("hostNameLogoMatches"),
      sponsorLogoPages:["首页","尾页","鸣谢页"].filter(x=>checked("logo"+x))};
    case 5:return {collectionRecords:labor(get("collectionRecords"))};
    case 6:return {draftAmount:Number(get("draftAmount")),meetingName:get("meetingName"),meetingDate:get("meetingDate")};
    default:return {};
  }
}
