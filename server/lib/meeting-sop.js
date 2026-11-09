"use strict";
/**
 * 图示 2026-11-01：会后核销七步结构化人工核验。
 * 数据来源目前是人工确认/结构化录入，不声称具有 OCR、图像识别能力。
 * 银行账户和参会人员明细只在内存里进行等值比较，绝不写入 verify_steps 或审计日志。
 */
const { bad, conflict, cents } = require("./util");
const {laborSheetInfo}=require("./labor-sop");
const {linkLaborContracts}=require("./labor-contracts");
const {demandSopState}=require("./meeting-demand-sop");
const {validateRightsEvidence}=require("./sponsor-rights");
const {photoName,compareNames,speakerName}=require("./verify-agenda-evidence");
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
      if (e.stamped!==true || e.final!==true) fail("第一步须确认函件已盖章且为终版");
      // 核对的是两份真实材料，不再用立项元数据代替「串场」，也不要求招商主体。
      const fields=["meetingName","meetingDate","organizer","hostMeetingName","hostMeetingDate","hostOrganizer"];
      if (fields.some(k=>!String(e[k]||"").trim()))
        throw bad("请分别填写盖章函件与串场的会议名称、日期和主办方");
      if (!eq(e.meetingName,e.hostMeetingName)||!eq(e.meetingDate,e.hostMeetingDate)||
          !eq(e.organizer,e.hostOrganizer))
        fail("盖章函件与串场的会议名称、日期或主办方不一致");
      if (!materialExists(db,pid,[e.documentKind],true))
        fail("请先上传已盖章的会议通知或招商函原件","SOP_MATERIAL_MISSING");
      if (!materialExists(db,pid,["串场"],true))
        fail("请先上传串场原件，用于与盖章函件核对","SOP_MATERIAL_MISSING");
      // Link only the current confirmed agenda: historical agendas must not be treated as evidence.
      const finalAgenda=db.prepare(
        "SELECT COUNT(*) AS n FROM materials WHERE pid=? AND kind='终版议程' AND version='终版' "+
        "AND (deleted_at IS NULL OR deleted_at='') AND file_key IS NOT NULL AND file_key<>''"
      ).get(pid);
      if(!Number(finalAgenda?.n))
        fail("请先上传并确认当前终版议程原件，用于与盖章函件和串场核验","SOP_MATERIAL_MISSING");
      return {documentKind:e.documentKind,stamped:true,final:true,fieldsMatched:3,
        comparedWith:"串场",matchedSources:[e.documentKind,"终版议程","串场"]};
    }
    case 2: {
      // 核销第2项：当前终版议程的讲者 ↔ 讲者照片原始文件名。
      // 签到表仅供核销第3项使用；OCR模式从终版议程提取人名。
      const baseline=list(e.agendaSpeakers).map(speakerName);
      if(!sameNames(baseline,baseline))
        fail("终版议程讲者名单不能为空或有重复姓名");
      for(const kind of ["终版议程","讲者照片"])
        if(!materialExists(db,pid,[kind],true))
          fail("第二步缺少已上传的 "+kind+" 原件","SOP_MATERIAL_MISSING");
      const current=db.prepare("SELECT COUNT(*) AS n FROM materials WHERE pid=? AND kind='终版议程' AND version='终版' AND (deleted_at IS NULL OR deleted_at='') AND file_key IS NOT NULL AND file_key<>''").get(pid);
      if(!Number(current?.n))fail("请上传并确认当前终版议程原件，历史版不能用于核销","SOP_MATERIAL_MISSING");
      const photos=db.prepare("SELECT name,file_name FROM materials WHERE pid=? AND kind='讲者照片' AND (deleted_at IS NULL OR deleted_at='') AND file_key IS NOT NULL AND file_key<>''").all(pid);
      const matched=compareNames(baseline,photos.map(photoName));
      if(!matched.matched||matched.photoCount!==photos.length)
        fail("讲者照片原始文件名与终版议程名单不一致，请检查缺失、多余、重复或无法识别姓名的照片");
      if(Array.isArray(e.photoSpeakers)&&e.photoSpeakers.length&&!sameNames(baseline,e.photoSpeakers.map(speakerName)))
        fail("人工录入的照片讲者名单与终版议程不一致");
      if(e.noOmissions!==true)fail("须人工确认终版议程与讲者照片逐人一致，无漏项、冒名或重复");
      return {matchedPeople:baseline.length,matchedSources:["终版议程","讲者照片"],
        photoRecordsMatched:photos.length,noOmissions:true};
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
      // 仅核验课件已上传、课件主题属于当前终版议程；不要求整份议程的
      // 每个主题都上传课件，也不再校验串场、Logo 或药企展示位置。
      if(!materialExists(db,pid,["课件"],true))
        fail("请先在材料库上传课件原件","SOP_MATERIAL_MISSING");
      const finalAgenda=db.prepare(
        "SELECT COUNT(*) AS n FROM materials WHERE pid=? AND kind='终版议程' AND version='终版' "+
        "AND (deleted_at IS NULL OR deleted_at='') AND file_key IS NOT NULL AND file_key<>''"
      ).get(pid);
      if(!Number(finalAgenda?.n))
        fail("请先上传并确认当前终版议程原件，历史版不能作为核验依据","SOP_MATERIAL_MISSING");
      const agendaTopics=list(e.agendaTopics),courseTopics=list(e.courseTopics);
      if(!agendaTopics.length || !courseTopics.length)
        throw bad("请从终版议程及已上传课件原件分别录入主题");
      const normalize=topic=>topic.replace(/\s+/g,"");
      const allowed=new Set(agendaTopics.map(normalize));
      if(courseTopics.some(topic=>!allowed.has(normalize(topic))))
        fail("课件主题不在当前终版议程中，请核对课件与终版议程原件");
      // 只保留核对数量，不保存主题原文，不产生额外串场/品牌核验要求。
      return {matchedTopics:courseTopics.length,comparedWith:"终版议程"};
    }
    case 5: {
      const source=laborSheetInfo(db,pid);
      if(!source.required)fail("未上传劳务表原件，第5项不适用","SOP_NOT_APPLICABLE");
      const rows=e.collectionRecords,keys=["name","time","role","amount","bankAccount"];
      if(!Array.isArray(rows)||!rows.length)fail("请根据已上传劳务表录入劳务明细");
      const norm=x=>keys.map(k=>String(x?.[k]??"").trim()).join("\u001f");
      if(rows.some(x=>keys.some(k=>!String(x?.[k]??"").trim())))
        fail("劳务表五字段（姓名/时间/角色/金额/银行账号）不得缺漏");
      if(new Set(rows.map(norm)).size!==rows.length||new Set(rows.map(x=>String(x.name).trim())).size!==rows.length)
        fail("劳务表存在重复讲者或重复劳务记录");
      if(rows.some(x=>!Number.isFinite(Number(x.amount))||Number(x.amount)<=0))
        fail("劳务金额必须为正数");
      // 第5项只关联劳务专家合同原件；会务合同、赞助合同均不得替代。
      const linked=linkLaborContracts(db,pid,rows.map(r=>r.name));
      if(linked.missing.length)
        fail("材料库缺少以下人员的同名合同原件："+linked.missing.join("、"),"SOP_PERSON_CONTRACT_MISSING");
      if(linked.ambiguous.length)
        fail("以下人员存在多份同名合同，请消除歧义："+linked.ambiguous.join("、"),"SOP_PERSON_CONTRACT_AMBIGUOUS");
      return {matchedLaborRecords:rows.length,matchedFields:keys.length,
        laborSourceSignature:source.signature,
        matchedContractMaterialIds:linked.linked.map(x=>Number(x.id)),
        contractPoolSignature:linked.contractPoolSignature,
        matchedContracts:linked.linked.length,accountDataStored:false};
    }
    case 6: {
      const d=demandSopState(db,pid);
      if(!d.required)fail("尚未建立会务需求表，第6项不适用","SOP_NOT_APPLICABLE");
      if(!d.confirmed)fail("请先确认并归档会务需求表","DEMAND_NOT_CONFIRMED");
      if(!d.contractCount)fail("请先签署「会务需求」类别合同","CONTRACT_NOT_SIGNED");
      if(!d.agreements.length)fail("请上传已签署会务合同对应的原件","SOP_MATERIAL_MISSING");
      if(!d.invoices.length)fail("请上传会务发票原件","SOP_MATERIAL_MISSING");
      if(e.demandReviewed!==true||e.meetingContractReviewed!==true||e.meetingInvoiceReviewed!==true)
        fail("请逐项人工检查会务需求表、已签会务合同和会务发票原件");
      if(cents(d.budgetTotal)!==cents(d.contractTotal))
        fail("会务需求总预算与已签署会务合同总金额不一致");
      return {meetingMatched:true,matchedFields:2,invoiceLinked:true,invoiceCount:d.invoices.length,meetingContractTotal:d.contractTotal,
        demandBudget:d.budgetTotal,needCount:d.needCount,
        demandSopSignature:d.signature,comparedWith:"会务需求表+会务合同+会务发票"};
    }
    case 7: return validateRightsEvidence(db,pid,e);
    default: throw bad("核销步骤必须为 1~7");
  }
}
module.exports = {validateSopEvidence, sameNames};
