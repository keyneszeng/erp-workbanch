/**
 * V1.2.18 线上验证：付款 / 结算单的收款方与银行账号（**只读**）
 * 运行：node test/ui/cf-v1218.js
 *
 * 唯一的写请求是「缺账户的付款申请」，预期 400 且不会落库 —— 用来证明必填真的生效。
 */
const BASE = process.env.ERP_BASE || "https://erp.aibuild.work";

let pass = 0, fail = 0;
const check = (name, ok, extra = "") => {
  if (ok) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}  ${extra}`); }
};

async function login(username, password = "123456") {
  const r = await fetch(`${BASE}/api/auth/login`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password })
  });
  if (r.status !== 200) throw new Error(`${username} 登录失败：${r.status}`);
  return (r.headers.get("set-cookie") || "").split(";")[0];
}
function client(cookie) {
  return async (method, url, body) => {
    const r = await fetch(BASE + url, {
      method, headers: { "Content-Type": "application/json", cookie },
      body: body ? JSON.stringify(body) : undefined
    });
    const text = await r.text();
    let data = null; try { data = JSON.parse(text); } catch { data = text; }
    return { status: r.status, data };
  };
}

(async () => {
  const finance = client(await login("finance"));
  const admin = client(await login("admin"));

  console.log("\n[1] 付款单带收款账户");
  const pays = await finance("GET", "/api/payments?size=100");
  check("付款列表可读", pays.status === 200, `实际 ${pays.status}`);
  const seeded = pays.data.rows.filter((x) => /^PY-2026-0(3\d|4[0-4])$/.test(x.id));
  check("种子付款单都在", seeded.length > 0, `找到 ${seeded.length} 条`);
  const withAcct = seeded.filter((x) => x.payee_account && x.payee_bank);
  check("种子付款单都有开户行与账号", withAcct.length === seeded.length,
    `有账户 ${withAcct.length}/${seeded.length}：${seeded.filter((x) => !x.payee_account).map((x) => x.id).join(",")}`);
  const sample = seeded[0];
  if (sample) console.log(`      ${sample.id} ${sample.payee} · ${sample.payee_bank} · ${sample.payee_account}`);

  console.log("\n[2] 结算单带收款方与账户");
  const sts = await finance("GET", "/api/settlements");
  check("结算列表可读", sts.status === 200);
  const keys = Object.keys(sts.data.rows[0] || {});
  check("返回字段含 payee / payee_bank / payee_account",
    keys.includes("payee") && keys.includes("payee_bank") && keys.includes("payee_account"),
    keys.join(","));
  const stWithPayee = sts.data.rows.filter((x) => x.payee);
  console.log(`      线上结算单 ${sts.data.rows.length} 张，其中 ${stWithPayee.length} 张已登记收款方（历史单为空属正常）`);

  console.log("\n[3] 付款申请缺账户被拦（不会落库）");
  const before = (await finance("GET", "/api/payments?size=100")).data.rows.length;
  const proj = await admin("GET", "/api/projects");
  const payable = (proj.data.rows || []).find((p) => p.status === "已核销");
  if (!payable) {
    check("有可付款项目用于验证", false, "线上当前没有「已核销」项目，跳过");
  } else {
    const r = await finance("POST", "/api/payments", {
      pid: payable.id, type: "学会公付", payee: "探针收款方", amount: 1
    });
    check("缺开户行/账号 → 400", r.status === 400, `实际 ${r.status} ${JSON.stringify(r.data)}`);
    check("报错指向开户行", /开户行|银行账号/.test(String(r.data?.error?.message || "")),
      String(r.data?.error?.message || ""));
    const after = (await finance("GET", "/api/payments?size=100")).data.rows.length;
    check("没有落库（笔数不变）", after === before, `${before} → ${after}`);
  }

  console.log("\n[4] 导出带上收款信息");
  const payCsv = await finance("GET", "/api/export/payments");
  const payHead = String(payCsv.data).split("\r\n")[0] || "";
  check("付款明细含「开户行」列", /开户行/.test(payHead), payHead.slice(0, 120));
  check("付款明细含「银行账号」列", /银行账号/.test(payHead), payHead.slice(0, 120));
  const stCsv = await finance("GET", "/api/export/settlements");
  const stHead = String(stCsv.data).split("\r\n")[0] || "";
  check("结算汇总含「收款方」列", /收款方/.test(stHead), stHead.slice(0, 120));

  console.log("\n[5] 前端已更新");
  const js = await fetch(`${BASE}/assets/js/pages/finance.js`).then((r) => r.text());
  check("财务页含「开户行」字段", /开户行/.test(js));
  check("财务页含「登记账户」入口", /登记账户/.test(js));

  console.log(`\n=== ${pass} 通过 / ${fail} 失败 ===`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error("脚本异常：", e);
  process.exit(1);
});
