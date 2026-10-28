/**
 * V1.2.20 线上验证：付款页签排在核销后面（**只读**）
 * 运行：node test/ui/cf-v1220.js
 */
const BASE = process.env.ERP_BASE || "https://erp.aibuild.work";

let pass = 0, fail = 0;
const check = (name, ok, extra = "") => {
  if (ok) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}  ${extra}`); }
};

(async () => {
  console.log("\n[1] 前端资源已更新");
  const js = await fetch(`${BASE}/assets/js/pages/project.js`).then((r) => r.text());
  const block = js.slice(js.indexOf("const TABS"), js.indexOf("let tab ="));
  const iMat = block.indexOf('"materials"');
  const iVer = block.indexOf('"verify"');
  const iPay = block.indexOf('"payments"');
  check("材料在核销前", iMat >= 0 && iMat < iVer, block.replace(/\s+/g, " ").slice(0, 160));
  check("核销在付款前", iVer >= 0 && iVer < iPay, block.replace(/\s+/g, " ").slice(0, 160));
  console.log(`      TABS：${block.replace(/\s+/g, " ").slice(0, 200)}`);

  console.log("\n[2] 概览的流程门禁补了付款一行");
  check("有「付款：」门禁行", /付款：/.test(js));
  check("付款行在结算行之前（源码顺序）", js.indexOf("付款：") > 0 && js.indexOf("付款：") < js.indexOf("结算："));

  console.log("\n[3] 服务在线");
  const h = await fetch(`${BASE}/api/health`);
  check("健康检查通过", h.ok);

  console.log(`\n=== ${pass} 通过 / ${fail} 失败 ===`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("脚本异常：", e); process.exit(1); });
