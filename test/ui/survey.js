/**
 * 全角色 × 全功能巡检（V1.2.21）
 * 运行：node test/ui/survey.js                    # 线上
 *       ERP_BASE=http://127.0.0.1:8790 node test/ui/survey.js   # 本地
 *
 * 老板 2026-10-28：「把所有测试数据都删除了，然后重新各个角色各个功能去测试一次」。
 *
 * 这个脚本按**业务流程的先后**走一遍，每一步都换到该负责的角色：
 *   立项（协会管理员）→ 筹备（会务执行）→ 材料 → 核销（财务）→ 付款（执行申请 / 财务付）
 *   → 结算（财务）→ 归档（协会管理员）
 * 顺带验：权限矩阵、数据范围、导出、审计、会务需求、例外单。
 *
 * 与 test/v12xx 的区别：那些是「一条缺陷一条断言」的回归，这个是**验收清单** ——
 * 跑完能直接回答「五个角色、十四个模块，现在是不是都能用」。
 */
const BASE = process.env.ERP_BASE || "https://erp.aibuild.work";
const TAG = "巡检" + new Date().toISOString().slice(5, 16).replace(/[-:T]/g, "");

let pass = 0, fail = 0;
const fails = [];
const section = (t) => console.log(`\n${t}`);
const check = (name, ok, extra = "") => {
  if (ok) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; fails.push(name); console.log(`  ✗ ${name}  ${extra}`); }
};

async function login(username, password = "123456") {
  const r = await fetch(`${BASE}/api/auth/login`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password })
  });
  const t = await r.text();
  let d; try { d = JSON.parse(t); } catch { d = t; }
  if (r.status !== 200) throw new Error(`${username} 登录失败：${r.status} ${JSON.stringify(d).slice(0, 120)}`);
  return { cookie: (r.headers.get("set-cookie") || "").split(";")[0], user: d.user };
}
function cli(cookie) {
  return async (method, url, body) => {
    const r = await fetch(BASE + url, {
      method, headers: { "Content-Type": "application/json", cookie },
      body: body ? JSON.stringify(body) : undefined
    });
    const text = await r.text();
    let data = null; try { data = JSON.parse(text); } catch { data = text; }
    return { status: r.status, data, code: data?.error?.code, msg: data?.error?.message || "" };
  };
}
const MATERIALS = ["立项文件", "合同", "议程", "课件", "签到表", "劳务表", "发票", "现场照片"];
const BANK = "中国银行北京分行";
const ACCT = "3210987654321098";

(async () => {
  console.log(`巡检目标：${BASE}`);
  console.log(`标记：${TAG}`);

  /* ---------------- 0. 五个角色都能登录 ---------------- */
  section("[0] 账号与登录");
  const roles = {};
  for (const u of ["admin", "assoc", "exec", "finance", "guest"]) {
    const s = await login(u);
    roles[u] = cli(s.cookie);
    check(`${u} 登录（${s.user.role_name}）`, !!s.cookie);
  }
  const bad = await fetch(`${BASE}/api/auth/login`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "admin", password: "wrong-pass" })
  });
  check("错误口令被拒", bad.status === 401, `实际 ${bad.status}`);

  /* ---------------- 1. 权限矩阵 ---------------- */
  section("[1] 角色 × 接口权限矩阵");
  const matrix = [
    // [接口, 方法, 期望：允许的角色]
    ["/api/projects", "GET", ["admin", "assoc", "exec", "finance", "guest"]],
    ["/api/contracts", "GET", ["admin", "assoc", "exec", "finance"]],
    ["/api/payments", "GET", ["admin", "assoc", "exec", "finance"]],
    ["/api/settlements", "GET", ["admin", "assoc", "finance"]], // exec 没有财务模块
    ["/api/materials", "GET", ["admin", "assoc", "exec", "finance"]],
    ["/api/audit", "GET", ["admin", "assoc"]],
    ["/api/users", "GET", ["admin"]],
    ["/api/approvals", "GET", ["admin", "assoc", "finance"]], // 与侧栏 need 同口径：任一审批权限
    ["/api/dashboard", "GET", ["admin", "assoc", "exec", "finance", "guest"]]
  ];
  for (const [url, method, allowed] of matrix) {
    const wrong = [];
    for (const u of ["admin", "assoc", "exec", "finance", "guest"]) {
      const r = await roles[u](method, url);
      const expectOk = allowed.includes(u);
      if (expectOk && r.status !== 200) wrong.push(`${u}应200实${r.status}`);
      if (!expectOk && r.status !== 403) wrong.push(`${u}应403实${r.status}`);
    }
    check(`${url}（${allowed.length} 角色可见）`, wrong.length === 0, wrong.join("；"));
  }

  /* ---------------- 2. 立项：协会管理员 ---------------- */
  section("[2] 立项（协会管理员）");
  const mk = await roles.assoc("POST", "/api/projects", {
    name: `${TAG}-全角色巡检会`, assoc: "华东医学会", form: "线下",
    date: "2027-09-09", budget: 60000, people: 50, owner: "王敏",
    agenda: "09:00 开幕致辞\n09:30 主题报告", phone: "021-60000000"
  });
  check("新建项目", mk.status === 200, JSON.stringify(mk.data).slice(0, 160));
  const pid = mk.data?.project?.id;
  if (!pid) { console.log("\n建项目失败，后续无法继续"); process.exit(1); }
  console.log(`      项目号：${pid}`);

  const sub = await roles.assoc("POST", `/api/projects/${pid}/transition`, { action: "submit" });
  check("提交立项", sub.status === 200, JSON.stringify(sub.data).slice(0, 120));
  check("提交后状态 = 待审批", sub.data?.project?.status === "待审批", sub.data?.project?.status);

  const appr = await roles.admin("POST", `/api/projects/${pid}/transition`, { action: "approve", comment: "同意" });
  check("总管理员审批通过", appr.status === 200, JSON.stringify(appr.data).slice(0, 120));
  check("审批后状态 = 已立项", appr.data?.project?.status === "已立项", appr.data?.project?.status);

  /**
   * 关键一步：把会务执行与财务加为项目成员。
   *
   * 新建项目默认只有创建人（王敏）在数据范围内 —— 张伟、陈静点开就是 403。
   * 这是 V1.2.6 起「数据范围按 user_id 认人」的正常表现，不是缺陷；
   * 现实里立项后第一件事也是拉人进项目组。
   */
  const pick = await roles.assoc("GET", "/api/users/pickable");
  const pickable = pick.data?.rows || [];
  let added = 0;
  for (const nm of ["张伟", "陈静"]) {
    const u = pickable.find((x) => x.name === nm);
    if (!u) continue;
    const r = await roles.assoc("POST", `/api/projects/${pid}/members`, { user_id: u.id });
    if (r.status === 200) added++;
  }
  check("把会务执行与财务加为项目成员", added === 2, `加入 ${added}/2`);

  // 会务需求（协会管理员建单 → 确认归档）
  // 字段名是 grp / item / budget —— 分组必须是 DEMAND_GROUPS 里的固定值
  const dem = await roles.assoc("PATCH", `/api/demand/${pid}`, {
    items: [{ grp: "现场执行", item: "会场布置", budget: 30000 }],
    remark: "巡检用"
  });
  check("建会务需求单", dem.status === 200, JSON.stringify(dem.data).slice(0, 160));
  const demOk = await roles.assoc("POST", `/api/demand/${pid}/confirm`);
  check("需求单确认归档", demOk.status === 200, JSON.stringify(demOk.data).slice(0, 160));

  /* ---------------- 3. 筹备：会务执行 ---------------- */
  section("[3] 筹备（会务执行）");
  for (const act of ["prep", "exec"]) {
    const r = await roles.exec("POST", `/api/projects/${pid}/transition`, { action: act });
    check(`推进到「${act === "prep" ? "筹备中" : "执行中"}」`, r.status === 200, JSON.stringify(r.data).slice(0, 120));
  }

  const ct = await roles.exec("POST", "/api/contracts", {
    pid, name: "巡检-会场服务合同", vendor: "巡检会展公司",
    amount: 30000, sign_date: "2027-08-01", status: "待签署", category: "场地餐饮"
  });
  check("录入合同", ct.status === 200, JSON.stringify(ct.data).slice(0, 140));

  section("[4] 材料 8 类（核销前置门）");
  let matOk = 0;
  for (const kind of MATERIALS) {
    const r = await roles.exec("POST", `/api/projects/${pid}/materials`, { kind, name: `${kind}-巡检.pdf` });
    if (r.status === 200) matOk++;
  }
  check("8 类材料全部登记", matOk === 8, `成功 ${matOk}/8`);
  const detail = await roles.exec("GET", `/api/projects/${pid}`);
  check("材料齐备度 8/8", detail.data?.materialsStatus?.ok === true);

  /* ---------------- 4. 核销：财务 ---------------- */
  section("[5] 核销（财务与核销）");
  const rv = await roles.exec("POST", `/api/projects/${pid}/transition`, { action: "request_verify" });
  check("提交核销（材料齐备后放行）", rv.status === 200, JSON.stringify(rv.data).slice(0, 160));

  // 第 4 步判「不通过」→ 自动生成例外单 → 财务审批 → 变「已解例外」
  let judged = 0;
  for (const no of [1, 2, 3]) {
    const r = await roles.finance("POST", `/api/projects/${pid}/verify/steps/${no}`, { result: "通过" });
    if (r.status === 200) judged++;
  }
  check("第 1~3 步判定通过", judged === 3, `${judged}/3`);

  const fail4 = await roles.finance("POST", `/api/projects/${pid}/verify/steps/4`, {
    result: "不通过", remark: "课件与议程课题不一致（巡检）"
  });
  check("第 4 步判不通过 → 自动生成例外单", fail4.status === 200, JSON.stringify(fail4.data).slice(0, 160));

  const vd = await roles.finance("GET", `/api/projects/${pid}/verify`);
  const ex = vd.data?.verification?.exceptions?.[0];
  check("例外单已生成且待审批", !!ex && ex.status === "待审批", JSON.stringify(ex || {}).slice(0, 120));
  if (ex) {
    const ap = await roles.finance("POST", `/api/exceptions/${ex.id}/decide`, { approve: true, comment: "同意补录" });
    check("例外单审批通过", ap.status === 200, JSON.stringify(ap.data).slice(0, 140));
  }
  for (const no of [5, 6]) {
    const r = await roles.finance("POST", `/api/projects/${pid}/verify/steps/${no}`, { result: "通过" });
    check(`第 ${no} 步判定通过`, r.status === 200, JSON.stringify(r.data).slice(0, 120));
  }
  const passVerify = await roles.finance("POST", `/api/projects/${pid}/transition`, { action: "verify_pass" });
  check("核销通过 → 已核销", passVerify.status === 200 && passVerify.data?.project?.status === "已核销",
    JSON.stringify(passVerify.data).slice(0, 160));

  /* ---------------- 5. 付款：执行申请 / 财务审批并付款 ---------------- */
  section("[6] 付款（申请 → 审批 → 付款）");
  const early = await roles.finance("POST", "/api/payments", {
    pid, type: "学会公付", payee: "巡检会展公司", amount: 20000,
    payee_bank: BANK, payee_account: ACCT, invoice_no: `INV-${TAG}`
  });
  check("付款申请（含收款账户）", early.status === 200, JSON.stringify(early.data).slice(0, 160));
  const payId = early.data?.payment?.id;

  const noAcct = await roles.finance("POST", "/api/payments", {
    pid, type: "学会公付", payee: "缺账户探针", amount: 1
  });
  check("缺收款账户被拦（400）", noAcct.status === 400, `实际 ${noAcct.status}`);

  if (payId) {
    const ap = await roles.finance("POST", `/api/payments/${payId}/approve`, { approve: true });
    check("付款审批通过", ap.status === 200, JSON.stringify(ap.data).slice(0, 140));
    const paid = await roles.finance("POST", `/api/payments/${payId}/pay`, {});
    check("执行付款 → 已付款", paid.status === 200 && paid.data?.payment?.status === "已付款",
      JSON.stringify(paid.data).slice(0, 160));
  }

  /* ---------------- 6. 结算：财务 ---------------- */
  section("[7] 结算（财务）");
  const settle = await roles.finance("POST", `/api/projects/${pid}/transition`, {
    action: "settle", payee: "华东医学会", payee_bank: BANK, payee_account: ACCT
  });
  check("生成结算单", settle.status === 200, JSON.stringify(settle.data).slice(0, 160));

  const stList = await roles.finance("GET", "/api/settlements");
  const st = (stList.data?.rows || []).find((x) => x.pid === pid);
  check("结算单带收款方与账户", !!st && st.payee && st.payee_account,
    JSON.stringify(st || {}).slice(0, 160));
  if (st) {
    check("结算金额对得上（收入 = 预算 60000）", Number(st.income) === 60000, `收入 ${st.income}`);
    check("支出 = 已付款 20000", Number(st.expense) === 20000, `支出 ${st.expense}`);
    check("结余 = 40000", Number(st.profit) === 40000, `结余 ${st.profit}`);
  }

  /* ---------------- 7. 归档：协会管理员 ---------------- */
  section("[8] 归档（协会管理员）");
  const arc = await roles.assoc("POST", `/api/projects/${pid}/transition`, { action: "archive" });
  check("归档成功 → 已归档", arc.status === 200 && arc.data?.project?.status === "已归档",
    JSON.stringify(arc.data).slice(0, 160));

  const frozen = await roles.exec("POST", `/api/projects/${pid}/materials`, { kind: "现场照片", name: "归档后补材料.pdf" });
  check("归档后材料不可再登记（409）", frozen.status === 409, `实际 ${frozen.status}`);

  /* ---------------- 8. 导出 ---------------- */
  section("[9] 导出（4 类 CSV）");
  /**
   * 注意不能用 startsWith("\ufeff") 判 CSV：fetch 的 Response.text() 解码 UTF-8 时会**吃掉 BOM**，
   * 所以首字符永远不是 \ufeff。改判首行是不是表头（每个导出都有中文表头）。
   */
  for (const [kind, head] of [["projects", "项目编号"], ["payments", "付款单号"],
    ["contracts", "合同编号"], ["settlements", "结算单号"]]) {
    const r = await roles.finance("GET", `/api/export/${kind}`);
    const isCsv = typeof r.data === "string" && r.data.split(/\r?\n/)[0].includes(head);
    check(`导出 ${kind}（${head}）`, r.status === 200 && isCsv, `status ${r.status}`);
  }
  const gExport = await roles.guest("GET", "/api/export/projects");
  check("guest 不能导出（403）", gExport.status === 403, `实际 ${gExport.status}`);

  /* ---------------- 9. 数据范围 ---------------- */
  section("[10] 数据范围");
  const gp = await roles.guest("GET", "/api/projects");
  const gIds = (gp.data?.rows || []).map((x) => x.id).sort();
  check("guest 只看到自己的 3 场", gIds.join(",") === "MP-2026-002,MP-2026-005,MP-2026-011", gIds.join(","));
  const gDetail = await roles.guest("GET", `/api/projects/${pid}`);
  check("guest 打不开别人的项目（403）", gDetail.status === 403, `实际 ${gDetail.status}`);

  /**
   * exec 的数据范围是「负责人 + 创建人 + 成员」，不是按协会 —— 所以他能看到别的协会的项目，
   * 只要那个项目是他负责的（跨协会协作在协会里很常见）。断言的是这条规则本身。
   */
  const ep = await roles.exec("GET", "/api/projects?size=200");
  const epRows = ep.data?.rows || [];
  const crossAssoc = epRows.filter((x) => x.assoc !== "华东医学会");
  const unexplained = [];
  for (const row of crossAssoc) {
    if (row.owner === "张伟") continue;
    // 不是他负责的，就得是他被拉进去当成员 —— 跨协会协作本来就是这样发生的
    const d = await roles.exec("GET", `/api/projects/${row.id}`);
    const inTeam = (d.data?.members || []).some((m) => m.name === "张伟");
    if (!inTeam) unexplained.push(`${row.id}（负责人 ${row.owner}，且不在成员里）`);
  }
  check("exec 的跨协会项目都有他参与（负责人或成员）", unexplained.length === 0, unexplained.join("；"));
  check("exec 能看到巡检项目（已被加为成员）", epRows.some((x) => x.id === pid), "看不到新建的项目");

  /* ---------------- 10. 审计 ---------------- */
  section("[11] 审计留痕");
  const au = await roles.admin("GET", "/api/audit?size=200");
  const acts = (au.data?.rows || []).map((x) => `${x.module}/${x.action}`);
  /**
   * 核销单步判定的审计记在 action="结论" 上（detail 里才有「第 N 步…判定」），
   * 不是单独一个 action="判定" —— 所以这里匹配 detail。
   */
  const details = (au.data?.rows || []).map((x) => `${x.module}/${x.action}/${x.detail || ""}`);
  for (const [label, needle] of [
    // 立项 / 审批 / 结算 都记在「项目管理/状态流转」的 detail 里（提交立项、立项通过、生成结算单）
    ["立项", "状态流转/提交立项"], ["审批", "状态流转/立项审批通过"], ["材料登记", "材料中心/上传/"],
    ["核销判定", "会后核销/结论/第 "], ["付款", "财务结算/付款/"],
    ["结算", "状态流转/生成结算单"], ["归档", "档案中心/归档/"]
  ]) {
    check(`审计里有「${label}」`, details.some((a) => a.includes(needle)), acts.slice(0, 6).join(" | "));
  }

  /* ---------------- 汇总 ---------------- */
  console.log("\n" + "─".repeat(60));
  console.log(`巡检结果：${pass} 通过 / ${fail} 失败`);
  if (fail) {
    console.log("失败项：");
    for (const f of fails) console.log("  · " + f);
  }
  console.log(`巡检项目号：${pid}（如需清理请调用 /api/admin/reset）`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error("\n巡检中断：", e.message);
  process.exit(2);
});
