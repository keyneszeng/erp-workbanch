"use strict";
/**
 * 图示 2026-11-01：会后核销六步结构化人工核验。
 * 数据来源目前是人工确认/结构化录入，不声称具有 OCR、图像识别能力。
 * 银行账户和参会人员明细只在内存里进行等值比较，绝不写入 verify_steps 或审计日志。
 */
const { bad, conflict, cents } = require("./util");
const {laborSheetInfo}=require("./labor-sop");
const {linkLaborContracts}=require("./labor-contracts");
const {demandSopState}=require("./meeting-demand-sop");
const {validateRightsEvidence}=require("./sponsor-rights");
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
      return {documentKind:e.documentKind,stamped:true,final:true,fieldsMatched:3,
        comparedWith:"串场"};
    }
    case 2: {
      // 以当前终版议程讲者名单为唯一基准：只核对签到表及讲者照片。
      // 不引用劳务表、个人合同或其他台账中的名单。
      const baseline=list(e.agendaSpeakers);
      if(!sameNames(baseline,baseline))
        fail("终版议程讲者名单不能为空或有重复姓名");
      if(!sameNames(baseline,e.attendanceSpeakers))
        fail("签到表中的讲者姓名与终版议程不一致，请核对缺失、多余或重复姓名");
      if(!sameNames(baseline,e.photoSpeakers))
        fail("讲者照片填写的姓名与终版议程不一致，请核对缺失、多余或重复姓名");
      for(const kind of ["终版议程","签到表","讲者照片"])
        if(!materialExists(db,pid,[kind],true))
          fail("第二步缺少已上传的 "+kind+" 原件","SOP_MATERIAL_MISSING");
      const current=db.prepare("SELECT COUNT(*) AS n FROM materials WHERE pid=? AND kind='终版议程' AND version='终版' AND (deleted_at IS NULL OR deleted_at='') AND file_key IS NOT NULL AND file_key<>''").get(pid);
      if(!Number(current?.n))fail("请上传并确认当前终版议程原件，历史版不能用于核销","SOP_MATERIAL_MISSING");
      const photos=db.prepare("SELECT name FROM materials WHERE pid=? AND kind='讲者照片' AND (deleted_at IS NULL OR deleted_at='') AND file_key IS NOT NULL AND file_key<>''").all(pid).map(x=>String(x.name||"").trim());
      if(!sameNames(baseline,photos))
        fail("材料库讲者照片登记姓名与终版议程讲者名单不一致：请逐人上传照片并核对缺失、多余或重复");
      if(e.noOmissions!==true)fail("须人工确认签到表与讲者照片名单均与终版议程一致，无漏项、冒名或重复");
      return {matchedPeople:baseline.length,matchedSources:["终版议程","签到表","讲者照片"],
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
      // 仅关联本项目材料库有效的个人合同原件，不以会务总合同替代。
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
      if(!d.required)fail("当前没有标记「需要」的会务需求，第6项不适用","SOP_NOT_APPLICABLE");
      if(!d.confirmed)fail("请先确认并归档会务需求清单","DEMAND_NOT_CONFIRMED");
      if(!d.agenda.length)fail("请上传并确认当前终版议程原件","SOP_MATERIAL_MISSING");
      if(!d.agreements.length)fail("请上传终版会务协议/会务合同原件（可在材料库「会务协议」或「合同」类别中登记）","SOP_MATERIAL_MISSING");
      if(!d.contractCount)fail("请先签署会务合同，并在合同台账登记合同金额","CONTRACT_NOT_SIGNED");
      if(!d.invoices.length)fail("请上传会务发票原件","SOP_MATERIAL_MISSING");
      const fields=["agendaTitle","agendaTime","agendaFormat","agreementTitle","agreementTime","agreementFormat","agreementPartyA"];
      if(fields.some(k=>!String(e[k]||"").trim()))
        fail("请从终版议程和会务协议分别填写会议主题、时间、形式，以及协议甲方");
      if(!eq(e.agendaTitle,e.agreementTitle)||!eq(e.agendaTime,e.agreementTime)||
         !eq(e.agendaFormat,e.agreementFormat))
        fail("会务协议中的会议主题、时间或形式与终版议程不一致");
      if(!["线下","线上","混合"].includes(String(e.agendaFormat)))
        fail("会议形式必须是线下、线上或混合");
      if(!eq(e.agreementPartyA,project.assoc))
        fail("会务协议甲方与本项目所属协会主体不一致");
      if(e.agreementFinal!==true)
        fail("须确认核对的会务协议是终版协议原件");
      if(!Number.isFinite(invoiceAmount)||invoiceAmount<0)
        throw bad("请输入核对后的会务发票总金额");
      if(cents(d.budgetTotal)!==cents(d.contractTotal))
        fail("会务需求总预算与已签署会务合同总金额不一致");
      if(cents(invoiceAmount)!==cents(d.budgetTotal))
        fail("会务发票总金额、会务需求总预算与已签署会务合同总金额不一致");
      // 输入属于人工阅读原件后逐项录入。仅留摘要，避免把协议全文写进审计日志。
      return {meetingMatched:true,matchedFields:4,meetingContractTotal:d.contractTotal,
        demandBudget:d.budgetTotal,invoiceAmount,needCount:d.needCount,
        demandSopSignature:d.signature,comparedWith:"终版议程+终版会务协议"};
    }
    case 7: return validateRightsEvidence(db,pid,e);
    default: throw bad("核销步骤必须为 1~7");
  }
}
module.exports = {validateSopEvidence, sameNames};
