"use strict";
/**
 * 图示 2026-11-01：会后核销六步结构化人工核验。
 * 数据来源目前是人工确认/结构化录入，不声称具有 OCR、图像识别能力。
 * 银行账户和参会人员明细只在内存里进行等值比较，绝不写入 verify_steps 或审计日志。
 */
const { bad, conflict, cents } = require("./util");
const { VERIFY_STEPS } = require("./constants");
/** 每步必须核的原件类别，与前端「关联材料」列表同源 */
const STEP_MATERIALS = Object.fromEntries(VERIFY_STEPS.map((s) => [s.no, s.materials || []]));
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
/** 逐类检查原件，缺哪一类就把类别写进错误里，操作者不用猜 */
function requireMaterials(db,pid,kinds,msg){
  for(const kind of kinds)
    if(!materialExists(db,pid,[kind],true))
      fail(`${msg}（缺少「${kind}」原件）`,"SOP_MATERIAL_MISSING");
}
function validateSopEvidence(no, evidence, project, db, invoiceAmount) {
  if (!evidence || typeof evidence!=="object" || Array.isArray(evidence))
    throw bad("正式核销必须提交结构化核验依据 evidence，不能只点「通过」","SOP_EVIDENCE_REQUIRED");
  const e=evidence, pid=project.id;
  switch(no) {
    case 1: {
      // 关联材料：立项文件 + 终版议程（第 15 条需求）
      if (e.stamped!==true || e.final!==true) fail("第一步须确认盖章函件已盖章且为终版");
      if (!eq(e.meetingName,project.name)||!eq(e.meetingDate,project.date)||!eq(e.organizer,project.assoc))
        fail("盖章函件上的会议名称、时间、主办方与立项信息不一致");
      if (!String(e.sponsor||"").trim()) throw bad("请填写招商主体（无招商须明确填写「不适用」）");
      requireMaterials(db,pid,STEP_MATERIALS[1],"第一步须先登记并上传立项文件与终版议程原件");
      return {materials:STEP_MATERIALS[1], stamped:true, final:true, fieldsMatched:4};
    }
    case 2: {
      if (!sameNames(e.agendaSpeakers,e.collectionSpeakers) || !sameNames(e.agendaSpeakers,e.agreementSpeakers))
        fail("终版议程、劳务收集表、劳务协议讲者名单不一致，或存在重名/漏名");
      requireMaterials(db,pid,["终版议程"],"第二步缺少关联原件");
      // 劳务收集表在归档清单里叫「劳务表」，是同一份《劳务费发放汇总表》
      if(!materialExists(db,pid,["劳务收集表","劳务表"],true))
        fail("第二步缺少劳务收集表原件（也可用劳务表）","SOP_MATERIAL_MISSING");
      // 劳务协议本身就是合同：材料里没传时，以已签署的「劳务专家」类合同为准
      const agreementMaterial=materialExists(db,pid,["劳务协议"],true);
      const agreementContract=Number(db.prepare(
        "SELECT COUNT(*) AS n FROM contracts WHERE pid=? AND status='已签署' AND category='劳务专家'"
      ).get(pid).n)>0;
      if(!agreementMaterial&&!agreementContract)
        fail("第二步缺少劳务协议原件（材料中心未传时，可用已签署的劳务/专家类合同代替）","SOP_MATERIAL_MISSING");
      if(e.noOmissions!==true) fail("须人工确认无冒领、漏发或重复劳务记录");
      return {matchedPeople:list(e.agendaSpeakers).length,noOmissions:true};
    }
    case 3: {
      const form=project.form;
      if(["线上","混合"].includes(form) && !(Number(e.onlineMinutes)>30))
        fail("线上/混合会议的有效讲者在线时长必须大于 30 分钟");
      if(["线下","混合"].includes(form) && e.signedAttendance!==true)
        fail("线下/混合会议须确认已核对签到");
      if(!["线上","线下","混合"].includes(form)) fail("项目会议形式不明确，无法核对参会数据");
      // 关联材料：参会数据文件。线下会议的签到表本身就是参会数据，允许代替。
      const hasData=materialExists(db,pid,[...STEP_MATERIALS[3],"签到表"],true);
      if(!hasData) fail("第三步缺少参会数据原件（签到表同样算参会数据）","SOP_MATERIAL_MISSING");
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
      requireMaterials(db,pid,STEP_MATERIALS[4],"第四步缺少关联原件");
      return {matchedTopics:list(e.agendaTopics).length,hostTitleMatches:true,hostNameLogoMatches:true,
        sponsorLogoPages:[...new Set(e.sponsorLogoPages)]};
    }
    case 5: {
      /**
       * 劳务核对：宽松比对。
       *
       * 老板明确要求「泛内容就行，不是一定要按这个格式比对」——
       * 现实里收集表和协议各有各的模板，字段顺序、有没有开户行、金额写不写「¥」
       * 都不统一。所以这里只坚持一件事：**人要对得上**；其余字段两边都填了才比，
       * 一边没填就跳过，不因为格式差异把人挡在门外。
       */
      const a=e.collectionRecords,b=e.agreementRecords;
      if(!Array.isArray(a)||!a.length||!Array.isArray(b)||!b.length)
        fail("劳务收集表与劳务协议都要录入记录");
      const nameOf=r=>String(r?.name??r?.姓名??"").trim();
      const namesA=a.map(nameOf).filter(Boolean), namesB=b.map(nameOf).filter(Boolean);
      if(!namesA.length||!namesB.length) fail("劳务记录必须写明姓名");
      if(!sameNames(namesA,namesB))
        fail("劳务收集表与劳务协议的姓名对不上（数量或人员不一致）");

      // 归一化：去掉空白、货币符号、千分位；账号里的空格与短横也去掉
      // 账号里的空格/短横、金额的货币符号与千分位、日期的 / 都是写法差异，归一化后再比
      const norm=v=>String(v??"").replace(/[\s¥￥元,，\-\/]/g,"").toLowerCase();
      const cents=v=>{const t=norm(v).replace(/[^\d.-]/g,"");const n=Number(t);return Number.isFinite(n)&&t!==""?Math.round(n*100):null;};
      const fields=[["amount","金额"],["bankAccount","银行账号"],["bankName","开户行"],["role","角色"],["time","时间"]];
      const mapA=new Map(a.map(r=>[nameOf(r),r])), mapB=new Map(b.map(r=>[nameOf(r),r]));
      const diffs=[];let compared=0;
      for(const [name,ra] of mapA){
        const rb=mapB.get(name);if(!rb)continue;
        for(const [k,label] of fields){
          const va=norm(ra?.[k]), vb=norm(rb?.[k]);
          if(!va||!vb)continue;            // 一边没填就不比，不当作错误
          compared++;
          if(k==="amount"){
            const ca=cents(ra?.[k]), cb=cents(rb?.[k]);
            if(ca!==null&&cb!==null){ if(ca!==cb) diffs.push(`${name}的${label}不一致（${ra[k]} / ${rb[k]}）`); continue; }
          }
          if(va!==vb) diffs.push(`${name}的${label}不一致（${ra[k]} / ${rb[k]}）`);
        }
      }
      if(diffs.length) fail("劳务记录存在字段不一致：" + diffs.slice(0,3).join("；"));

      // 关联文件：劳务收集表原件 + 劳务/专家类合同（按合同分类认，不按合同名称猜）
      if(!materialExists(db,pid,["劳务收集表","劳务表"],true))
        fail("第五步缺少劳务收集表原件（也可用劳务表）","SOP_MATERIAL_MISSING");
      const laborContracts=Number(db.prepare(
        "SELECT COUNT(*) FROM contracts WHERE pid=? AND status='已签署' AND category='劳务专家'"
      ).get(pid).n);
      if(!laborContracts)
        fail("第五步缺少已签署的劳务/专家类合同（合同分类须为「劳务专家」）","SOP_MATERIAL_MISSING");
      // 不返回、存储姓名、账号或记录原文。
      return {matchedLaborRecords:namesA.length,matchedFields:compared,laborContracts,
        accountDataStored:false,lenient:true};
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
