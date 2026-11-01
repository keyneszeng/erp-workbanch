import { esc } from "./ui.js";
/** 结构化核销录入：OCR 尚未接入。银行账号只送服务端即时比对，不进入审计或证据留存。 */
const input=(name,label,value="")=>`<div class="fld" style="margin-top:8px"><label>${label}</label><input name="${name}" value="${esc(value||"")}" autocomplete="off"></div>`;
const area=(name,label,placeholder)=>`<div class="fld" style="margin-top:8px"><label>${label}</label><textarea name="${name}" rows="3" placeholder="${esc(placeholder)}"></textarea></div>`;
const ck=(name,label)=>`<label style="display:block;margin-top:9px"><input type="checkbox" name="${name}"> ${label}</label>`;
const names=v=>String(v||"").split(/[\n,，、;；]+/).map(x=>x.trim()).filter(Boolean);
const labor=v=>String(v||"").split(/\n+/).map(line=>line.split("|").map(x=>x.trim()))
  .filter(x=>x.some(Boolean)).map(([name,time,role,amount,bankAccount])=>({name,time,role,amount,bankAccount}));
export function sopEvidenceForm(no,p){
  const head=`<div class="gate" style="margin-bottom:9px">以下信息来自人工核验/结构化录入，系统只做字段比较；不具备自动 OCR。原件请先在材料中心上传。</div>`;
  const s={
    1:`<div class="fld"><label>基线原件</label><select name="documentKind"><option value="会议通知">盖章会议通知</option><option value="招商函">盖章招商函</option></select></div>`
       +input("meetingName","会议名称",p.name)+input("meetingDate","会议日期",p.date)+input("organizer","主办方",p.assoc)
       +input("sponsor","招商主体（如无招商请填不适用）")
       +ck("stamped","确认原件已盖章")+ck("final","确认原件为终版"),
    2:area("agendaSpeakers","终版议程讲者名单（逗号或换行分隔）","张老师、李老师")
       +area("collectionSpeakers","劳务收集表讲者名单","张老师、李老师")
       +area("agreementSpeakers","劳务协议讲者名单","张老师、李老师")
       +ck("noOmissions","确认无冒领、漏发或重复劳务"),
    3:input("onlineMinutes","有效讲者在线时长（分钟，线上/混合须 >30）")
       +ck("signedAttendance","已核验线下签到表（线下/混合必选）"),
    4:area("agendaTopics","终版议程的课题清单（逗号或换行）","课题一、课题二")
       +area("courseTopics","上传课件对应的课题清单","课题一、课题二")
       +ck("hostTitleMatches","串场题目与议程一致")+ck("hostNameLogoMatches","主办方名称及 logo 一致")
       +`<div class="fld"><label>药企 logo 出现页面（多选，仅允许三类）</label>`
       +["首页","尾页","鸣谢页"].map(x=>ck("logo"+x,x)).join("")+`</div>`,
    5:area("collectionRecords","劳务收集表（每行：姓名|时间|角色|金额|银行账号）","张老师|2026-11-01|讲者|1000|6222...")
       +area("agreementRecords","劳务协议（同样按五字段逐行输入）","张老师|2026-11-01|讲者|1000|6222...")
       +`<div class="hint">银行账号只用于本次即时比对，不会写入核销结果或审计；请仅在受控的正式 HTTPS 环境使用。</div>`,
    6:input("meetingName","拟结算单会议名称",p.name)+input("meetingDate","拟结算单会议日期",p.date)
       +input("draftAmount","拟结算金额（元，须与发票和已签合同一致）")
  };
  return head+(s[no]||"");
}
export function collectSopEvidence(no,m){
  const get=k=>m.querySelector('[name="'+k+'"]')?.value?.trim()||"";
  const checked=k=>!!m.querySelector('[name="'+k+'"]')?.checked;
  switch(no){
    case 1:return {documentKind:get("documentKind"),meetingName:get("meetingName"),
      meetingDate:get("meetingDate"),organizer:get("organizer"),sponsor:get("sponsor"),stamped:checked("stamped"),final:checked("final")};
    case 2:return {agendaSpeakers:names(get("agendaSpeakers")),collectionSpeakers:names(get("collectionSpeakers")),
      agreementSpeakers:names(get("agreementSpeakers")),noOmissions:checked("noOmissions")};
    case 3:return {onlineMinutes:Number(get("onlineMinutes")),signedAttendance:checked("signedAttendance")};
    case 4:return {agendaTopics:names(get("agendaTopics")),courseTopics:names(get("courseTopics")),
      hostTitleMatches:checked("hostTitleMatches"),hostNameLogoMatches:checked("hostNameLogoMatches"),
      sponsorLogoPages:["首页","尾页","鸣谢页"].filter(x=>checked("logo"+x))};
    case 5:return {collectionRecords:labor(get("collectionRecords")),agreementRecords:labor(get("agreementRecords"))};
    case 6:return {draftAmount:Number(get("draftAmount")),meetingName:get("meetingName"),meetingDate:get("meetingDate")};
    default:return {};
  }
}
