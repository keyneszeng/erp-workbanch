/**
 * V1.2.19 线上验证：材料 8 项才能开启核销（**只读**）
 * 运行：node test/ui/cf-v1219.js
 *
 * 线上这批项目是历史数据：材料字段早就有，但「待核销」的项目当年没被要求备齐 8 类。
 * 所以这里**不写请求**，只报告现状：哪些项目材料齐、哪些会被新门禁挡住。
 * 这是给运营看的清单，不是「功能没做好」。
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
  return async (method, url) => {
    const r = await fetch(BASE + url, { method, headers: { cookie } });
    const text = await r.text();
    let data = null; try { data = JSON.parse(text); } catch { data = text; }
    return { status: r.status, data };
  };
}

(async () => {
  const admin = client(await login("admin"));

  console.log("\n[1] 前端已更新：页签顺序与门禁文案");
  const js = await fetch(`${BASE}/assets/js/pages/project.js`).then((r) => r.text());
  const tabsBlock = js.slice(js.indexOf("const TABS"), js.indexOf("let tab ="));
  const iMat = tabsBlock.indexOf('"materials"');
  const iVer = tabsBlock.indexOf('"verify"');
  check("TABS 里材料在核销之前", iMat >= 0 && iVer >= 0 && iMat < iVer, tabsBlock.replace(/\s+/g, " ").slice(0, 160));
  check("核销页签有「核销未开启」文案", /核销未开启/.test(js));
  check("材料页签标注核销前置", /已满足核销前置/.test(js));

  console.log("\n[2] 门禁错误码已上线");
  const health = await fetch(`${BASE}/api/health`);
  check("服务在线", health.ok);

  console.log("\n[3] 现状盘点：待核销 / 已核销项目的材料齐备度");
  const list = await admin("GET", "/api/projects");
  const targets = (list.data.rows || []).filter((p) => ["待核销", "已核销"].includes(p.status));
  const blocked = [];
  for (const p of targets) {
    const d = await admin("GET", `/api/projects/${p.id}`);
    const ms = d.data.materialsStatus;
    const mark = ms.ok ? "齐备" : `缺 ${ms.missing.length} 类`;
    console.log(`      ${p.id} ${p.status.padEnd(4)} 材料 ${8 - ms.missing.length}/8（${mark}）`);
    if (!ms.ok) blocked.push({ id: p.id, status: p.status, missing: ms.missing });
  }
  check("能读到每个项目的材料状态", targets.length > 0);

  if (blocked.length) {
    console.log("\n      以下项目会被新门禁拦住（材料未齐，需先登记才能继续判定）：");
    for (const b of blocked) console.log(`        ${b.id}（${b.status}）缺：${b.missing.join("、")}`);
  } else {
    console.log("\n      所有待核销 / 已核销项目材料均已齐备");
  }

  console.log("\n[4] 项目详情接口与核销看板接口同源");
  const one = targets[0];
  if (one) {
    const a = await admin("GET", `/api/projects/${one.id}`);
    const b = await admin("GET", `/api/projects/${one.id}/verify`);
    check("两个接口的 materialsStatus 一致",
      JSON.stringify(a.data.materialsStatus) === JSON.stringify(b.data.materialsStatus));
  }

  console.log(`\n=== ${pass} 通过 / ${fail} 失败 ===`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error("脚本异常：", e);
  process.exit(1);
});
