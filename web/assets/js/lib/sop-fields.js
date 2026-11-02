import { esc } from "./ui.js";
/** 结构化核销录入：OCR 尚未接入。银行账号只送服务端即时比对，不进入审计或证据留存。 */
const input=(name,label,value="")=>`<div class="fld" style="margin-top:8px"><label>${label}</label><input name="${name}" value="${esc(value||"")}" autocomplete="off"></div>`;
const area=(name,label,placeholder)=>`<div class="fld" style="margin-top:8px"><label>${label}</label><textarea name="${name}" rows="3" placeholder="${esc(placeholder)}"></textarea></div>`;
const ck=(name,label)=>`<label style="display:block;margin-top:9px"><input type="checkbox" name="${name}"> ${label}</label>`;
const names=v=>String(v||"").split(/[\n,，、;；]+/).map(x=>x.trim()).filter(Boolean);
/**
 * 劳务记录解析：格式不必严格。
 * 约定写法是「姓名|银行账号|开户行（可选）|金额」，但实际粘贴来的可能是
 * 老的六列、也可能少了开户行、金额带 ¥ 和千分位。这里按内容识别：
 * 金额取最后一个像金额的段，账号取 10 位以上数字段，其余按开户行/角色兜底。
 */
const labor=v=>String(v||"").split(/\n+/).map(s=>s.trim()).filter(Boolean).map(line=>{
  /**
   * 有竖线按竖线切；没有竖线（直接从 Excel/OCR 复制的整行）按两个以上空白切，
   * 再按内容认字段：18 位身份证、11 位手机、16~19 位账号、带「银行/支行」的是开户行，
   * 剩下的数字取第一个当金额，2~4 个汉字当姓名。
   */
  if(!/[|｜]/.test(line)){
    const toks=line.split(/\s{2,}|\t/).map(x=>x.trim()).filter(Boolean);
    const rec={name:"",bankAccount:"",bankName:"",amount:"",role:"",time:""};
    let sawBank=false;
    for(const t of toks){
      if(/^\d{17}[\dXx]$/.test(t)) continue;              // 身份证
      if(/^1[3-9]\d{9}$/.test(t)) continue;                // 手机
      if(/^\d{16,19}$/.test(t)){ rec.bankAccount=rec.bankAccount||t; continue; }
      if(/(银行|支行|分行|信用社|信用社)/.test(t)){ rec.bankName=t; sawBank=true; continue; }
      if(/^[\d,]+(\.\d+)?$/.test(t)){
        if(!rec.amount&&(sawBank||toks.indexOf(t)>0)) rec.amount=t;
        continue;
      }
      if(/^[\u4e00-\u9fa5]{2,4}$/.test(t)&&!rec.name) rec.name=t;
    }
    return rec;
  }
  const parts=line.split(/[|｜]/).map(x=>x.trim());
  const rec={name:parts[0]||"",bankAccount:"",bankName:"",amount:"",role:"",time:""};
  const rest=parts.slice(1).filter(Boolean);
  for(let i=rest.length-1;i>=0;i--){
    if(/^[¥￥]?\s*[\d,]+(\.\d+)?\s*元?$/.test(rest[i])){rec.amount=rest[i];rest.splice(i,1);break;}
  }
  for(const x of rest){
    if(!rec.bankAccount&&/^[\d\s-]{10,}$/.test(x)){rec.bankAccount=x;continue;}
    if(/^\d{4}-\d{2}-\d{2}$/.test(x)&&!rec.time){rec.time=x;continue;}
    if(/讲者|主持|讨论|专家|嘉宾|授课/.test(x)&&!rec.role){rec.role=x;continue;}
    if(!rec.bankName){rec.bankName=x;continue;}
    if(!rec.role){rec.role=x;continue;}
  }
  return rec;
});
export function sopEvidenceForm(no,p,opt={}){
  const head=`<div class="gate" style="margin-bottom:9px">以下信息来自人工核验/结构化录入，系统只做字段比较；不具备自动 OCR。原件请先在材料中心上传。</div>`;
  const s={
    1:`<div class="hint" style="margin-bottom:8px">关联原件：<b>立项文件</b> + <b>终版议程</b>（须已在材料中心上传）。</div>`
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
    5:area("collectionRecords","劳务收集表（每行：姓名|银行账号|开户行（可选）|金额）","张老师|6222000000000000|工商银行广州分行|1000")
       +area("agreementRecords","劳务协议（同样格式逐行输入）","张老师|6222000000000000|工商银行广州分行|1000")
       +`<div class="hint">格式不必严格：开户行可省，金额写「1000」「¥1,000.00」都行，系统按内容比对。核对只要求人员对得上，字段两边都填了才比，一边没填不算错。银行账号仅用于核验，不进入核销正文或审计。</div>`,
    6:`<div class="hint" style="margin-bottom:8px">已签合同总额：<b>¥${esc(String(opt.signedTotal==null?"":opt.signedTotal))}</b>（拟请款总额须与之一致，已自动填入，可修改）</div>`
       +input("meetingName","拟结算单会议名称",p.name)+input("meetingDate","拟结算单会议日期",p.date)
       +input("draftAmount","拟请款总金额（元）",opt.signedTotal==null?"":String(opt.signedTotal))
  };
  return head+(s[no]||"");
}
export function collectSopEvidence(no,m){
  const get=k=>m.querySelector('[name="'+k+'"]')?.value?.trim()||"";
  const checked=k=>!!m.querySelector('[name="'+k+'"]')?.checked;
  switch(no){
    case 1:return {meetingName:get("meetingName"),
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
