"use strict";
const { db } = require("../lib/db");
const { now, today, nextId, bad, notFound, conflict, forbidden, cents, yuan, parseBankAccount, parseBankName } = require("../lib/util");
const { assertCan, assertModule, assertProjectVisible, scopeFilter, can, isSuper } = require("../lib/rbac");
const { logAudit } = require("../lib/audit");
const { getProject, verification, committed, frozenGate } = require("../lib/workflow");
const { PAYMENT_TYPES, CONTRACT_CATEGORIES, guessContractCategory, isIncomeCategory, EXPENSE_CONTRACT_SQL } = require("../lib/constants");
const { readPaging, countOf } = require("../lib/paginate");
const { transition } = require("../lib/workflow");
const { assertUploadAttachable } = require("../lib/upload-ownership");
const { isDemoMode } = require("../lib/runtime");
const { storage } = require("../lib/storage");
const { extractBankInfo, pdfTextLayer } = require("../lib/bank-extract");

// 只有「已核销」可新增付款：结算后账目已封账，归档后卷宗已封存，均不得再挂账
const PAYABLE_STATUS = ["已核销"];

/**
 * 例外单状态 → 审批单状态。
 * 例外单在别处已经有结论时（改判通过自动撤销、别处已批），审批单要跟着走，
 * 不能继续挂「待审批」—— 否则审批中心会留一条点了报错的幽灵单。
 */
const EX_DECIDED = { 已通过: "已通过", 已驳回: "已驳回", 已撤销: "已撤销" };

/** 与 server/api/files.js 生成的 key 格式保持一致，避免任意字符串被写进 file_key */
const FILE_KEY_RE = /^[a-f0-9]{32}\.(jpg|png|webp|gif|pdf|ppt|pptx|xlsx)$/;

/**
 * 合同状态白名单。
 * 前端录入弹窗只给这三个选项，台账 KPI「已签署金额」也按 "已签署" 精确匹配，
 * 后端不校验的话，任意字符串都能进库 —— 既不进任何统计，也会渲染成未知色标签。
 */
const CONTRACT_STATUS = ["草稿", "待签署", "已签署"];

/** 合同文本字段长度上限，防止超长内容撑爆台账与 CSV 导出 */
const CONTRACT_MAX = { name: 80, vendor: 80, remark: 500, sign_date: 10 };

/** 所有审批必须明确说明同意还是驳回，不允许空请求体隐式批准。 */
function requireDecision(body) {
  if (!body || typeof body.approve !== "boolean") {
    throw bad("必须明确传入 approve: true（通过）或 approve: false（驳回）", "DECISION_REQUIRED");
  }
  return body.approve;
}

/** 校验 YYYY-MM-DD 且必须是真实存在的日期（2026-02-30 这类要拦掉） */
function checkDate(s, label) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) throw bad(`${label}格式应为 YYYY-MM-DD`);
  const d = new Date(`${s}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== s) throw bad(`${label} ${s} 不是有效日期`);
}

/** 已占用预算：待审批 + 已审批 + 已付款（驳回的不占） */
// 实现已上移到 lib/workflow.js —— 改预算与付款申请必须共用同一套口径

function register(router) {
  /* ---------------- 合同 ---------------- */
  router.get("/api/contracts", async (ctx) => {
    // V1.2.17 SEC-02：列表与导出同一套模块口径，不再只靠数据范围兜底
    assertModule(ctx.user, "prep", "contract:write");
    const { sql, params } = scopeFilter(ctx.user);
    const where = [sql];
    const args = [...params];
    if (ctx.query.pid) { where.push("c.pid = ?"); args.push(ctx.query.pid); }
    const whereSql = where.join(" AND ");
    // pstatus / created_by_name 是给「合同详情」弹窗用的：
    // 详情里要显示所属项目状态（决定能不能流转）和录入人（责任追溯）。
    // LEFT JOIN users 不会放大行数（u.id 是主键），COUNT 那条不受影响。
    const base = `FROM contracts c JOIN projects p ON p.id = c.pid LEFT JOIN users u ON u.id = c.created_by WHERE ${whereSql}`;
    const cols = "c.*, p.name AS pname, p.status AS pstatus, u.name AS created_by_name";
    const paging = readPaging(ctx.query);

    if (!paging) {
      const rows = db.prepare(`SELECT ${cols} ${base} ORDER BY c.id DESC`).all(...args);
      return { rows, total: rows.length };
    }
    const total = countOf(db.prepare(`SELECT COUNT(*) AS c ${base}`).get(...args));
    const rows = db.prepare(
      `SELECT ${cols} ${base} ORDER BY c.id DESC LIMIT ? OFFSET ?`
    ).all(...args, paging.size, paging.offset);
    return { rows, total, page: paging.page, size: paging.size, pages: Math.max(1, Math.ceil(total / paging.size)), paged: true };
  });

  router.post("/api/contracts", async (ctx) => {
    const b = ctx.body || {};
    const p = getProject(b.pid);
    assertProjectVisible(ctx.user, p);
    assertCan(ctx.user, "contract:write", "当前角色无合同录入权限");
    // 冻结门禁：归档封存 / 结算封账 —— 属于「历史冻结」，总管理员可例外录入并留痕。
    // 但「核销后金额锁定」不算历史冻结：它是核销口径本身，放行就等于让
    // 「合同总额 = 拟请款总额」这条规则失效，所以谁都不放行，要改先走核销更正。
    frozenGate(ctx, p, p.status === "已归档",
      "项目已归档，合同台账已封存，不可再录入合同", "ARCHIVED", "合同录入");
    frozenGate(ctx, p, p.status === "已结算",
      "项目已结算，合同台账已封账，不可再录入合同", "FROZEN", "合同录入");
    if (!isDemoMode()) {
      if (p.status === "已核销") throw conflict("核销已通过，合同金额已锁定，不得新增合同", "CONTRACT_VERIFIED");
      const verifiedInvoice = db.prepare("SELECT 1 FROM verify_steps WHERE pid=? AND step_no=6 AND result='通过'").get(p.id);
      if (verifiedInvoice) throw conflict("发票与合同金额已核对，须先处理核销更正，不得新增合同", "CONTRACT_VERIFIED");
    }
    if (!String(b.name || "").trim()) throw bad("合同名称为必填项");
    if (String(b.name).length > CONTRACT_MAX.name) throw bad(`合同名称不能超过 ${CONTRACT_MAX.name} 字`);
    if (!String(b.vendor || "").trim()) throw bad("签约方为必填项");
    if (String(b.vendor).length > CONTRACT_MAX.vendor) throw bad(`签约方不能超过 ${CONTRACT_MAX.vendor} 字`);
    const amount = Number(b.amount);
    if (!Number.isFinite(amount) || !(amount > 0)) throw bad("合同金额必须大于 0");
    if (amount > 1e9) throw bad("合同金额不能超过 10 亿元");
    if (Number(amount.toFixed(2)) !== amount) throw bad("合同金额最多保留两位小数");

    // 状态必须是白名单内的值，否则「已签署金额」KPI 会漏算，badge 也会渲染成未知态
    const requestedStatus = String(b.status || "草稿").trim();
    if (!CONTRACT_STATUS.includes(requestedStatus)) throw bad(`合同状态必须是：${CONTRACT_STATUS.join(" / ")}`);
    // The "signed" option is a signing request, NEVER proof of approval on creation.
    const st = !isDemoMode() && requestedStatus === "已签署" ? "待签署" : requestedStatus;

    // 签署日期可以为空（草稿尚未签），一旦填了就必须是合法日期
    const signDate = String(b.sign_date || "").trim();
    if (signDate) checkDate(signDate, "签署日期");
    // 「已签署」却拿不出签署日期，是台账里最常见的脏数据：核销第 6 步要拿签署日期对发票，
    // 到时候只能靠人回忆。宁可这里拒掉，让人补一个日期。
    if (st === "已签署" && !signDate) throw bad("状态为「已签署」时必须填写签署日期（不确定可先存为「待签署」）");

    const remark = String(b.remark || "");
    if (remark.length > CONTRACT_MAX.remark) throw bad(`备注不能超过 ${CONTRACT_MAX.remark} 字`);

    // 合同类别：决定核销第 5 步「劳务与专家费核对」列出哪几份。
    // 不强制选 —— 填表时硬猜类别只会逼人随便选一个；没选就按名称推断，之后可在台账改。
    let category = String(b.category || "").trim();
    if (category && !CONTRACT_CATEGORIES.includes(category)) {
      throw bad(`合同类别必须是：${CONTRACT_CATEGORIES.join(" / ")}`);
    }
    if (!category) category = guessContractCategory(b.name);

    // 合同原件（扫描件 PDF / 拍照件）：只接受上传接口发下来的 key 格式，
    // 防止把任意字符串写进 file_key 后拼到下载 URL 上。
    let fk = null, fname = null, fsize = null, fmime = null;
    if (b.file_key) {
      if (!FILE_KEY_RE.test(String(b.file_key))) throw bad("附件标识不合法");
      fk = String(b.file_key);
      assertUploadAttachable(fk, p.id, ctx.user);
      fname = String(b.file_name || "").slice(0, 120) || fk;
      fsize = Number(b.file_size) || null;
      fmime = String(b.file_mime || "").slice(0, 60) || null;
    }

    /**
     * 合同收款账户（可选）：录了以后，付款申请选这份合同时能直接带出
     * 收款方 / 开户行 / 账号 / 金额，财务不用回头问人。
     * 账号与劳务表一样加密存储，明文只在服务端内存里出现。
     */
    const payeeBank = String(b.payee_bank || "").trim();
    if (payeeBank.length > 60) throw bad("开户行不能超过 60 字");
    const rawAccount = String(b.payee_account || "").replace(/\s/g, "");
    let accountCipher = null;
    if (rawAccount) {
      if (!/^\d{10,25}$/.test(rawAccount)) throw bad("银行账号应为 10~25 位数字");
      const vp = require("../lib/verified-payees");
      if (!vp.keyAvailable()) throw bad("未配置财务加密密钥，暂不能保存银行账号");
      accountCipher = vp.sealAccount(rawAccount);
    }

    const id = nextId(db, "contracts", "id", "HT");
    db.prepare("INSERT INTO contracts (id,pid,name,vendor,amount,sign_date,status,category,remark,created_by,created_at,file_key,file_name,file_size,file_mime,payee_bank,payee_account_cipher) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
      .run(id, p.id, b.name, b.vendor, amount, isDemoMode() ? signDate : "", st, category, remark, ctx.user.id, now(), fk, fname, fsize, fmime, payeeBank || null, accountCipher);
    /**
     * 收入类（赞助）合同不往材料中心同步。
     * 「合同」是归档必备的 8 类之一，它指的是**支出**合同原件；
     * 赞助协议塞进这一类，归档齐备度会凭空变成「已齐」，
     * 核销第 6 步的关联材料里也会冒出一份不该参与核销的协议。
     * 赞助合同的原件在会议收入模块里单独归档，那里才是它的去处。
     */
    if(fk && !isIncomeCategory(category)) {
      // 将合同台账原件同步登记到本项目的归档“合同”类，不需要上传第二遍。
      // 关联同一上传 key 只是内部同步，不开放客户端重复挂载别的单据。
      db.prepare(`INSERT INTO materials(pid,kind,name,version,uploader,created_at,file_key,file_name,file_size,file_mime)
        VALUES (?,?,?,?,?,?,?,?,?,?)`)
        .run(p.id,"合同",id+" · "+b.name,st,ctx.user.name,now(),fk,fname,fsize,fmime);
    }
    if (!isDemoMode() && st === "待签署") {
      const apId = nextId(db, "approvals", "id", "AP");
      db.prepare("INSERT INTO approvals (id,type,title,pid,ref_id,amount,by_user,sla,status,created_at,submitted_by_id) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
        .run(apId, "合同审批", "合同签署：" + b.name, p.id, id, amount, ctx.user.name, "2 个工作日", "待审批", now(), ctx.user.id);
    }
    logAudit({
      user: ctx.user, module: "筹备管理", action: "合同录入", target: p.id,
      detail: `${id} ${b.name} / ${b.vendor} / ${category} / ¥${amount.toLocaleString("zh-CN")}${fk ? "（含原件）" : ""}`, ip: ctx.ip
    });

    // 合同总额超预算是要预警的业务事实（不是错误，可能确需超支）。
    // 硬拦会让人没法录真实合同，所以只回一个 warning 让前端提示，不阻断。
    // 收入类（赞助）合同不占支出预算，算进去会凭空把「超预算」预警打出来。
    const contractSum = Number(db.prepare(
      "SELECT COALESCE(SUM(amount),0) AS s FROM contracts WHERE pid = ? AND " + EXPENSE_CONTRACT_SQL
    ).get(p.id).s) || 0;
    const budget = Number(p.budget) || 0;
    let warning = "";
    if (budget > 0 && contractSum > budget) {
      warning = `合同总额 ¥${contractSum.toLocaleString("zh-CN")} 已超项目预算 ¥${budget.toLocaleString("zh-CN")} ` +
        `¥${(contractSum - budget).toLocaleString("zh-CN")}，请确认是否需要走变更审批`;
    }

    return {
      contract: db.prepare("SELECT * FROM contracts WHERE id = ?").get(id),
      message: `合同 ${id} 已保存${!isDemoMode() && st === "待签署" ? "并提交协会管理员或总管理员审批签署" : ""}`,
      warning
    };
  });

  /**
   * 合同状态流转：草稿 → 待签署 → 已签署。
   *
   * 老板 2026-10-27 拍板要「提交签署 → 确认签署」两步。原来状态只能录入时选一次，
   * 之后再也改不了 —— 合同签没签只能靠人记，台账上的「已签署金额」也就没法信。
   *
   * 两步分给两个权限：
   *   提交签署 contract:write（协会 / 执行，录入人自己提交）
   *   确认签署 contract:approve（协会管理员，代表协会落章）
   * 这样「谁提交的、谁确认的」在审计里分得清，也符合合同的实际流程。
   */
  const CONTRACT_FLOW = [
    { from: "草稿", action: "submit", to: "待签署", label: "提交签署", perm: "contract:write" },
    { from: "待签署", action: "sign", to: "已签署", label: "确认签署", perm: "contract:approve" },
    { from: "待签署", action: "reject", to: "草稿", label: "驳回签署", perm: "contract:approve" }
  ];

  router.post("/api/contracts/:id/transition", async (ctx) => {
    const c = db.prepare("SELECT * FROM contracts WHERE id = ?").get(ctx.params.id);
    if (!c) throw notFound("合同不存在");
    const p = getProject(c.pid);
    assertProjectVisible(ctx.user, p);
    frozenGate(ctx, p, ["已结算", "已归档"].includes(p.status),
      `项目已「${p.status}」，合同台账已封存，不可再流转状态`, "FROZEN", "合同状态流转");
    if (!isDemoMode() && (p.status === "已核销" ||
        db.prepare("SELECT 1 FROM verify_steps WHERE pid=? AND step_no=6 AND result='通过'").get(p.id))) {
      // 核销后锁定是核销口径，不是历史冻结：总管理员也不放行
      throw conflict("合同已完成核票或核销，签署状态已锁定", "CONTRACT_VERIFIED");
    }

    const action = String(ctx.body?.action || "").trim();
    const flow = CONTRACT_FLOW.find((f) => f.from === c.status && f.action === action);
    if (!flow) {
      const allowed = CONTRACT_FLOW.filter((f) => f.from === c.status).map((f) => f.action);
      throw conflict(
        allowed.length
          ? `合同 ${c.id} 当前是「${c.status}」，不能执行该操作；可执行：${CONTRACT_FLOW.filter((f) => f.from === c.status).map((f) => f.label).join(" / ")}`
          : `合同 ${c.id} 已是「${c.status}」，没有可继续的流转`,
        "ILLEGAL_TRANSITION", { status: c.status, allowed }
      );
    }
    assertCan(ctx.user, flow.perm, `需要「${flow.perm === "contract:approve" ? "协会管理员" : "合同录入"}」权限才能${flow.label}`);

    if (!isDemoMode() && action === "sign") {
      const approval = db.prepare("SELECT id,submitted_by_id FROM approvals WHERE type='合同审批' AND ref_id=? AND status='待审批' ORDER BY created_at DESC LIMIT 1").get(c.id);
      if (!approval) throw conflict("合同尚未提交有效签署审批，不能直接确认", "SIGN_APPROVAL_REQUIRED");
      if (!isSuper(ctx.user) && Number(c.created_by) === Number(ctx.user.id))
        throw conflict("合同录入人与签署审批人须分离；请交由其他协会管理员或总管理员", "NEED_SECOND_PERSON");
    }
    if(action==="reject"){
      const reason=String(ctx.body?.reason||"").trim();
      if(reason.length<4 || reason.length>500)throw bad("合同驳回理由需填写 4～500 字");
      const pending=db.prepare("SELECT id FROM approvals WHERE type='合同审批' AND ref_id=? AND status='待审批' ORDER BY created_at DESC LIMIT 1").get(c.id);
      if(!isDemoMode()&&!pending)throw conflict("没有待审批的合同签署申请","SIGN_APPROVAL_REQUIRED");
      db.prepare("UPDATE contracts SET status='草稿' WHERE id=?").run(c.id);
      db.prepare("UPDATE approvals SET status='已驳回',decided_by=?,decided_at=?,comment=? WHERE type='合同审批' AND ref_id=? AND status='待审批'")
        .run(ctx.user.name,now(),reason,c.id);
      logAudit({user:ctx.user,module:"合同审批",action:"驳回合同签署",target:p.id,
        detail:c.id+"；原因："+reason,ip:ctx.ip});
      return {contract:db.prepare("SELECT * FROM contracts WHERE id=?").get(c.id),
        message:"合同已驳回并退回草稿，可修改后重新提交"};
    }
    // 确认签署时补签署日期（默认今天），这样台账上的日期一定来自「确认」这个动作
    let signDate = null;
    if (action === "sign") {
      signDate = String(ctx.body?.sign_date || today()).trim();
      checkDate(signDate, "签署日期");
    }

    db.prepare("UPDATE contracts SET status = ?, sign_date = COALESCE(?, sign_date) WHERE id = ?")
      .run(flow.to, signDate, c.id);
    if (!isDemoMode()) {
      if (action === "submit") {
        const duplicate = db.prepare("SELECT id FROM approvals WHERE type='合同审批' AND ref_id=? AND status='待审批'").get(c.id);
        if (!duplicate) db.prepare("INSERT INTO approvals (id,type,title,pid,ref_id,amount,by_user,sla,status,created_at,submitted_by_id) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
          .run(nextId(db,"approvals","id","AP"),"合同审批","合同签署："+c.name,p.id,c.id,c.amount,ctx.user.name,"2 个工作日","待审批",now(),ctx.user.id);
      } else if (action === "sign") {
        db.prepare("UPDATE approvals SET status='已通过',decided_by=?,decided_at=?,comment=? WHERE type='合同审批' AND ref_id=? AND status='待审批'")
          .run(ctx.user.name,now(),"合同签署已确认",c.id);
      }
    }
    logAudit({
      user: ctx.user, module: "筹备管理", action: flow.label, target: p.id,
      detail: `${c.id} ${c.name}：${c.status} → ${flow.to}${signDate ? `（签署日期 ${signDate}）` : ""}`, ip: ctx.ip
    });
    return {
      contract: db.prepare("SELECT * FROM contracts WHERE id = ?").get(c.id),
      message: `合同 ${c.id} ${flow.label}成功，状态 → ${flow.to}`
    };
  });

  /**
   * 合同台账编辑。
   *
   * 之前台账只能新增、不能改 —— 类别录错（把赞助协议选成「其他」）、
   * 金额敲错、签约方写错，都没有任何补救入口，只能删库或者放着不管。
   * 老板 2026-11-02 要求「收入类合同不关联到材料和核销」，
   * 这条规则要能落地，就必须允许把存量合同改成「赞助收入」。
   *
   * 改动类别时同步处理归档材料：
   *   改为收入类 → 撤掉当初自动同步的「合同」材料（它是支出合同原件，不该被赞助顶替）
   *   改回支出类 → 有原件就把「合同」材料补回来
   */
  router.patch("/api/contracts/:id", async (ctx) => {
    const c = db.prepare("SELECT * FROM contracts WHERE id = ?").get(ctx.params.id);
    if (!c) throw notFound("合同不存在");
    const p = getProject(c.pid);
    assertProjectVisible(ctx.user, p);
    assertCan(ctx.user, "contract:write", "当前角色无合同编辑权限");
    frozenGate(ctx, p, ["已结算", "已归档"].includes(p.status),
      `项目已「${p.status}」，合同台账已封存，不可修改`, "FROZEN", "合同编辑");

    const b = ctx.body || {};
    /**
     * 核销后的锁定分三层：
     *   · 类别 —— 「这份合同算不算支出」的分类标签。存量里把赞助协议记成「其他」的必须能改回来，
     *     否则「收入类合同不参与核销」这条规则对老数据永远无效。改完留痕即可。
     *   · 金额 / 名称 / 签约方 / 签署日期 —— 动了会让「合同总额 = 拟请款总额」失真。
     *     非总管理员一律拦；总管理员可以改（纠错兜底），但改完必须把第 6 步退回重判，
     *     项目也跟着退回「待核销」—— 否则会留下「已核销但口径已经变了」的静默错误。
     *   · 已结算 / 已归档 —— 走上面的 frozenGate，总管理员放行但留痕。
     */
    const locked = !isDemoMode() && (p.status === "已核销" ||
      !!db.prepare("SELECT 1 FROM verify_steps WHERE pid=? AND step_no=6 AND result='通过'").get(p.id));
    const moneyTouched = ["name", "vendor", "amount", "sign_date"].filter((k) => k in b &&
      String(b[k] ?? "") !== String(c[k] ?? ""));
    if (locked && moneyTouched.length && !isSuper(ctx.user)) {
      throw conflict(
        `合同已完成核票或核销，${moneyTouched.join("、")} 已锁定；如确需更正请由总管理员操作（类别可以单独调整）`,
        "CONTRACT_VERIFIED", { fields: moneyTouched }
      );
    }

    const next = { ...c };
    if ("name" in b) {
      const v = String(b.name || "").trim();
      if (!v) throw bad("合同名称为必填项");
      if (v.length > CONTRACT_MAX.name) throw bad(`合同名称不能超过 ${CONTRACT_MAX.name} 字`);
      next.name = v;
    }
    if ("vendor" in b) {
      const v = String(b.vendor || "").trim();
      if (!v) throw bad("签约方为必填项");
      if (v.length > CONTRACT_MAX.vendor) throw bad(`签约方不能超过 ${CONTRACT_MAX.vendor} 字`);
      next.vendor = v;
    }
    if ("amount" in b) {
      const v = Number(b.amount);
      if (!Number.isFinite(v) || !(v > 0)) throw bad("合同金额必须大于 0");
      if (v > 1e9) throw bad("合同金额不能超过 10 亿元");
      if (Number(v.toFixed(2)) !== v) throw bad("合同金额最多保留两位小数");
      next.amount = v;
    }
    if ("category" in b) {
      const v = String(b.category || "").trim();
      if (v && !CONTRACT_CATEGORIES.includes(v)) throw bad(`合同类别必须是：${CONTRACT_CATEGORIES.join(" / ")}`);
      next.category = v || guessContractCategory(next.name);
    }
    if ("sign_date" in b) {
      const v = String(b.sign_date || "").trim();
      if (v) checkDate(v, "签署日期");
      next.sign_date = v;
    }
    if ("remark" in b) {
      const v = String(b.remark || "");
      if (v.length > CONTRACT_MAX.remark) throw bad(`备注不能超过 ${CONTRACT_MAX.remark} 字`);
      next.remark = v;
    }

    db.prepare("UPDATE contracts SET name=?, vendor=?, amount=?, category=?, sign_date=?, remark=? WHERE id=?")
      .run(next.name, next.vendor, next.amount, next.category, next.sign_date, next.remark, c.id);

    const wasIncome = isIncomeCategory(c.category);
    const nowIncome = isIncomeCategory(next.category);
    let materialNote = "";
    if (!wasIncome && nowIncome) {
      // 撤掉自动同步的那条材料，只认「合同号 · 名称」这个固定格式，不误删人工登记的同名材料
      const removed = db.prepare(
        "DELETE FROM materials WHERE pid=? AND kind='合同' AND name=? AND deleted_at IS NULL"
      ).run(p.id, c.id + " · " + c.name);
      if (removed.changes) materialNote = `；已撤下归档「合同」类里的同名材料 ${removed.changes} 条`;
    } else if (wasIncome && !nowIncome && c.file_key) {
      const exists = db.prepare(
        "SELECT 1 FROM materials WHERE pid=? AND kind='合同' AND file_key=? AND deleted_at IS NULL"
      ).get(p.id, c.file_key);
      if (!exists) {
        db.prepare(`INSERT INTO materials(pid,kind,name,version,uploader,created_at,file_key,file_name,file_size,file_mime)
          VALUES (?,?,?,?,?,?,?,?,?,?)`)
          .run(p.id, "合同", c.id + " · " + next.name, c.status, ctx.user.name, now(),
            c.file_key, c.file_name, c.file_size, c.file_mime);
        materialNote = "；已把原件重新登记到归档「合同」类";
      }
    }

    const categoryChanged = String(c.category || "") !== String(next.category || "");

    /**
     * 总管理员在核销后动了「会改变合同总额」的字段 → 第 6 步的口径已经变了，旧结论必须作废。
     * 会改变总额的只有两种：金额本身，以及类别在「支出 / 收入」之间翻转。
     * 这里不弹确认、不留旧值，直接把第 6 步退回「待判定」，并把项目从「已核销」
     * 退回「待核销」—— 已核销但核销口径已经变了，比退回去更危险。
     */
    const affectsTotal = moneyTouched.includes("amount") || wasIncome !== nowIncome;
    let reopenNote = "";
    if (locked && affectsTotal && isSuper(ctx.user)) {
      const why = moneyTouched.includes("amount")
        ? `合同 ${c.id} 的金额由总管理员更正为 ¥${next.amount}`
        : `合同 ${c.id} 的类别由「${c.category || "未分类"}」改为「${next.category || "未分类"}」`;
      const hit = db.prepare(
        "UPDATE verify_steps SET result='待判定', remark=?, checked_by=NULL, checked_at=NULL, " +
        "evidence_json=NULL, invoice_amount=NULL WHERE pid=? AND step_no=6 AND result<>'待判定'"
      ).run(`${why}，合同总额已变，须重新判定`, p.id);
      if (hit.changes) {
        if (p.status === "已核销") {
          const at = now();
          db.prepare("UPDATE projects SET status='待核销', status_at=?, updated_at=? WHERE id=?").run(at, at, p.id);
          reopenNote = "；核销第 6 步已退回待判定，项目状态回到「待核销」";
        } else {
          reopenNote = "；核销第 6 步已退回待判定";
        }
        logAudit({
          user: ctx.user, module: "会后核销", action: "核销结论作废重判", target: p.id,
          detail: `${why}，第 6 步退回待判定${p.status === "已核销" ? "，项目状态 已核销 → 待核销" : ""}`,
          ip: ctx.ip
        });
      }
    }

    if (locked && categoryChanged) {
      // 核销后改类别会重算合同总额，必须单独留一条，别混在普通编辑里
      logAudit({
        user: ctx.user, module: "系统配置", action: "核销后合同类别更正", target: p.id,
        detail: `${c.id}：${c.category || "—"} → ${next.category || "—"}；该项目的核销第 6 步合同总额口径随之变化，需判定人复核`,
        ip: ctx.ip
      });
    }
    logAudit({
      user: ctx.user, module: "筹备管理", action: "合同编辑", target: p.id,
      detail: `${c.id}：类别 ${c.category || "—"} → ${next.category || "—"}；金额 ${c.amount} → ${next.amount}${materialNote}`,
      ip: ctx.ip
    });
    return {
      contract: db.prepare("SELECT * FROM contracts WHERE id = ?").get(c.id),
      message: `合同 ${c.id} 已更新${materialNote}${reopenNote}`
    };
  });

  /* ---------------- 付款 ---------------- */
  router.get("/api/payments", async (ctx) => {
    // 会务执行没有「财务结算」模块，但能提付款申请 —— 动作权限要放行
    assertModule(ctx.user, "finance", "payment:create");
    const { sql, params } = scopeFilter(ctx.user);
    const where = [sql];
    const args = [...params];
    if (ctx.query.status) { where.push("y.status = ?"); args.push(ctx.query.status); }
    if (ctx.query.pid) { where.push("y.pid = ?"); args.push(ctx.query.pid); }
    const whereSql = where.join(" AND ");
    const base = `FROM payments y JOIN projects p ON p.id = y.pid WHERE ${whereSql}`;
    const paging = readPaging(ctx.query);

    let rows;
    let total;
    if (paging) {
      total = countOf(db.prepare(`SELECT COUNT(*) AS c ${base}`).get(...args));
      rows = db.prepare(
        `SELECT y.*, p.name AS pname, p.status AS pstatus ${base} ORDER BY y.created_at DESC, y.id DESC LIMIT ? OFFSET ?`
      ).all(...args, paging.size, paging.offset);
    } else {
      rows = db.prepare(
        `SELECT y.*, p.name AS pname, p.status AS pstatus ${base} ORDER BY y.created_at DESC, y.id DESC`
      ).all(...args);
      total = rows.length;
    }

    // 汇总必须独立聚合：拿当前页的 rows 去 reduce，分页后金额就只剩一页的数
    // 金额一律 ROUND(...,2)，否则合计会带 3580.2300000000005 这种浮点尾巴
    const agg = db.prepare(
      `SELECT COUNT(*) AS n,
              COALESCE(ROUND(SUM(y.amount),2),0) AS s,
              COALESCE(SUM(CASE WHEN y.status = '待审批' THEN 1 ELSE 0 END),0) AS n_pending,
              COALESCE(SUM(CASE WHEN y.status = '已审批' THEN 1 ELSE 0 END),0) AS n_approved,
              COALESCE(SUM(CASE WHEN y.status = '已付款' THEN 1 ELSE 0 END),0) AS n_paid,
              COALESCE(ROUND(SUM(CASE WHEN y.status = '待审批' THEN y.amount ELSE 0 END),2),0) AS a_pending,
              COALESCE(ROUND(SUM(CASE WHEN y.status = '已审批' THEN y.amount ELSE 0 END),2),0) AS a_approved,
              COALESCE(ROUND(SUM(CASE WHEN y.status = '已付款' THEN y.amount ELSE 0 END),2),0) AS a_paid
       ${base}`
    ).get(...args);

    return {
      rows,
      total,
      page: paging ? paging.page : 1,
      size: paging ? paging.size : total,
      pages: paging ? Math.max(1, Math.ceil(total / paging.size)) : 1,
      paged: !!paging,
      summary: {
        total: Number(agg.n) || 0,
        amount: Number(agg.s) || 0,
        pending: Number(agg.n_pending) || 0,
        approved: Number(agg.n_approved) || 0,
        paid: Number(agg.n_paid) || 0,
        pendingAmount: Number(agg.a_pending) || 0,
        approvedAmount: Number(agg.a_approved) || 0,
        paidAmount: Number(agg.a_paid) || 0
      }
    };
  });

  /**
   * 从合同原件里识别收款账户。
   *
   * 合同正文本来就写着开户行和账号，但录入的人不会顺手再抄进台账，
   * 于是付款时财务只能翻 PDF。这里按项目批量识别：先读 PDF 文本层（快），
   * 扫描件再退回 OCR；识别到就加密写进 contracts.payee_bank / payee_account_cipher。
   * 只处理还没有账号的已签署合同，重复调用不会覆盖人工填过的值。
   */
  router.post("/api/projects/:id/contracts/bank-extract", async (ctx) => {
    const p = getProject(ctx.params.id);
    assertProjectVisible(ctx.user, p);
    if (!can(ctx.user, "contract:write") && !can(ctx.user, "payment:pay") && !isSuper(ctx.user))
      throw forbidden("需要合同录入或财务付款权限");

    const rows = db.prepare(
      `SELECT * FROM contracts WHERE pid=? AND status='已签署' AND file_key IS NOT NULL
        AND (payee_account_cipher IS NULL OR payee_account_cipher='') AND ` + EXPENSE_CONTRACT_SQL + ` ORDER BY id`
    ).all(p.id).slice(0, 12);

    const results = [];
    for (const c of rows) {
      try {
        const f = await storage().get(c.file_key);
        if (!f) { results.push({ id: c.id, error: "原件已不存在" }); continue; }
        const ext = c.file_key.split(".").pop();
        let text = ext === "pdf" ? await pdfTextLayer(f.buffer) : "";

        if (String(text).trim().length < 40) {
          const ocr = require("../lib/ocr-engine");
          if (!ocr.enabled()) { results.push({ id: c.id, error: "扫描件需要 OCR，服务器未启用" }); continue; }
          let buf = f.buffer, e2 = ext;
          if (["docx", "xlsx", "pptx"].includes(ext)) {
            const { toPdf, hasLibreOffice } = require("../lib/office-preview");
            if (!(await hasLibreOffice())) { results.push({ id: c.id, error: "Office 原件需要 LibreOffice" }); continue; }
            buf = await toPdf(buf, ext, c.file_key.replace(/\.[^.]+$/, ""));
            e2 = "pdf";
          }
          text = (await ocr.recognize(buf, e2)).text;
        }

        const { bank, account } = extractBankInfo(text);
        if (!bank && !account) { results.push({ id: c.id, vendor: c.vendor, error: "合同里没有找到开户行或账号" }); continue; }

        let cipher = c.payee_account_cipher;
        if (account) {
          const vp = require("../lib/verified-payees");
          if (!vp.keyAvailable()) { results.push({ id: c.id, vendor: c.vendor, error: "未配置财务加密密钥，账号无法保存" }); continue; }
          cipher = vp.sealAccount(account);
        }
        db.prepare("UPDATE contracts SET payee_bank=?, payee_account_cipher=? WHERE id=?")
          .run(bank || c.payee_bank || null, cipher, c.id);
        results.push({ id: c.id, vendor: c.vendor, bank: bank || "",
          accountMasked: account ? "尾号 " + account.slice(-4) : "" });
      } catch (e) {
        results.push({ id: c.id, vendor: c.vendor, error: e.message || "识别失败" });
      }
    }

    const ok = results.filter((r) => !r.error).length;
    logAudit({ user: ctx.user, module: "财务结算", action: "识别合同收款账户",
      target: p.id, detail: `扫描 ${rows.length} 份，识别成功 ${ok} 份`, ip: ctx.ip });
    return { project: p.id, scanned: rows.length, updated: ok, results };
  });

  router.get("/api/projects/:id/payee-options", async ctx => {
    const p=getProject(ctx.params.id);assertProjectVisible(ctx.user,p);
    assertCan(ctx.user,"payment:create","无权查看收款人信息");
    return {rows:require("../lib/verified-payees").options(p.id),
      note:"候选来自已签署合同与第五步已核验劳务资料，敏感银行账号只显示尾号"};
  });

  /** 付款申请 —— 核销是唯一前置门 */
  router.post("/api/payments", async (ctx) => {
    const b = ctx.body || {};
    const p = getProject(b.pid);
    assertProjectVisible(ctx.user, p);
    assertCan(ctx.user, "payment:create", "当前角色无付款申请权限");
    /**
     * V1.2.23 NEW-01：门禁先于字段校验。
     *
     * 回归测试实测：给「执行中」或「已结算」项目提交付款时，返回的是
     * 400「开户行为必填项」，而不是 409 VERIFY_GATE / SETTLED —— 用户会以为
     * 「把账户信息填完就能付」，填完却照样被拦，白白多走一步。
     *
     * 门禁是制度结论，字段完整性是表单问题。顺序必须反过来：
     * 先告诉用户「这个项目现在不能付款」，再谈表单缺什么。
     * 权限（上面）与数据范围（上面）仍在最前，不存在绕过。
     */
    frozenGate(ctx, p, p.status === "已归档",
      "项目已归档，数字卷宗已封存，不可再新增付款", "ARCHIVED", "付款申请");
    frozenGate(ctx, p, p.status === "已结算",
      "项目已生成结算单，账目已封账，不可再新增付款（如需补付请走线下流程并说明）", "SETTLED", "付款申请");
    if (!PAYABLE_STATUS.includes(p.status)) {
      throw conflict(
        `付款被拦截：项目「${p.name}」当前状态为「${p.status}」，按制度必须先完成 6 步核销并通过（已核销）才可付款`,
        "VERIFY_GATE",
        { status: p.status, verify: verification(p.id).judged + "/6" }
      );
    }
    if (!PAYMENT_TYPES.includes(b.type)) throw bad(`付款类型必须是：${PAYMENT_TYPES.join(" / ")}`);
    const choice=b.payee_option_id ? require("../lib/verified-payees").resolve(p.id,b.payee_option_id) : null;
    if(!choice && !isDemoMode() && process.env.ERP_REQUIRE_VERIFIED_PAYEES==="1")
      throw bad("必须从核销确认的劳务记录或已签署合同中选择收款方");
    const payee=choice?choice.name:String(b.payee||"").trim();
    if(!payee)throw bad("收款方为必填项");
    if(payee.length>60)throw bad("收款方不能超过 60 字");
    if(choice && b.payee && String(b.payee).trim()!==choice.name)throw bad("收款方与选定的核销资料不一致");
    const payeeBank=parseBankName(choice?.bank || b.payee_bank);
    const payeeAccount=parseBankAccount(choice?.account || b.payee_account);
    // 发票属于核销材料，不是付款单字段；专家费个人报销不存在发票号。
    const invoiceNo=String(b.invoice_no||"").trim(); // Legacy API remains readable/deduplicated; new UI omits this field.
    if(invoiceNo.length>40)throw bad("发票号不能超过 40 字");
    if (!isDemoMode()) {
      // 第 6 步不再记录发票金额（该规则已去掉），改为要求「会务三单核验已通过且留有依据」
      const checked=db.prepare("SELECT result, evidence_json FROM verify_steps WHERE pid=? AND step_no=6 AND result='通过'").get(p.id);
      if(!checked || !checked.evidence_json)
        throw conflict("必须先完成会务三单核验（第 6 步）再请款","INVOICE_CHECK_REQUIRED");
      // 可请款上限 = 支出类已签合同总额；收入类（赞助）合同不算可请款额度
      const signed=db.prepare(
        "SELECT COALESCE(SUM(amount),0) AS total FROM contracts WHERE pid=? AND status='已签署' AND " + EXPENSE_CONTRACT_SQL
      ).get(p.id);
      const allocated=db.prepare("SELECT COALESCE(SUM(amount),0) AS total FROM payments WHERE pid=? AND status IN ('待审批','已审批','已付款')").get(p.id);
      const requested=Number(b.amount);
      if(Number.isFinite(requested) && cents(allocated.total)+cents(requested)>cents(signed.total))
        throw conflict("累计请款总额不得超过核销确认的已签署合同总额","CONTRACT_AMOUNT_EXCEEDED");
      if(choice?.source==="labor" && cents(requested)>cents(choice.amount))
        throw conflict("本笔专家费不得超过已核验的个人劳务金额","LABOR_AMOUNT_EXCEEDED");
    }
    const remark = String(b.remark || "");
    if (remark.length > 300) throw bad("付款说明不能超过 300 字");
    const amount = Number(b.amount);
    if (!Number.isFinite(amount) || !(amount > 0)) throw bad("付款金额必须大于 0");
    if (amount > 1e9) throw bad("单笔付款金额不能超过 10 亿元");
    if (Number(amount.toFixed(2)) !== amount) throw bad("付款金额最多保留两位小数（精确到分）");
    // 超预算硬门禁：总管理员可显式 force 特批
    // 比较走「分」，否则 2789.69 + 2600.09 = 5389.780000000001 > 预算 5389.78，
    // 明明正好用尽却报「超预算 ¥0.0000000000000009」。
    const used = committed(p.id);
    const budget = yuan(p.budget);
    const force = !!b.force && isSuper(ctx.user);
    const overCents = cents(used) + cents(amount) - cents(budget);
    if (!force && overCents > 0) {
      const over = overCents / 100;
      throw conflict(
        `付款被拦截：项目预算 ¥${budget.toLocaleString("zh-CN")}，已占用 ¥${used.toLocaleString("zh-CN")}，` +
        `本笔 ¥${amount.toLocaleString("zh-CN")} 将超预算 ¥${over.toLocaleString("zh-CN")}；` +
        `如需特批请由总管理员携带 force 标记提交`,
        "OVER_BUDGET",
        { budget, used, amount, over }
      );
    }
    const at = now();

    // 一票一付：同项目 + 同收款方 + 同发票号 已有有效付款单，说明这张票已经报过账。
    // 只按发票号拦会误伤（不同收款方各自开票，号段可能撞），所以三个条件一起判。
    if (invoiceNo) {
      const dup = db.prepare(
        "SELECT id FROM payments WHERE pid = ? AND invoice_no = ? AND payee = ? AND status <> '已驳回'"
      ).get(p.id, invoiceNo, payee);
      if (dup) {
        throw conflict(
          `发票号 ${invoiceNo} 已用于付款单 ${dup.id}（同项目、同收款方），不可重复挂账`,
          "DUPLICATE_INVOICE", { payment: dup.id }
        );
      }
    }

    const id = nextId(db, "payments", "id", "PY");
    db.prepare("INSERT INTO payments (id,pid,type,payee,payee_bank,payee_account,amount,invoice_no,req_user,status,remark,created_by,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)")
      .run(id, p.id, b.type, payee, payeeBank, payeeAccount, amount, invoiceNo, ctx.user.name, "待审批", remark, ctx.user.id, at);
    const apId = nextId(db, "approvals", "id", "AP");
    db.prepare("INSERT INTO approvals (id,type,title,pid,ref_id,amount,by_user,sla,status,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)")
      .run(apId, "付款审批", `${b.type} ¥${amount.toLocaleString("zh-CN")}`, p.id, id, amount, ctx.user.name, "1 个工作日", "待审批", at);
    logAudit({
      user: ctx.user, module: "财务结算", action: "付款申请", target: p.id,
      detail: `${id} ${b.type} ¥${amount.toLocaleString("zh-CN")} → ${b.payee}（${payeeBank} 尾号 ${payeeAccount.slice(-4)}；核销已通过${force ? "；超预算特批" : ""}）`,
      ip: ctx.ip
    });
    return { payment: db.prepare("SELECT * FROM payments WHERE id = ?").get(id), message: `付款申请 ${id} 已提交，等待财务审批` };
  });

  /**
   * 补录收款账户（V1.2.18）。
   *
   * 为什么需要这个接口：账号是这一版才加的字段，线上已经存在一批没有账号的付款单。
   * 不给补录入口，财务要么打不了款，要么只能绕到线下 —— 那这个字段等于白加。
   *
   * 只允许财务与核销（或总管理员）改，且**已付款的不能改**：
   * 钱已经出去了，回头改账号等于篡改凭证。
   */
  router.patch("/api/payments/:id/account", async (ctx) => {
    const y = db.prepare("SELECT * FROM payments WHERE id = ?").get(ctx.params.id);
    if (!y) throw notFound("付款单不存在");
    const p = getProject(y.pid);
    assertProjectVisible(ctx.user, p);
    assertCan(ctx.user, "payment:pay", "只有财务与核销（或总管理员）可以登记收款账户");
    if (y.status === "已付款") {
      throw conflict("付款已完成，收款账户不可再修改（如需更正请走线下凭证更正流程）", "PAID_LOCKED");
    }
    const b = ctx.body || {};
    const bank = parseBankName(b.payee_bank);
    const account = parseBankAccount(b.payee_account);
    db.prepare("UPDATE payments SET payee_bank = ?, payee_account = ? WHERE id = ?").run(bank, account, y.id);
    logAudit({
      user: ctx.user, module: "财务结算", action: "登记收款账户", target: p.id,
      detail: `${y.id} ${y.payee} → ${bank} 尾号 ${account.slice(-4)}`, ip: ctx.ip
    });
    return { payment: db.prepare("SELECT * FROM payments WHERE id = ?").get(y.id), message: `${y.id} 收款账户已登记` };
  });

  router.post("/api/payments/:id/approve", async (ctx) => {
    const y = db.prepare("SELECT * FROM payments WHERE id = ?").get(ctx.params.id);
    if (!y) throw notFound("付款单不存在");
    const p = getProject(y.pid);
    assertProjectVisible(ctx.user, p);
    assertCan(ctx.user, "payment:approve", "只有协会管理员（或总管理员）可以审批付款");
    if (y.status !== "待审批") throw conflict(`付款单已是「${y.status}」状态`);
    const approve = requireDecision(ctx.body);
    const st = approve ? "已审批" : "已驳回";
    db.prepare("UPDATE payments SET status = ? WHERE id = ?").run(st, y.id);
    db.prepare("UPDATE approvals SET status = ?, decided_by = ?, decided_at = ?, comment = ? WHERE ref_id = ? AND type = '付款审批' AND status = '待审批'")
      .run(approve ? "已通过" : "已驳回", ctx.user.name, now(), String(ctx.body?.comment || ""), y.id);
    logAudit({ user: ctx.user, module: "财务结算", action: approve ? "付款审批通过" : "付款驳回", target: p.id, detail: `${y.id} ¥${Number(y.amount).toLocaleString("zh-CN")}`, ip: ctx.ip });
    return { payment: db.prepare("SELECT * FROM payments WHERE id = ?").get(y.id), message: `付款单 ${y.id} ${st}` };
  });

  router.post("/api/payments/:id/pay", async (ctx) => {
    const y = db.prepare("SELECT * FROM payments WHERE id = ?").get(ctx.params.id);
    if (!y) throw notFound("付款单不存在");
    const p = getProject(y.pid);
    assertProjectVisible(ctx.user, p);
    assertCan(ctx.user, "payment:pay", "只有财务与核销（或总管理员）可以执行付款");
    if (y.status !== "已审批") throw conflict(`只有「已审批」的付款单可以付款，当前为「${y.status}」`);
    // V1.2.18：没有收款账户就付不了款 —— 与其让财务自己发现，不如在门口拦住
    if (!y.payee_account || !y.payee_bank) {
      throw conflict(
        `${y.id} 还没有登记收款账户，无法付款。请先点「登记账户」补上开户行与银行账号`,
        "PAYEE_ACCOUNT_MISSING", { payment: y.id }
      );
    }
    if (!PAYABLE_STATUS.includes(p.status)) throw conflict("项目核销状态异常，付款已拦截", "VERIFY_GATE");
    db.prepare("UPDATE payments SET status = '已付款', paid_at = ? WHERE id = ?").run(now(), y.id);
    logAudit({ user: ctx.user, module: "财务结算", action: "付款", target: p.id, detail: `${y.id} ${y.type} ¥${Number(y.amount).toLocaleString("zh-CN")} 已提交银行`, ip: ctx.ip });
    return { payment: db.prepare("SELECT * FROM payments WHERE id = ?").get(y.id), message: `${y.id} 已付款` };
  });

  /* ---------------- 审批中心 ---------------- */
  router.get("/api/approvals", async (ctx) => {
    /**
     * V1.2.21：审批中心补模块级鉴权（巡检发现的，与 V1.2.17 的 SEC-02 同一类）。
     *
     * 之前这里只有数据范围过滤：guest 请求返回 200 + 空列表，exec 也一样。
     * 空列表不泄露内容，但「侧栏没有这个入口」和「接口能通」是两件事 ——
     * 口径不一致，下一个读代码的人会以为审批中心对所有人开放。
     *
     * 判据与侧栏 NAV 的 need 同口径：具备任一审批权限才能进。
     */
    const canApprove = can(ctx.user, "project:approve")
      || can(ctx.user, "verify:exception_approve")
      || can(ctx.user, "payment:approve")
      || can(ctx.user, "contract:approve");
    if (!canApprove) throw forbidden("审批中心仅对具备审批权限的角色开放");

    const { sql, params } = scopeFilter(ctx.user);
    const where = [sql];
    const args = [...params];
    if (ctx.query.status) { where.push("a.status = ?"); args.push(ctx.query.status); }
    if (ctx.query.type) { where.push("a.type = ?"); args.push(ctx.query.type); }
    const rows = db.prepare(
      `SELECT a.*, p.name AS pname FROM approvals a LEFT JOIN projects p ON p.id = a.pid
       WHERE ${where.join(" AND ")} ORDER BY CASE a.status WHEN '待审批' THEN 0 ELSE 1 END, a.created_at DESC`
    ).all(...args);
    return { rows, pending: rows.filter((r) => r.status === "待审批").length };
  });

  /** 审批类型 → 所需权限。集中一处，顺序才不会各处各写一套 */
  const DECIDE_PERM = {
    "立项审批": ["project:approve", "只有协会管理员（或总管理员）可以审批立项"],
    "变更审批": ["project:approve", "只有协会管理员（或总管理员）可以审批变更"],
    "例外单审批": ["verify:exception_approve", "只有财务与核销（或总管理员）可以审批例外单"],
    "付款审批": ["payment:approve", "只有协会管理员（或总管理员）可以审批付款"],
    "合同审批": ["contract:approve", "只有协会管理员（或总管理员）可以审批合同签署"]
  };

  /** 统一审批入口：按 type 分派 */
  router.patch("/api/approvals/:id/sla", async ctx => {
    if(!isSuper(ctx.user))throw forbidden("只有总管理员可以修改审批时限");
    const approval=db.prepare("SELECT * FROM approvals WHERE id=?").get(ctx.params.id);
    if(!approval)throw notFound("审批单不存在");
    const p=getProject(approval.pid);assertProjectVisible(ctx.user,p);
    if(approval.status!=="待审批")throw conflict("只允许修改待审批单的时限","APPROVAL_LOCKED");
    const sla=String(ctx.body?.sla||"").trim();
    if(sla.length<2||sla.length>80||/[<>\r\n]/.test(sla))throw bad("时限须为 2~80 字的有效说明");
    db.prepare("UPDATE approvals SET sla=? WHERE id=?").run(sla,approval.id);
    logAudit({user:ctx.user,module:"审批中心",action:"修改审批时限",target:p.id,
      detail:approval.id+" 时限："+String(approval.sla||"未设置")+" → "+sla,ip:ctx.ip});
    return {id:approval.id,sla,message:"审批时限已更新"};
  });
  router.post("/api/approvals/:id/decide", async (ctx) => {
    const a = db.prepare("SELECT * FROM approvals WHERE id = ?").get(ctx.params.id);
    if (!a) throw notFound("审批单不存在");

    /**
     * V1.2.17 BUG-02：**权限先于状态**。
     *
     * 原来第一句就是 `if (a.status !== "待审批") throw conflict(...)`，
     * 于是零权限的角色（guest）去审批一张已经通过的单子，拿到的是 409
     * 「该审批单已是「已通过」状态」—— 没权限却能探到单据状态，属于轻量信息泄露。
     * 统一顺序：登录态（框架已保证）→ 权限 → 数据范围 → 对象存在性 → 状态机 → 执行。
     */
    const need = DECIDE_PERM[a.type];
    if (!need) throw bad(`未知的审批类型「${a.type}」`);
    assertCan(ctx.user, need[0], need[1]);

    if (a.status !== "待审批") throw conflict(`该审批单已是「${a.status}」状态`);
    const p = getProject(a.pid);
    assertProjectVisible(ctx.user, p);
    const approve = requireDecision(ctx.body);
    const comment = String(ctx.body?.comment || "");

    if (a.type === "立项审批") {
      const r = transition(p.id, approve ? "approve" : "reject", ctx.user, { comment }, ctx.ip);
      return { message: r.message, project: r.project };
    }
    if (a.type === "例外单审批") {
      const ex = db.prepare("SELECT * FROM exceptions WHERE id = ?").get(a.ref_id);
      if (!ex) {
        throw notFound(`审批单 ${a.id} 关联的例外单 ${a.ref_id} 不存在，请联系管理员修复数据`);
      }
      // 业务单据已经有结论了（最常见：第 N 步改判通过后系统自动撤销了例外单），
      // 审批单却还挂在「待审批」—— 这时不该报错，应该把结论同步过来。
      // 老板 2026-10-28 遇到的就是这个：点「通过」报「不存在」，单子却还在列表里。
      if (ex.status !== "待审批") {
        const synced = EX_DECIDED[ex.status] || "已撤销";
        db.prepare("UPDATE approvals SET status = ?, decided_by = ?, decided_at = ?, comment = ? WHERE id = ?")
          .run(synced, ex.approved_by || "系统", ex.approved_at || now(),
            `例外单 ${ex.id} 已是「${ex.status}」，审批单同步关闭`, a.id);
        return { message: `例外单 ${ex.id} 已是「${ex.status}」，该审批单已同步关闭（无需再审批）`, synced: true };
      }
      const at = now();
      db.prepare("UPDATE exceptions SET status = ?, approved_by = ?, approved_at = ?, comment = ? WHERE id = ?")
        .run(approve ? (isDemoMode() ? "已通过" : "待复核") : "已驳回", ctx.user.name, at, comment, ex.id);
      db.prepare("UPDATE approvals SET status = ?, decided_by = ?, decided_at = ?, comment = ? WHERE id = ?")
        .run(approve ? "已通过" : "已驳回", ctx.user.name, at, comment, a.id);
      // 生产流程：例外审批不等于核销通过；整改后必须回原步骤重新核验。
      if (Number(ex.step_no)>0) db.prepare("UPDATE verify_steps SET result = ?, remark = ?, checked_by = ?, checked_at = ? WHERE pid = ? AND step_no = ?")
        .run(approve && isDemoMode() ? "已解例外" : "不通过",
          approve ? (isDemoMode() ? `例外获批：${ex.reason}` : `整改已受理：${ex.reason}，须原步骤复核`) : `例外被驳回：${ex.reason}`,
          ctx.user.name, at, ex.pid, ex.step_no);
      logAudit({ user: ctx.user, module: "会后核销", action: approve ? "例外通过" : "例外驳回", target: ex.pid, detail: `${ex.id} 第 ${ex.step_no} 步：${ex.reason}`, ip: ctx.ip });
      return { message: `例外单 ${ex.id} ${approve ? "已通过" : "已驳回"}`, verification: verification(ex.pid) };
    }
    if (a.type === "合同审批") {
      const c = db.prepare("SELECT * FROM contracts WHERE id=? AND pid=?").get(a.ref_id,p.id);
      if (!c) throw notFound("关联合同不存在");
      if (c.status !== "待签署") throw conflict("只有待签署合同可以审批，当前状态：" + c.status);
      if (!isDemoMode() && !isSuper(ctx.user) && Number(c.created_by) === Number(ctx.user.id))
        throw conflict("签署审批必须由其他协会管理员或总管理员完成", "NEED_SECOND_PERSON");
      const at = now();
      db.prepare("UPDATE contracts SET status=?,sign_date=? WHERE id=?")
        .run(approve ? "已签署" : "草稿", approve ? today() : "", c.id);
      db.prepare("UPDATE approvals SET status=?,decided_by=?,decided_at=?,comment=? WHERE id=?")
        .run(approve ? "已通过" : "已驳回",ctx.user.name,at,comment,a.id);
      logAudit({user:ctx.user,module:"筹备管理",action:approve?"合同签署审批通过":"合同签署驳回",target:p.id,detail:c.id+" "+c.name,ip:ctx.ip});
      return {message:"合同 "+c.id+(approve?" 已签署":" 已驳回，退回草稿")};
    }
    if (a.type === "付款审批") {
      const y = db.prepare("SELECT * FROM payments WHERE id = ?").get(a.ref_id);
      if (!y) {
        throw notFound(`审批单 ${a.id} 关联的付款单 ${a.ref_id} 不存在，请联系管理员修复数据`);
      }
      // 同例外单：付款单可能已经在「财务结算」里批过 / 驳过了，审批中心这条只是没同步
      if (y.status !== "待审批") {
        const synced = y.status === "已驳回" ? "已驳回" : "已通过";
        db.prepare("UPDATE approvals SET status = ?, decided_by = ?, decided_at = ?, comment = ? WHERE id = ?")
          .run(synced, "系统", now(), `付款单 ${y.id} 已是「${y.status}」，审批单同步关闭`, a.id);
        return { message: `付款单 ${y.id} 已是「${y.status}」，该审批单已同步关闭（无需再审批）`, synced: true };
      }
      db.prepare("UPDATE payments SET status = ? WHERE id = ?").run(approve ? "已审批" : "已驳回", y.id);
      db.prepare("UPDATE approvals SET status = ?, decided_by = ?, decided_at = ?, comment = ? WHERE id = ?")
        .run(approve ? "已通过" : "已驳回", ctx.user.name, now(), comment, a.id);
      logAudit({ user: ctx.user, module: "财务结算", action: approve ? "付款审批通过" : "付款驳回", target: p.id, detail: `${y.id} ¥${Number(y.amount).toLocaleString("zh-CN")}`, ip: ctx.ip });
      return { message: `付款单 ${y.id} ${approve ? "已审批" : "已驳回"}` };
    }
    // 变更审批：用稳定用户 ID 留下审批主体，避免同名人员绕过双人复核。
    db.prepare("UPDATE approvals SET status = ?, decided_by = ?, decided_at = ?, comment = ?, decided_by_id = ? WHERE id = ?")
      .run(approve ? "已通过" : "已驳回", ctx.user.name, now(), comment, ctx.user.id, a.id);
    logAudit({ user: ctx.user, module: "项目管理", action: approve ? "审批通过" : "审批驳回", target: p.id, detail: `${a.type}：${a.title}`, ip: ctx.ip });
    return { message: `${a.type} ${approve ? "已通过" : "已驳回"}${a.type === "变更审批" && approve ? "，待另一人执行落账后生效" : ""}` };
  });

  /**
   * 变更申请。
   *
   * 变更单可以带「变更后预算」（存进 approvals.amount，0 表示只改内容不涉金额）。
   * 注意：审批通过**不改项目任何字段** —— 见下面的 /execute。
   */
  router.post("/api/projects/:id/change", async (ctx) => {
    const p = getProject(ctx.params.id);
    assertProjectVisible(ctx.user, p);
    // 变更申请会生成待审批单，属于写操作，必须过权限；原来只查了数据范围，
    // 结果是项目成员里的「普通用户 / 嘉宾」也能提交变更并进审批中心。
    assertCan(ctx.user, "project:change", "只有协会管理员 / 会务执行可以提交变更申请");
    if (!["已立项", "筹备中", "执行中"].includes(p.status)) throw conflict(`「${p.status}」项目不可提交变更`);
    const title = String(ctx.body?.title || "").trim();
    if (!title) throw bad("请填写变更内容");
    if (title.length > 500) throw bad("变更内容不能超过 500 字");
    // 同一项目堆一屏待审批变更单没有意义，也容易让人漏看真正要批的那张
    const pending = db.prepare(
      "SELECT COUNT(*) AS c FROM approvals WHERE pid = ? AND type = '变更审批' AND status = '待审批'"
    ).get(p.id).c;
    if (pending >= 3) throw conflict(`该项目已有 ${pending} 张待审批的变更单，请先处理完再提交`, "TOO_MANY_PENDING");
    // 已批未落账的变更单也不能堆 —— 两张都批了、都改预算，谁后落账谁生效，账就说不清了。
    // 只拦「涉及金额」的那种（amount > 0）：只改内容的变更（amount = 0）没有钱要落，
    // 和新变更的预算打不起来，拦它只会让项目被一张陈年内容变更永久锁死。
    const approved = db.prepare(
      "SELECT id FROM approvals WHERE pid = ? AND type = '变更审批' AND status = '已通过'" +
      " AND executed_at IS NULL AND COALESCE(amount, 0) > 0 LIMIT 1"
    ).get(p.id);
    if (approved) {
      throw conflict(
        `该项目有 1 张已审批但还没落账的「预算变更」（${approved.id}），请先执行落账再提交新的变更`,
        "CHANGE_PENDING_EXECUTE", { approval: approved.id }
      );
    }

    // 变更后预算：可选。填了就必须是合法的钱数，且不能低于已占用
    let newBudget = 0;
    if (ctx.body?.budget !== undefined && ctx.body?.budget !== null && String(ctx.body.budget) !== "") {
      const n = Number(ctx.body.budget);
      if (!Number.isFinite(n) || !(n > 0)) throw bad("变更后预算必须大于 0（不涉及金额请留空）");
      if (n > 1e9) throw bad("变更后预算不能超过 10 亿元");
      if (Number(n.toFixed(2)) !== n) throw bad("变更后预算最多保留两位小数");
      const used = committed(p.id);
      if (cents(n) < cents(used)) {
        throw conflict(
          `变更后预算 ¥${yuan(n).toLocaleString("zh-CN")} 低于该项目已占用金额 ¥${used.toLocaleString("zh-CN")}` +
          `（含待审批 / 已审批 / 已付款），落账后会与已挂账的付款冲突`,
          "BUDGET_BELOW_COMMITTED", { budget: yuan(n), used }
        );
      }
      newBudget = yuan(n);
    }

    const id = nextId(db, "approvals", "id", "AP");
    db.prepare("INSERT INTO approvals (id,type,title,pid,ref_id,amount,by_user,sla,status,created_at,submitted_by_id) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
      .run(id, "变更审批", title, p.id, p.id, newBudget, ctx.user.name, "2 个工作日", "待审批", now(), ctx.user.id);
    logAudit({
      user: ctx.user, module: "项目管理", action: "变更申请", target: p.id,
      detail: title + (newBudget ? `；申请预算 ¥${Number(p.budget).toLocaleString("zh-CN")} → ¥${newBudget.toLocaleString("zh-CN")}` : ""),
      ip: ctx.ip
    });
    return { message: `变更申请 ${id} 已提交${newBudget ? "（含预算调整）" : ""}`, approval: { id, amount: newBudget } };
  });

  /**
   * 变更落账 —— 双人复核。
   *
   * 老板 2026-10-27 拍板：变更审批通过后**不自动改预算**，必须人工再改一次，
   * 且执行人不能是审批人（也不能是申请人）。
   * 理由：审批和落账是两件事。一个人既批又改，等于没有复核；
   * 系统留痕也只能证明「同一个人做了两次决定」，证明不了有人核对过。
   *
   * 因此：审批通过 → status='已通过'，项目一个字段都不动；
   * 落账 → 另一人调这个接口，才真正写 projects.budget，status='已执行'。
   */
  router.post("/api/approvals/:id/execute", async (ctx) => {
    const a = db.prepare("SELECT * FROM approvals WHERE id = ?").get(ctx.params.id);
    if (!a) throw notFound("审批单不存在");
    if (a.type !== "变更审批") throw bad(`${a.type} 审批通过即生效，不需要执行落账`);
    if (a.status === "待审批") throw conflict("该变更单还没审批，不能执行落账", "NOT_APPROVED");
    if (a.status === "已驳回") throw conflict("该变更单已被驳回，无需执行落账", "REJECTED");
    if (a.executed_at || a.status === "已执行") {
      throw conflict(`该变更单已由 ${a.executed_by || "他人"} 于 ${a.executed_at || ""} 执行落账，不可重复执行`, "ALREADY_EXECUTED");
    }

    const p = getProject(a.pid);
    assertProjectVisible(ctx.user, p);
    assertCan(ctx.user, "change:execute", "变更落账需要协会管理员 / 会务执行 / 财务权限");

    // 双人复核：批的人不落账，落账的人不批；自己提的也不能自己落
    const me = ctx.user.name;
    const approvedByMe = a.decided_by_id != null
      ? Number(a.decided_by_id) === Number(ctx.user.id)
      : !!a.decided_by && me === a.decided_by;
    const submittedByMe = a.submitted_by_id != null
      ? Number(a.submitted_by_id) === Number(ctx.user.id)
      : !!a.by_user && me === a.by_user;
    if (approvedByMe) {
      throw conflict(
        `变更单 ${a.id} 由你审批，落账必须由另一人执行（双人复核）；请让其他有权限的同事操作`,
        "NEED_SECOND_PERSON", { decided_by: a.decided_by }
      );
    }
    if (submittedByMe) {
      throw conflict(
        `变更单 ${a.id} 由你提交，落账必须由另一人执行（双人复核）；请让其他有权限的同事操作`,
        "NEED_SECOND_PERSON", { by_user: a.by_user }
      );
    }

    // 已结算 / 已归档 = 账目已封，改预算会与结算单对不上；总管理员可例外落账并留痕
    frozenGate(ctx, p, ["已结算", "已归档"].includes(p.status),
      `项目已「${p.status}」，账目已封，变更不可再落账`, "FROZEN", "变更落账");

    let detail = `${a.id}：${a.title}`;
    let budgetInfo = null;
    const newBudget = yuan(a.amount);
    if (newBudget > 0) {
      const used = committed(p.id);
      if (cents(newBudget) < cents(used)) {
        throw conflict(
          `变更后预算 ¥${newBudget.toLocaleString("zh-CN")} 低于已占用金额 ¥${used.toLocaleString("zh-CN")}，落账会让账实不符`,
          "BUDGET_BELOW_COMMITTED", { budget: newBudget, used }
        );
      }
      budgetInfo = { from: yuan(p.budget), to: newBudget };
      db.prepare("UPDATE projects SET budget = ?, updated_at = ? WHERE id = ?").run(newBudget, now(), p.id);
      detail += `；预算 ¥${Number(p.budget).toLocaleString("zh-CN")} → ¥${newBudget.toLocaleString("zh-CN")}`;
    }

    const at = now();
    db.prepare("UPDATE approvals SET status = '已执行', executed_by = ?, executed_at = ?, executed_by_id = ? WHERE id = ?")
      .run(me, at, ctx.user.id, a.id);
    logAudit({ user: ctx.user, module: "项目管理", action: "变更落账", target: p.id, detail, ip: ctx.ip });
    return {
      message: `变更 ${a.id} 已落账${budgetInfo ? `，预算已调整为 ¥${budgetInfo.to.toLocaleString("zh-CN")}` : ""}`,
      project: getProject(p.id),
      approval: db.prepare("SELECT * FROM approvals WHERE id = ?").get(a.id),
      budget: budgetInfo
    };
  });

  return router;
}

module.exports = { register, PAYABLE_STATUS };
