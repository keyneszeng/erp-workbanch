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
      // 五份材料逐人比对。签到表只录入讲者姓名，普通参会者不计入讲者交集。
      // 照片不做未经验证的人脸识别：人工确认姓名，并与实际照片登记名称再核对。
      const sources=[
        ["终版议程",e.agendaSpeakers],
        ["劳务收集表",e.collectionSpeakers],
        ["劳务协议",e.agreementSpeakers],
        ["签到表",e.attendanceSpeakers],
        ["讲者照片",e.photoSpeakers]
      ];
      const baseline=sources[0][1];
      if(!sameNames(baseline,baseline) ||
          sources.slice(1).some(([,speakers])=>!sameNames(baseline,speakers)))
        fail("终版议程、劳务收集表、劳务协议、签到表、讲者照片的讲者姓名不一致，或存在漏名、重名");
      for(const [kind] of sources)
        if(!materialExists(db,pid,[kind],true))
          fail("第二步缺少已上传的 "+kind+" 原件","SOP_MATERIAL_MISSING");
      // 旧版议程已降为历史版时不得冒充当前终版。
      const current=db.prepare(
        "SELECT COUNT(*) AS n FROM materials WHERE pid=? AND kind='终版议程' AND version='终版' "+
        "AND (deleted_at IS NULL OR deleted_at='') AND file_key IS NOT NULL AND file_key<>''"
      ).get(pid);
      if(!Number(current?.n))
        fail("请上传并确认当前终版议程原件，历史版不能用于核销","SOP_MATERIAL_MISSING");
      const photos=db.prepare(
        "SELECT name FROM materials WHERE pid=? AND kind='讲者照片' "+
        "AND (deleted_at IS NULL OR deleted_at='') AND file_key IS NOT NULL AND file_key<>''"
      ).all(pid).map(row=>String(row.name||"").trim());
      if(!sameNames(baseline,photos))
        fail("讲者照片登记姓名与终版议程讲者名单不一致：请逐人上传照片并以讲者姓名登记");
      if(e.noOmissions!==true)
        fail("须人工确认五处讲者信息及照片一致，无冒领、漏发或重复劳务记录");
      // 只保存通过人数和核验来源摘要；姓名、照片关联与账户数据均不写入证据或审计。
      return {matchedPeople:list(baseline).length,matchedSources:sources.map(([kind])=>kind),
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
      const normalize=topic=>topic.replace(/\\s+/g,"");
      const allowed=new Set(agendaTopics.map(normalize));
      if(courseTopics.some(topic=>!allowed.has(normalize(topic))))
        fail("课件主题不在当前终版议程中，请核对课件与终版议程原件");
      // 只保留核对数量，不保存主题原文，不产生额外串场/品牌核验要求。
      return {matchedTopics:courseTopics.length,comparedWith:"终版议程"};
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
