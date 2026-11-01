"use strict";
/**
 * 图示 2026-11-01：会后核销六步结构化人工核验。
 * 数据来源目前是人工确认/结构化录入，不声称具有 OCR、图像识别能力。
 * 银行账户和参会人员明细只在内存里进行等值比较，绝不写入 verify_steps 或审计日志。
 */
const { bad, conflict, cents } = require("./util");
const eq = (a,b) => String(a ?? "").trim().replace(/\s+/g,"") === String(b ?? "").trim().replace(/\s+/g,"");
const list = (a) => Array.isArray(a) ? a.map(x=>String(x ?? "").trim()).filter(Boolean) : [];
function sameNames(a,b) {
  const A=list(a),B=list(b);
  return A.length>0 && A.length===B.length &&
    new Set(A).size===A.length && new Set(B).size===B.length &&
    [...A].sort().every((s,i)=>s===[...B].sort()[i]);
}
function fail(msg,code="SOP_EVIDENCE_MISMATCH"){throw conflict(msg,code);}
function materialExists(db,pid,kinds,requireFile=false){
  return kinds.some(kind=>Number(db.prepare(
    "SELECT COUNT(*) AS n FROM materials WHERE pid=? AND kind=? AND (deleted_at IS NULL OR deleted_at='')" +
    (requireFile ? " AND file_key IS NOT NULL AND file_key<>''" : "")
  ).get(pid,kind).n)>0);
}
function validateSopEvidence(no, evidence, project, db, invoiceAmount) {
  if (!evidence || typeof evidence!=="object" || Array.isArray(evidence))
    throw bad("正式核销必须提交结构化核验依据 evidence，不能只点「通过」","SOP_EVIDENCE_REQUIRED");
  const e=evidence, pid=project.id;
  switch(no) {
    case 1: {
      if (!["会议通知","招商函"].includes(e.documentKind)) throw bad("第一步请选择盖章的会议通知或招商函");
      if (e.stamped!==true || e.final!==true) fail("第一步须确认文件已盖章且为终版");
      if (!eq(e.meetingName,project.name)||!eq(e.meetingDate,project.date)||!eq(e.organizer,project.assoc))
        fail("通知/招商函的会议名称、时间、主办方与立项信息不一致");
      if (!String(e.sponsor||"").trim()) throw bad("请填写招商主体（无招商须明确填写「不适用」）");
      if (!materialExists(db,pid,[e.documentKind],true)) fail("请先登记并上传已盖章的会议通知/招商函原件","SOP_MATERIAL_MISSING");
      return {documentKind:e.documentKind, stamped:true, final:true, fieldsMatched:4};
    }
    case 2: {
      if (!sameNames(e.agendaSpeakers,e.collectionSpeakers) || !sameNames(e.agendaSpeakers,e.agreementSpeakers))
        fail("议程、劳务收集表、劳务协议讲者名单不一致，或存在重名/漏名");
      for(const kind of ["议程","劳务收集表","劳务协议"])
        if(!materialExists(db,pid,[kind],true)) fail("第二步缺少已上传的 "+kind+" 原件","SOP_MATERIAL_MISSING");
      if(e.noOmissions!==true) fail("须人工确认无冒领、漏发或重复劳务记录");
      return {matchedPeople:list(e.agendaSpeakers).length,noOmissions:true};
    }
    case 3: {
      const form=project.form;
      if(["线上","混合"].includes(form) && !(Number(e.onlineMinutes)>30))
        fail("线上/混合会议的有效讲者在线时长必须大于 30 分钟");
      if(["线下","混合"].includes(form) && (e.signedAttendance!==true ||
         !materialExists(db,pid,["签到表"],true)))
        fail("线下/混合会议须提供签到表原件并确认签到");
      if(!["线上","线下","混合"].includes(form)) fail("项目会议形式不明确，无法核对参会数据");
      return {format:form,onlineMinutes:["线上","混合"].includes(form)?Number(e.onlineMinutes):null,
        signedAttendance:["线下","混合"].includes(form)?true:null};
    }
    case 4: {
      if(!sameNames(e.agendaTopics,e.courseTopics)) fail("课件课题与终版议程不一致");
      if(e.hostTitleMatches!==true || e.hostNameLogoMatches!==true)
        fail("串场题目或主办方名称/logo 与终版议程不一致");
      if (!Array.isArray(e.sponsorLogoPages) ||
          e.sponsorLogoPages.some(p=>!["首页","尾页","鸣谢页"].includes(p)))
        fail("药企 logo 只能出现在首页、尾页或鸣谢页");
      if(!materialExists(db,pid,["课件"],true)||!materialExists(db,pid,["串场"],true))
        fail("课件或串场材料缺少原件","SOP_MATERIAL_MISSING");
      return {matchedTopics:list(e.agendaTopics).length,hostTitleMatches:true,hostNameLogoMatches:true,
        sponsorLogoPages:[...new Set(e.sponsorLogoPages)]};
    }
    case 5: {
      const a=e.collectionRecords,b=e.agreementRecords;
      if(!Array.isArray(a)||!Array.isArray(b)||!a.length||a.length!==b.length) fail("劳务收集表与协议条数不一致");
      const keys=["name","time","role","amount","bankAccount"];
      const norm = x=> keys.map(k=>String(x?.[k]??"").trim()).join("\u001f");
      if(a.some(x=>keys.some(k=>!String(x?.[k]??"").trim())) ||
         b.some(x=>keys.some(k=>!String(x?.[k]??"").trim())))
        fail("劳务五字段（姓名/时间/角色/金额/银行账号）不得缺漏");
      if(new Set(a.map(norm)).size!==a.length || new Set(b.map(norm)).size!==b.length ||
         a.map(norm).sort().some((x,i)=>x!==b.map(norm).sort()[i]))
        fail("劳务收集表与劳务协议五字段不一致");
      // 不返回、存储姓名、账号或记录原文。
      return {matchedLaborRecords:a.length,matchedFields:keys.length,accountDataStored:false};
    }
    case 6: {
      if(!Number.isFinite(invoiceAmount)||invoiceAmount<0) throw bad("请输入核对后的发票金额");
      const total=db.prepare("SELECT COALESCE(SUM(amount),0) AS total FROM contracts WHERE pid=? AND status='已签署'").get(pid).total;
      if(cents(e.draftAmount)!==cents(total)) fail("拟请款总额必须与已签署合同总额一致");
      const taxable=db.prepare("SELECT COALESCE(SUM(amount),0) AS total FROM contracts WHERE pid=? AND status='已签署' AND COALESCE(category,'')<>'劳务专家'").get(pid).total;
      if(cents(invoiceAmount)!==cents(taxable)) fail("发票金额必须与应开票合同金额一致；劳务专家协议免票单独核验");
      if(!eq(e.meetingName,project.name)||!eq(e.meetingDate,project.date))
        fail("拟结算单/发票的会议名称或会议时间与立项信息不一致");
      if(cents(taxable)>0 && !materialExists(db,pid,["发票"],true)) fail("尚无发票原件","SOP_MATERIAL_MISSING");
      // 此处核对的是拟结算明细，不是提前生成正式可付款结算单。
      return {draftAmount:Number(e.draftAmount),invoiceAmount,nonInvoiceLaborAmount:(cents(total)-cents(taxable))/100,meetingMatched:true};
    }
    default: throw bad("核销步骤必须为 1~6");
  }
}
module.exports = {validateSopEvidence, sameNames};
