"use strict";
const { db, transaction } = require("../lib/db");
const { now, nextId, bad, notFound, conflict, forbidden, yuan, cents } = require("../lib/util");
const { isDemoMode } = require("../lib/runtime");
const { assertCan, assertModule, assertProjectVisible, isSuper } = require("../lib/rbac");
const { logAudit } = require("../lib/audit");
const { getProject, verification, materialsStatus, settlementOf, demandSummary } = require("../lib/workflow");
const { MATERIAL_KINDS, MATERIAL_MODULE_KINDS } = require("../lib/constants");
const { readPaging, countOf } = require("../lib/paginate");
const { storage } = require("../lib/storage");
const { sniffMime, safeName, ALLOWED_MIME, MAX_BYTES } = require("../lib/storage");
const { assertUploadAttachable } = require("../lib/upload-ownership");
const { validateSopEvidence } = require("../lib/meeting-sop");
const {sponsorRights}=require("../lib/sponsor-rights");
const {buildSettlementBreakdown}=require("../lib/settlement-breakdown");
const verifyOcr=require("../lib/verify-ocr-compare");
const {sponsorRights:currentSponsorRights,validateRightsEvidence}=require("../lib/sponsor-rights");
let scanningVerification=false;

function register(router) {
  /**
   * 核销看板：7 步 + 例外 + 结算 + 材料（前四项必核、后三项按条件适用）。
   *
   * 同时把「核对所需的原始数据」一并带出去（材料 / 合同 / 付款）：
   * 判定人点「详情」时要能当场看到议程、签到表、票据、合同与付款金额，
   * 否则只能凭印象点「通过」—— 核销就退化成橡皮图章。
   * 一次请求取全，避免弹窗再打三个接口、也避免各接口口径不一致。
   */
  router.get("/api/projects/:id/verify", async (ctx) => {
    // 项目成员关系不授予财务核销凭证查看权；嘉宾可看会议信息但不能读账目。
    assertModule(ctx.user, "verify", "verify:check");
    const p = getProject(ctx.params.id);
    assertProjectVisible(ctx.user, p);
    const materials = db.prepare("SELECT * FROM materials WHERE pid = ? AND deleted_at IS NULL ORDER BY kind, id").all(p.id);
    const contracts = db.prepare("SELECT * FROM contracts WHERE pid = ? ORDER BY id").all(p.id);
    const payments = db.prepare("SELECT * FROM payments WHERE pid = ? ORDER BY created_at DESC, id DESC").all(p.id);
    return {
      project: p,
      verification: verification(p.id),
      materialsStatus: materialsStatus(p.id),
      settlement: settlementOf(p.id),
      materials,
      contracts,
      payments,
      // 归档的会务需求单 —— 核销第 3 步的费用对照基准（与项目详情页同源）
      demand: demandSummary(p.id),
      sponsorRights:sponsorRights(db,p.id),
      // 逐笔 reduce 会累积浮点尾巴，收敛到「分」再给前端
      paidTotal: yuan(payments.filter((y) => y.status === "已付款").reduce((s, y) => s + Number(y.amount), 0))
    };
  });

  /**
   * OCR 扫描→关键字段提取→跨材料比较。只生成“建议”，从不自动改核销状态。
   * 复用 material_ocr_results 缓存，按 file_key 版本严格绑定，改件即失效。
   */
  router.post("/api/projects/:id/verify/steps/:no/scan",async ctx=>{
    assertCan(ctx.user,"verify:check","没有核销OCR比对权限");
    const p=getProject(ctx.params.id);
    assertProjectVisible(ctx.user,p);
    const no=Number(ctx.params.no);
    if(!Number.isInteger(no)||no<1||no>7)throw bad("核销步骤编号必须为1~7");
    const step=verification(p.id).steps.find(x=>x.no===no);
    if(step?.required===false)throw conflict("本项目该核销项不适用","SOP_NOT_APPLICABLE");
    if(scanningVerification)throw Object.assign(new Error("另一个核销文件正在OCR处理中，请稍后重新扫描"),{status:429,code:"OCR_BUSY"});
    scanningVerification=true;
    try{
      const result=await verifyOcr.scan(p.id,no,ctx.user.name);
      logAudit({user:ctx.user,module:"会后核销",action:"OCR智能比对",target:p.id,
        detail:"步骤"+no+"；关联材料"+result.total+"份，实际可识别"+result.scanned+"份；相符"+result.summary.match+"，疑点"+result.summary.mismatch+"，待人工确认"+result.summary.uncertain,
        ip:ctx.ip});
      return {report:result};
    }finally{scanningVerification=false;}
  });

  /** 单步判定 */
  router.post("/api/projects/:id/verify/steps/:no", async (ctx) => {
    const p = getProject(ctx.params.id);
    assertProjectVisible(ctx.user, p);
    assertCan(ctx.user, "verify:check", "当前角色无核销判定权限");
    const no = Number(ctx.params.no);
    if (!(no >= 1 && no <= 7)) throw bad("步骤编号应为 1~7");
    const settled = settlementOf(p.id);
    if (settled && !isSuper(ctx.user)) throw conflict("结算单已生成，核销结论已冻结，不可修改", "FROZEN");
    if (!["待核销"].includes(p.status) && !(p.status === "已核销" && isSuper(ctx.user))) {
      throw conflict(`当前状态「${p.status}」不可判定核销，只有「待核销」项目可判定`, "ILLEGAL_STATE", { status: p.status });
    }
    // 不再核验固定材料类别齐备度。任何一份上传原件即可解锁核销入口。
    const ms = materialsStatus(p.id);
    if (!ms.ok)
      throw conflict("请先上传至少一份会议材料附件，再进行核销判定","MATERIAL_GATE",
        { missing: ms.missing });

    const { result } = ctx.body || {};
    const isAuto=ctx.body?.auto===true;
    // 防止绕过UI直接构造“已OCR一致”的请求；每次判定验证材料版本与缓存哈希。
    const ocrReport=isAuto?verifyOcr.verifiedReport(p.id,no,ctx.body?.scanToken):null;
    if(isAuto && result==="通过" && (!ocrReport.total || (!ocrReport.scanned && ![3,7].includes(no))))
      throw conflict("未取得有效的OCR比对资料，不能直接判定通过；请先上传可识别的PDF或图片原件","OCR_EVIDENCE_REQUIRED");
    let remark=isAuto
      ?(result==="不通过"?
        "OCR比对异常/人工未认可："+(ocrReport.checks.filter(x=>x.status!=="一致").slice(0,3)
         .map(x=>x.name+"（"+x.detail+"）").join("；")||"原件复核不通过")
        :"OCR比对后由人工核验通过；OCR疑点"+ocrReport.summary.mismatch+"项，待确认"+ocrReport.summary.uncertain+"项")
      :String(ctx.body?.remark||"");
    if (!["通过", "不通过"].includes(result)) throw bad("判定结果只能是「通过」或「不通过」");
    if (String(remark || "").length > 1000) throw bad(`问题描述不能超过 1000 字（当前 ${String(remark).length} 字）`);
    if (result === "不通过" && !String(remark || "").trim()) throw bad("判定不通过必须填写问题描述");

    // 七项核销彼此独立，可以任意顺序判定和重新判定。
    // 仅在最终「核销通过」时检查当前适用步骤全部通过且无未决例外。
    const v = verification(p.id);
    const def = v.steps.find((s) => s.no === no);
    if(no===5 && !v.laborRequired)throw conflict("材料库无劳务表，第5项自动不适用，无需核销","SOP_NOT_APPLICABLE");
    if(no===6 && !v.demandRequired)throw conflict("尚未建立会务需求表，第6项不适用","SOP_NOT_APPLICABLE");
    if(no===7 && !v.rightsRequired)throw conflict("当前没有赞助权益内容或权益照片，第7项不适用","SOP_NOT_APPLICABLE");
    let invoiceAmount = null;
    if (!isDemoMode() && no===6 && result==="通过") {
      const demand=require("../lib/meeting-demand-sop").demandSopState(db,p.id);
      if(!demand.confirmed)throw conflict("请先确认并归档会务需求","DEMAND_NOT_CONFIRMED");
      if(!demand.contractCount)throw conflict("没有已签署的会务合同","CONTRACT_NOT_SIGNED");
      if(!demand.agreements.length || !demand.invoices.length)
        throw conflict("需上传会务需求类别合同对应原件及会务发票，不关联终版议程","SOP_MATERIAL_MISSING");
      /**
       * 第 6 步口径已改为「会务合同与发票关联核对」：只要求
       * 会务需求预算 == 已签会务合同总额，并已关联发票原件，**不校验发票金额**。
       * 旧版这里还强制 OCR 唯一识别发票金额并要求三方一致，导致项目里有多张
       * 发票（会务发票 + 赞助发票）或发票是扫描件时，提示
       * 「OCR未能从会务发票唯一可靠识别金额」永远判不了通过。
       * invoice_amount 仍按可识别到的值记录供查阅，但不再作为门禁条件。
       */
      if(cents(demand.budgetTotal)!==cents(demand.contractTotal))
        throw conflict("会务需求总预算与已签署会务合同总金额不一致","MEETING_THREE_WAY_MISMATCH");
      const candidate=isAuto?ocrReport.invoiceAmount:ctx.body?.invoiceAmount;
      invoiceAmount=(candidate===null||candidate===undefined||candidate==="")?null:Number(candidate);
      if(invoiceAmount!==null&&(!Number.isFinite(invoiceAmount)||invoiceAmount<0))invoiceAmount=null;
    }
    if (!isDemoMode() && result==="通过") {
      const outstanding = db.prepare("SELECT id,resolved_at,evidence_material_id FROM exceptions WHERE pid=? AND step_no=? AND status='待复核'").all(p.id,no);
      if (outstanding.some(ex=>!ex.resolved_at || !ex.evidence_material_id))
        throw conflict("例外已审批，但尚未登记处理结果与证据；完成整改后再返回本步核销", "EXCEPTION_REMEDIATION_REQUIRED");
    }
    const pending = db.prepare("SELECT COUNT(*) AS n FROM exceptions WHERE pid=? AND step_no=? AND status='待审批'").get(p.id,no).n;
    if (!isDemoMode() && result==="通过" && pending)
      throw conflict("此步骤存在未处理例外单，请先完成例外处理，再返回原步骤复核", "EXCEPTION_NOT_HANDLED");
    // 第7项仍要求确认完整权益目录，并关联每项照片；OCR不能替代真实照片的人工审核。
    if(isAuto && no===7 && result==="通过"){
      const snap=currentSponsorRights(db,p.id);
      validateRightsEvidence(db,p.id,{verifiedRights:snap.requiredRights.map(r=>r.id)});
    }
    const validated=isAuto ? ocrReport.evidence : (!isDemoMode() && result==="通过"
      ? validateSopEvidence(no,ctx.body?.evidence,p,db,invoiceAmount) : null);
    const at = now();
    // 重新核验仅更新当前步骤；不清除其他步骤的判定、依据或发票核对结果。
    db.prepare(
      "INSERT OR REPLACE INTO verify_steps (pid,step_no,name,result,remark,invoice_amount,checked_by,checked_at,evidence_json) VALUES (?,?,?,?,?,?,?,?,?)"
    ).run(p.id, no, def.name, result, String(remark || ""), invoiceAmount, ctx.user.name, at,
      validated ? JSON.stringify(validated) : null);
    // 第五步通过后把劳务收款账号以 AES-GCM 加密保存，付款申请可直接选用。
    // 手工判定取页面录入的劳务表；OCR 判定取服务端从原件识别出的记录
    // （完整账号不经过浏览器，报告里只给尾号）。判定不通过或没有可用记录时清空。
    if(!isDemoMode() && no===5){
      const records=result==="通过"
        ?(isAuto?(ocrReport.laborRecords||[]):(ctx.body?.evidence?.collectionRecords||[]))
        :[];
      const saved=records.length
        ?require("../lib/verified-payees").saveLabor(p.id,records)
        :{saved:false,count:0};
      if(!saved.saved) db.prepare("DELETE FROM verified_labor_payees WHERE pid=?").run(p.id);
      if(validated){
        validated.laborAccountsStored=saved.saved?saved.count:0;
        db.prepare("UPDATE verify_steps SET evidence_json=? WHERE pid=? AND step_no=5")
          .run(JSON.stringify(validated),p.id);
      }
    }
    if (!isDemoMode() && result==="通过") {
      const pendingReview = db.prepare("SELECT id FROM exceptions WHERE pid=? AND step_no=? AND status='待复核'").all(p.id,no);
      for(const ex of pendingReview) {
        db.prepare("UPDATE exceptions SET status='已闭环', comment=COALESCE(comment,'') || ? WHERE id=?")
          .run("；已返回原步骤复核通过："+at,ex.id);
      }
    }

    let message = `第 ${no} 步「${def.name}」判定：${result}`;
    let exId = "";
    let exNote = ""; // 例外单的处理说明，message 与审计共用一套措辞
    const openEx = db
      .prepare("SELECT * FROM exceptions WHERE pid = ? AND step_no = ? AND status = '待审批' ORDER BY created_at")
      .all(p.id, no);

    if (result === "不通过") {
      // 同一步已经有待审批的例外单，就沿用它，不再开第二张。
      // 否则同一个人连点两次「不通过」，审批中心就挂两张同一问题的单子，
      // 财务批完一张还剩一张，核销照样过不去。
      if (openEx.length) {
        exId = openEx[0].id;
        db.prepare("UPDATE exceptions SET reason = ?, created_by = ?, created_at = ? WHERE id = ?")
          .run(String(remark).trim(), ctx.user.name, at, exId);
        exNote = `沿用待审批的例外单 ${exId}（问题描述已更新）`;
      } else {
        exId = nextId(db, "exceptions", "id", "EX");
        db.prepare("INSERT INTO exceptions (id,pid,step_no,reason,status,created_by,created_at) VALUES (?,?,?,?,?,?,?)")
          .run(exId, p.id, no, String(remark).trim(), "待审批", ctx.user.name, at);
        db.prepare(
          "INSERT INTO approvals (id,type,title,pid,ref_id,amount,by_user,sla,status,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)"
        ).run(nextId(db, "approvals", "id", "AP"), "例外单审批", `${exId} ${String(remark).trim().slice(0, 24)}`, p.id, exId, 0,
          ctx.user.name, "2 个工作日", "待审批", at);
        exNote = `已生成例外单 ${exId} 待财务审批`;
      }
    } else if (openEx.length && isDemoMode()) {
      // 改判「通过」：这一步还挂着的待审批例外单必须一并撤销。
      // 不撤的话 openExceptions 永远 > 0，核销永远 complete 不了 ——
      // 判定人只能去求财务批一张「问题已经不存在」的例外单，账就乱了。
      for (const ex of openEx) {
        db.prepare("UPDATE exceptions SET status = '已撤销', approved_by = ?, approved_at = ?, comment = ? WHERE id = ?")
          .run(ctx.user.name, at, `第 ${no} 步改判通过，系统自动撤销`, ex.id);
        db.prepare(
          "UPDATE approvals SET status = '已撤销', decided_by = ?, decided_at = ?, comment = ? " +
          "WHERE ref_id = ? AND type = '例外单审批' AND status = '待审批'"
        ).run(ctx.user.name, at, `第 ${no} 步改判通过，系统自动撤销`, ex.id);
        logAudit({
          user: ctx.user, module: "会后核销", action: "例外单撤销", target: p.id,
          detail: `${ex.id}（第 ${no} 步改判通过，自动撤销）：原问题 ${ex.reason}`, ip: ctx.ip
        });
      }
      exNote = `已自动撤销 ${openEx.length} 张待审批例外单（${openEx.map((x) => x.id).join("、")}）`;
    }
    if (exNote) message += `，${exNote}`;

    logAudit({
      user: ctx.user, module: "会后核销", action: "结论", target: p.id,
      detail: `第 ${no} 步「${def.name}」判定${result}${remark ? "：" + remark : ""}${exNote ? `；${exNote}` : ""}`,
      ip: ctx.ip
    });
    // 判定「不通过」会自动生成例外单（一条待审批的审批项），必须和手工提交走同一条审计口径。
    // 否则事后拿 EX-xxx 去追，只能靠时间猜它从哪来，审计链就断了。
    if (exId && result === "不通过") {
      logAudit({
        user: ctx.user, module: "会后核销", action: "例外单", target: p.id,
        detail: `${exId}（第 ${no} 步判定不通过${openEx.length ? "沿用" : "自动生成"}）：${String(remark).trim()}`, ip: ctx.ip
      });
    }
    return { verification: verification(p.id), message };
  });

  /** 提交例外单（补录） */
  router.post("/api/projects/:id/exceptions", async (ctx) => {
    const p = getProject(ctx.params.id);
    assertProjectVisible(ctx.user, p);
    assertCan(ctx.user, "verify:exception", "当前角色无例外单提交权限");
    const { step_no, reason, step_label } = ctx.body || {};
    // 参数校验放在阶段校验之前：参数本身就是错的（步骤越界、原因超长）应当直接 400，
    // 不该被「项目阶段不对」的 409 盖掉 —— 否则前端拿到的错误原因会误导人。
    //
    // step_no = 0 是「不属于 7 步中任何一步」的整体性问题（如专家临时换人、场地变更），
    // 由人自己写一个事项名。它照样要审批，批完就不再阻塞核销门禁；
    // 区别只是不会把某一步标成「已解例外」—— 因为它本来就不针对某一步。
    const no = Number(step_no);
    const label = String(step_label || "").trim();
    if (no === 0) {
      if (!label) throw bad("选「其他」时必须填写具体事项");
      if (label.length > 60) throw bad(`具体事项不能超过 60 字（当前 ${label.length} 字）`);
    } else if (!(no >= 1 && no <= 7)) {
      throw bad("例外步骤应为第 1~7 步，或选「其他」自行填写具体事项");
    }
    if (!String(reason || "").trim()) throw bad("必须说明例外原因");
    if (String(reason).trim().length > 500) throw bad(`例外原因不能超过 500 字（当前 ${String(reason).trim().length} 字）`);

    // 例外单是核销环节的产物。核销还没开始（草稿 / 待审批 / 已立项 / 筹备中 / 执行中）
    // 就提例外，只会生成一张永远没机会处理的审批单，把审批中心搅浑。
    if (["已结算", "已归档"].includes(p.status)) {
      throw conflict(`项目已「${p.status}」，核销结论已冻结，不可再提交例外单`, "FROZEN", { status: p.status });
    }
    if (!["待核销", "已核销"].includes(p.status)) {
      throw conflict(
        `「${p.status}」阶段还不能提交核销例外单，只有「待核销」「已核销」项目可提交`,
        "ILLEGAL_STATE", { status: p.status }
      );
    }
    const at = now();
    const id = nextId(db, "exceptions", "id", "EX");
    db.prepare("INSERT INTO exceptions (id,pid,step_no,step_label,reason,status,created_by,created_at) VALUES (?,?,?,?,?,?,?,?)")
      .run(id, p.id, no, no === 0 ? label : null, String(reason).trim(), "待审批", ctx.user.name, at);
    const exTitle = no === 0 ? label : `第 ${no} 步`;
    db.prepare(
      "INSERT INTO approvals (id,type,title,pid,ref_id,amount,by_user,sla,status,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)"
    ).run(nextId(db, "approvals", "id", "AP"), "例外单审批", `${id} ${exTitle}：${String(reason).trim().slice(0, 20)}`, p.id, id, 0,
      ctx.user.name, "2 个工作日", "待审批", at);
    logAudit({ user: ctx.user, module: "会后核销", action: "例外单", target: p.id, detail: `${id}（${exTitle}）：${reason}`, ip: ctx.ip });
    return { exceptions: verification(p.id).exceptions, message: `例外单 ${id} 已提交，等待财务审批` };
  });

  /** 例外单审批 */
  router.post("/api/exceptions/:id/decide", async (ctx) => {
    const ex = db.prepare("SELECT * FROM exceptions WHERE id = ?").get(ctx.params.id);
    if (!ex) throw notFound("例外单不存在");
    const p = getProject(ex.pid);
    assertProjectVisible(ctx.user, p);
    assertCan(ctx.user, "verify:exception_approve", "只有财务与核销（或总管理员）可以审批例外单");
    if (ex.status !== "待审批") throw conflict(`例外单已是「${ex.status}」状态，不可重复审批`);
    const { approve, comment } = ctx.body || {};
    if (typeof approve !== "boolean") {
      throw bad("必须明确传入 approve: true（通过）或 approve: false（驳回）", "DECISION_REQUIRED");
    }
    if (String(comment || "").length > 500) throw bad("审批意见不能超过 500 字");
    const at = now();
    const status = approve ? (isDemoMode() ? "已通过" : "待复核") : "已驳回";
    db.prepare("UPDATE exceptions SET status = ?, approved_by = ?, approved_at = ?, comment = ? WHERE id = ?")
      .run(status, ctx.user.name, at, String(comment || ""), ex.id);
    db.prepare("UPDATE approvals SET status = ?, decided_by = ?, decided_at = ?, comment = ? WHERE ref_id = ? AND type = '例外单审批' AND status = '待审批'")
      .run(approve ? "已通过" : "已驳回", ctx.user.name, at, String(comment || ""), ex.id);
    if (approve && isDemoMode()) {
      db.prepare("UPDATE verify_steps SET result = '已解例外', remark = ? , checked_by = ?, checked_at = ? WHERE pid = ? AND step_no = ?")
        .run(`例外获批：${ex.reason}`, ctx.user.name, at, ex.pid, ex.step_no);
    } else {
      db.prepare("UPDATE verify_steps SET result = '不通过', remark = ? WHERE pid = ? AND step_no = ?")
        .run(`例外被驳回：${ex.reason}`, ex.pid, ex.step_no);
    }
    logAudit({
      user: ctx.user, module: "会后核销", action: approve ? "例外通过" : "例外驳回", target: ex.pid,
      detail: `${ex.id} 第 ${ex.step_no} 步：${ex.reason}${comment ? "；意见：" + comment : ""}`, ip: ctx.ip
    });
    return { verification: verification(ex.pid), message: `例外单 ${ex.id} ${status}` };
  });


  /** 例外处理记录：已获审批的例外必须补录处理人、结论、同项目原件后才能重新核销。 */
  router.post("/api/exceptions/:id/resolve", async (ctx) => {
    const ex=db.prepare("SELECT * FROM exceptions WHERE id=?").get(ctx.params.id);
    if(!ex) throw notFound("例外单不存在");
    const p=getProject(ex.pid);
    assertProjectVisible(ctx.user,p);
    assertCan(ctx.user,"verify:exception","当前角色无例外处理权限");
    if (settlementOf(p.id)) throw conflict("财务结算已完成，禁止补改例外记录", "FROZEN");
    if(ex.status!=="待复核") throw conflict("只有审批后待复核例外可填写处理结果","EXCEPTION_NOT_READY");
    const resolution=String(ctx.body?.resolution||"").trim();
    if(resolution.length<4||resolution.length>500)throw bad("处理结果需填写 4～500 字");
    const material=db.prepare("SELECT id FROM materials WHERE id=? AND pid=? AND file_key IS NOT NULL AND deleted_at IS NULL")
      .get(Number(ctx.body?.materialId),p.id);
    if(!material)throw bad("须选择当前项目已上传原件的材料作为整改证据");
    const at=now();
    db.prepare("UPDATE exceptions SET resolution=?,evidence_material_id=?,resolved_by=?,resolved_at=? WHERE id=?")
      .run(resolution,material.id,ctx.user.name,at,ex.id);
    logAudit({user:ctx.user,module:"会后核销",action:"例外处理完成",target:p.id,
      detail:ex.id+"；处理人："+ctx.user.name+"；证据材料："+material.id+"；处理结果："+resolution,ip:ctx.ip});
    return {message:ex.step_no===0?"例外已登记整改，须财务确认闭环":"例外已登记整改，请返回原核销步骤重新复核",
      verification:verification(p.id)};
  });

  /** 只有非步骤类（0）例外由财务复核处理结果后单独闭环；1～7 步须回原步骤复核。 */
  router.post("/api/exceptions/:id/close", async (ctx) => {
    const ex=db.prepare("SELECT * FROM exceptions WHERE id=?").get(ctx.params.id);
    if(!ex)throw notFound("例外单不存在");
    const p=getProject(ex.pid);
    assertProjectVisible(ctx.user,p);
    assertCan(ctx.user,"verify:exception_approve","仅核销审核人可确认整体性例外闭环");
    if(settlementOf(p.id))throw conflict("项目已结算，核销例外已冻结","FROZEN");
    if(Number(ex.step_no)!==0)throw conflict("七步内例外必须返回原步骤复核，不得直接关闭","RECHECK_REQUIRED");
    if(ex.status!=="待复核"||!ex.resolved_at||!ex.evidence_material_id)
      throw conflict("例外处理人未提交证据与处理结果","EXCEPTION_REMEDIATION_REQUIRED");
    const comment=String(ctx.body?.comment||"").trim();
    if(comment.length<4||comment.length>500)throw bad("财务确认意见需填写 4～500 字");
    db.prepare("UPDATE exceptions SET status='已闭环',comment=COALESCE(comment,'')||? WHERE id=?")
      .run("；财务闭环："+comment,ex.id);
    logAudit({user:ctx.user,module:"会后核销",action:"整体性例外闭环",target:p.id,
      detail:ex.id+"；财务审核人："+ctx.user.name+"；审核意见："+comment,ip:ctx.ip});
    return {message:"非步骤例外已完成财务复核并闭环",verification:verification(p.id)};
  });

  /** 材料总览（跨项目） */
  router.get("/api/materials", async (ctx) => {
    // V1.2.17 SEC-02：材料中心按模块白名单，guest 不再能翻全平台材料
    require("../lib/rbac").assertModule(ctx.user, "materials", "material:write");
    const { sql, params } = require("../lib/rbac").scopeFilter(ctx.user);
    const paging = readPaging(ctx.query);

    const base = `FROM materials m JOIN projects p ON p.id = m.pid LEFT JOIN sponsor_rights sr ON sr.id=m.sponsor_right_id LEFT JOIN meeting_sponsor_contracts sc ON sc.id=sr.sponsor_id WHERE ${sql} AND m.deleted_at IS NULL`;
    let rows;
    let total;
    if (paging) {
      total = countOf(db.prepare(`SELECT COUNT(*) AS c ${base}`).get(...params));
      rows = db.prepare(
        `SELECT m.*, p.name AS pname, p.status AS pstatus, p.assoc AS passoc, sr.category AS sponsor_right_category, sc.enterprise AS sponsor_enterprise ${base} ORDER BY m.id DESC LIMIT ? OFFSET ?`
      ).all(...params, paging.size, paging.offset);
    } else {
      rows = db.prepare(`SELECT m.*, p.name AS pname, p.status AS pstatus, p.assoc AS passoc, sr.category AS sponsor_right_category, sc.enterprise AS sponsor_enterprise ${base} ORDER BY m.id DESC`).all(...params);
      total = rows.length;
    }

    // 分页清单不能用于计算项目上传量；单独汇总各项目未删除材料。
    const statsByPid=new Map();
    for(const row of db.prepare(`SELECT m.pid,m.kind,m.file_key ${base}`).all(...params)) {
      if(!statsByPid.has(row.pid))statsByPid.set(row.pid,{kinds:new Set(),count:0,uploadedCount:0});
      const stats=statsByPid.get(row.pid);
      stats.kinds.add(row.kind);
      stats.count++;
      if(row.file_key)stats.uploadedCount++;
    }

    // 已归档项目卷宗封存，不再出现在可登记列表
    const projects = db.prepare(
      `SELECT p.id, p.name, p.status FROM projects p WHERE ${sql} AND p.status IN ('筹备中','执行中','待核销','已核销','已结算') ORDER BY p.date DESC`
    ).all(...params).map((p) => {
      const stats=statsByPid.get(p.id)||{kinds:new Set(),count:0,uploadedCount:0};
      return { ...p, have:[...stats.kinds],required:[],missing:stats.uploadedCount?[]:["至少上传1份材料附件"],
        count:stats.count,uploadedCount:stats.uploadedCount,ok:stats.uploadedCount>0 };
    });

    return {
      rows,
      total,
      page: paging ? paging.page : 1,
      size: paging ? paging.size : total,
      pages: paging ? Math.max(1, Math.ceil(total / paging.size)) : 1,
      paged: !!paging,
      projects,
      kinds: MATERIAL_KINDS
    };
  });

  /** 材料登记（推荐/自定义类别均可；真正上传的附件计入流程门槛） */
  router.post("/api/projects/:id/materials", async (ctx) => {
    const p = getProject(ctx.params.id);
    assertProjectVisible(ctx.user, p);
    assertCan(ctx.user, "material:write", "当前角色无材料登记权限");
    if (p.status === "已归档") throw conflict("项目已归档，材料清单已封存，不可再登记", "ARCHIVED", { status: p.status });
    if (settlementOf(p.id)) throw conflict("结算单已生成，材料证据已冻结，不可追加或修改", "FROZEN");
    const { kind: rawKind, name, version, file_key, file_name, file_size, file_mime, sponsor_right_id } = ctx.body || {};
    // 材料类别全部自选；推荐类目仅供快速选择，不影响推进权限。
    const kind = String(rawKind || "").trim();
    if (!kind) throw bad("请选择或填写材料类别");
    if (kind.length > 20) throw bad(`材料类别不能超过 20 字（当前 ${kind.length} 字）`);
    // 页面开关不能仅在客户端隐藏：停用的固定模块必须在 API 层拒绝继续采集。
    if (MATERIAL_MODULE_KINDS.includes(kind)) {
      const module=db.prepare("SELECT enabled FROM meeting_material_modules WHERE pid=? AND kind=?").get(p.id,kind);
      if (module && module.enabled===0) throw conflict("当前材料模块已停用，不可继续上传；历史资料保留","MODULE_DISABLED");
    }
    // 「终版议程」只由原件上传确认，名称直接使用文件名，版本统一标记「终版」。
    // 不再要求人工输入讲者、课题、生成待办或点击第二次确认。
    const finalAgenda=kind==="终版议程";
    const materialName=finalAgenda
      ? String(file_name || name || "终版议程").trim() : String(name || "").trim();
    if (!materialName) throw bad("请填写材料名称");
    if (materialName.length > 120) throw bad("材料名称不能超过 120 字");

    // 附件 key 必须是本系统签发的格式，否则等于允许把任意字符串写进库
    let fk = null;
    if (file_key) {
      if (!/^[a-f0-9]{32}\.(jpg|png|webp|gif|pdf|ppt|doc|docx|xls|xlsx|pptx|csv|txt)$/.test(String(file_key))) throw bad("附件标识不合法");
      fk = String(file_key);
      assertUploadAttachable(fk, p.id, ctx.user);
    }
    if (finalAgenda && !fk)
      throw bad("终版议程必须上传一份文件，保存即确认，不需要其他操作");
    // “讲者照片”是独立的照片类目，不允许仅填名称标记已收，
    // 也不能将 PPT/Excel 文件伪装成讲者肖像。
    if (kind === "权益照片" && (!fk || !/\.(jpg|png|webp)$/i.test(fk)))
      throw bad("权益照片必须上传 JPG/PNG/WebP 图片并选择来自赞助合同的权益二级类目");
    let sponsorRightId=null;
    if(kind==="权益照片"){
      sponsorRightId=Number(sponsor_right_id);
      if(!Number.isSafeInteger(sponsorRightId)||sponsorRightId<1)
        throw bad("必须选择与当前项目赞助合同对应的权益二级类目");
      const right=db.prepare("SELECT id FROM sponsor_rights WHERE id=? AND pid=?").get(sponsorRightId,p.id);
      if(!right)throw conflict("所选权益二级类目不存在或不属于当前项目","RIGHT_CATEGORY_INVALID");
    }else if(sponsor_right_id!=null && sponsor_right_id!=="")throw bad("只有权益照片可关联赞助权益二级类目");
    if (kind === "讲者照片" && (!fk || !/\.(jpg|png|webp)$/i.test(fk))) {
      throw bad("讲者照片必须上传 JPG、PNG 或 WebP 图片，名称请填写讲者姓名");
    }

    // 上传新的终版议程时，旧的终版原件自动降为历史版（保留证据和原始文件）。
    // 数据更新同事务完成，确保一个项目不会因中途失败出现两个当前终版版本。
    transaction(() => {
      if (finalAgenda)
        db.prepare("UPDATE materials SET version='历史版' WHERE pid=? AND kind='终版议程' AND version='终版' AND deleted_at IS NULL")
          .run(p.id);
      db.prepare(
        `INSERT INTO materials (pid,kind,name,version,uploader,created_at,file_key,file_name,file_size,file_mime,sponsor_right_id)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`
      ).run(
        p.id, kind, materialName, finalAgenda ? "终版" : (version || "v1"), ctx.user.name, now(),
        fk, fk ? String(file_name || "").slice(0, 120) : null,
        fk ? Number(file_size) || null : null, fk ? String(file_mime || "").slice(0, 60) : null,
        sponsorRightId
      );
    });

    logAudit({
      user: ctx.user, module: "材料中心", action: finalAgenda ? "终版议程上传确认" : "上传", target: p.id,
      detail: `${kind}：${materialName}${fk ? "（含附件）" : ""}`, ip: ctx.ip
    });
    return { materialsStatus: materialsStatus(p.id),
      finalAgendaConfirmed: finalAgenda,
      message: finalAgenda ? "终版议程已上传并确认，无需额外操作" : `${kind} 已登记` };
  });

  /** 合同及其他材料原件替换：总管理员按账号授权，来源变化须重核；关联合同台账必须重签。 */
  router.patch("/api/materials/:id/file", async (ctx) => {
    const id=Number(ctx.params.id);
    if(!Number.isSafeInteger(id)||id<1)throw bad("材料编号不合法");
    const m=db.prepare("SELECT * FROM materials WHERE id=?").get(id);
    if(!m || m.deleted_at)throw notFound("材料不存在或已删除");
    const p=getProject(m.pid);
    assertProjectVisible(ctx.user,p);
    assertCan(ctx.user,"material:file:replace","没有合同及材料修改授权，请联系总管理员在用户与权限中开通");
    if(!m.file_key)throw bad("该材料尚未上传原件，请先登记文件");
    if(["已核销","已结算","已归档"].includes(p.status)||settlementOf(p.id))
      throw conflict("项目已核销、结算或归档，合同材料已冻结，不允许替换","FROZEN");
    const body=ctx.body||{}, oldKey=String(m.file_key);
    const expected=String(body.expected_file_key||"");
    if(expected!==oldKey)throw conflict("材料文件已被其他人更新，请刷新页面后重试","MATERIAL_CHANGED");
    const newKey=String(body.file_key||"");
    if(!/^[a-f0-9]{32}\.(jpg|png|webp|gif|pdf|ppt|doc|docx|xls|xlsx|pptx|csv|txt)$/.test(newKey))
      throw bad("请先上传合法的新材料文件");
    if(newKey===oldKey)throw conflict("新旧材料文件相同，请重新上传新文件","SAME_FILE");
    assertUploadAttachable(newKey,p.id,ctx.user);
    const uploaded=await storage().get(newKey);
    if(!uploaded?.buffer?.length)throw notFound("新文件不存在，请重新上传");
    if(uploaded.buffer.length>MAX_BYTES)throw bad("新文件超出50MB限制");
    const mime=sniffMime(uploaded.buffer,newKey);
    if(!mime || ALLOWED_MIME[mime]!==newKey.split(".").pop())
      throw bad("上传文件格式与实际内容不一致");
    if(["讲者照片","权益照片"].includes(m.kind) && !["jpg","png","webp"].includes(newKey.split(".").pop()))
      throw bad("讲者照片和权益照片仅可使用 JPG/PNG/WebP 图片替换");
    const filename=safeName(body.file_name||newKey),fileSize=uploaded.buffer.length;
    const at=now();
    const cleanup=transaction(()=>{
      const current=db.prepare("SELECT file_key,kind,deleted_at FROM materials WHERE id=?").get(id);
      if(!current||current.deleted_at||current.kind!==m.kind||current.file_key!==oldKey)
        throw conflict("原合同材料在上传期间已发生变化，请刷新后重试","MATERIAL_CHANGED");
      if(settlementOf(p.id)||["已核销","已结算","已归档"].includes(getProject(p.id).status))
        throw conflict("项目状态发生变化，合同材料不可替换","FROZEN");
      assertUploadAttachable(newKey,p.id,ctx.user);
      const linked=m.kind==="合同"?db.prepare("SELECT id,status FROM contracts WHERE pid=? AND file_key=?").all(p.id,oldKey):[];
      if(linked.length>1)throw conflict("旧原件关联多个合同，必须由管理员人工处理","SHARED_CONTRACT_FILE");
      db.prepare("UPDATE materials SET file_key=?,file_name=?,file_size=?,file_mime=? WHERE id=?")
        .run(newKey,filename,fileSize,mime,id);
      if(linked.length){
        const contract=linked[0];
        // 替换原件后必须重新提交签署、重新取得审批；旧批准绝不自动继承到新文件。
        db.prepare("UPDATE contracts SET file_key=?,file_name=?,file_size=?,file_mime=?,status='草稿',sign_date=NULL WHERE id=? AND file_key=?")
          .run(newKey,filename,fileSize,mime,contract.id,oldKey);
        db.prepare("UPDATE materials SET version='草稿' WHERE id=?").run(id);
        db.prepare("UPDATE approvals SET status='已撤销',decided_by=?,decided_at=?,comment='合同原件替换，原签署申请失效' WHERE type='合同审批' AND ref_id=? AND status='待审批'")
          .run(ctx.user.name,at,contract.id);
      }
      db.prepare("DELETE FROM material_ocr_results WHERE material_id=?").run(id);
      // 已人工确认的材料比对任务不能把旧原件的通过结论延用至新文件。
      db.prepare("UPDATE meeting_material_tasks SET status='未提交',material_id=NULL,updated_at=?,updated_by=? WHERE material_id=?")
        .run(at,ctx.user.name,id);
      const stepsByKind={
        "会议通知":[1],"招商函":[1],"串场":[1],
        "终版议程":[1,2,4,6],"签到表":[2,3],"讲者照片":[2],
        "课件":[4],"劳务表":[5],"劳务收集表":[5],
        "合同":[5,6],"会务协议":[6],"发票":[6],"会务发票":[6],
        "权益照片":[7]
      };
      const affected=stepsByKind[m.kind]||[];
      // 不在合同签署环节以外隐式继承旧核验：只重置与当前材料关联的步骤。
      if(affected.length){
        const placeholders=affected.map(()=>"?").join(",");
        db.prepare("UPDATE verify_steps SET result='待判定',remark='原始材料已替换，请重新核验', "+
          "evidence_json=NULL,invoice_amount=NULL,checked_by=NULL,checked_at=NULL "+
          "WHERE pid=? AND step_no IN ("+placeholders+") AND result IN ('通过','已解例外')")
          .run(p.id,...affected);
      }
      const refs=db.prepare(
        "SELECT 1 FROM contracts WHERE file_key=? UNION SELECT 1 FROM materials WHERE file_key=? "+
        "UNION SELECT 1 FROM meeting_sponsor_contracts WHERE file_key=? "+
        "UNION SELECT 1 FROM meeting_sponsor_receipts WHERE file_key=? "+
        "UNION SELECT 1 FROM meeting_sponsor_invoices WHERE file_key=? "+
        "UNION SELECT 1 FROM project_notice_templates WHERE file_key=? "+
        "UNION SELECT 1 FROM project_notices WHERE template_key=?"
      ).get(oldKey,oldKey,oldKey,oldKey,oldKey,oldKey,oldKey);
      if(!refs)db.prepare("DELETE FROM uploaded_files WHERE file_key=?").run(oldKey);
      return {linkedContract:linked[0]?.id||null,canDelete:!refs,oldKey,affected:stepsByKind[m.kind]||[]};
    });
    let oldDeleted=false,warning="";
    if(cleanup.canDelete){
      try{
        await storage().del(oldKey);
        oldDeleted=!(await storage().stat(oldKey));
        if(!oldDeleted)warning="新文件已生效，但旧文件存储清理未完成，请管理员检查";
      }catch{warning="新文件已生效，但旧文件物理删除失败，请管理员检查";}
    }else warning="旧文件仍被其他业务记录引用，已安全保留共享文件";
    logAudit({user:ctx.user,module:"材料中心",action:"替换材料文件",target:p.id,
      detail:"材料#"+id+"；"+oldKey+" → "+newKey+
        (cleanup.linkedContract?"；关联台账合同 "+cleanup.linkedContract+" 已退回草稿待重新签署":"")+
        "；相关核销步骤需复核："+(cleanup.affected.join("、")||"无")+"；旧文件清理："+(oldDeleted?"已删除":warning||"保留"),ip:ctx.ip});
    return {replaced:true,oldDeleted,warning,linkedContract:cleanup.linkedContract,
      material:db.prepare("SELECT * FROM materials WHERE id=?").get(id),
      message:cleanup.linkedContract?"材料已替换，关联合同已退回草稿，须重新走签署审批":"材料文件已替换，相关核销步骤须重新确认"};
  });

  router.delete("/api/materials/:id", async (ctx) => {
    const m = db.prepare("SELECT * FROM materials WHERE id = ?").get(Number(ctx.params.id));
    if (!m) throw notFound("材料不存在");
    const p = getProject(m.pid);
    assertProjectVisible(ctx.user, p);
    assertCan(ctx.user, "material:write", "当前角色无材料删除权限");
    if (p.status === "已归档") throw conflict("已归档项目材料不可删除");
    // 结算单一旦生成，材料就是结算与核销的原始凭证，删了等于销毁证据链。
    // 这里用「有没有结算单」判断而不是只看 status：状态可能被人为改过，
    // 但结算单存在与否是硬事实。
    if (settlementOf(p.id)) {
      throw conflict("结算单已生成，材料作为核销凭证已冻结，不可删除", "FROZEN", { status: p.status });
    }

    // 只做软删；原件、版本与审计记录保留，避免销毁历史证据。
    if (m.deleted_at) throw conflict("材料已处于历史冻结状态，不能重复删除", "ALREADY_DELETED");
    db.prepare("UPDATE materials SET deleted_at=?, deleted_by=? WHERE id=?")
      .run(now(),ctx.user.name,m.id);

    logAudit({ user: ctx.user, module: "材料中心", action: "软删冻结", target: p.id, detail: `历史保留 ${m.kind}：${m.name}`, ip: ctx.ip });
    return { materialsStatus: materialsStatus(p.id), message: "已软删并保留历史记录" };
  });

  /** 已生成结算单的四项汇总和四类已付款明细，必须先财务授权再校验项目范围。 */
  router.get("/api/settlements/:id/breakdown", async (ctx) => {
    assertModule(ctx.user,"finance","settle:create");
    const settlement=db.prepare("SELECT * FROM settlements WHERE id=?").get(ctx.params.id);
    if(!settlement)throw notFound("结算单不存在");
    const project=getProject(settlement.pid);
    assertProjectVisible(ctx.user,project);
    const payments=db.prepare("SELECT * FROM payments WHERE pid=? AND status='已付款' ORDER BY paid_at DESC, id DESC").all(project.id);
    return buildSettlementBreakdown(settlement,project,payments);
  });

  router.get("/api/settlements", async (ctx) => {
    // V1.2.17 SEC-02：结算单属于财务模块
    require("../lib/rbac").assertModule(ctx.user, "finance", "settle:create");
    const { sql, params } = require("../lib/rbac").scopeFilter(ctx.user);
    const base = `FROM settlements s JOIN projects p ON p.id = s.pid WHERE ${sql}`;
    const paging = readPaging(ctx.query);
    if (!paging) {
      const rows = db.prepare(`SELECT s.*, p.name, p.assoc, p.status AS pstatus ${base} ORDER BY s.created_at DESC`).all(...params);
      return { rows, total: rows.length };
    }
    const total = countOf(db.prepare(`SELECT COUNT(*) AS c ${base}`).get(...params));
    const rows = db.prepare(
      `SELECT s.*, p.name, p.assoc, p.status AS pstatus ${base} ORDER BY s.created_at DESC LIMIT ? OFFSET ?`
    ).all(...params, paging.size, paging.offset);
    return { rows, total, page: paging.page, size: paging.size, pages: Math.max(1, Math.ceil(total / paging.size)), paged: true };
  });

  return router;
}

module.exports = { register };
