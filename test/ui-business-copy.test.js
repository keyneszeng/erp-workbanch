"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const src = (name) => fs.readFileSync(path.join(__dirname, "..", name), "utf8");

test("项目概览与真实材料门禁一致，不能再渲染固定八类完成度", () => {
  const view=src("web/assets/js/pages/project.js");
  assert.match(view,/已上传 \$\{ms\.uploadedCount \|\| 0\} 份有效附件/);
  assert.doesNotMatch(view,/8 - ms\.missing\.length/);
  assert.match(view,/demandRequired/);
  assert.match(view,/paymentComplete/);
});
test("七项核销的可选步骤有明确中性视觉态，不将不适用当失败", () => {
  for(const path of ["web/assets/js/pages/project.js","web/assets/js/pages/verify.js"]){
    assert.match(src(path),/s\.required === false \? "s-na"/);
  }
  assert.match(src("web/assets/app.css"),/\.vstep\.s-na/);
  assert.match(src("web/assets/js/pages/verify.js"),/七项核销 SOP/);
});
test("财务页显示企业赞助收入、分期期次并明确银行不自动转账", () => {
  const finance=src("web/assets/js/pages/finance.js");
  assert.match(finance,/data-finance-jump="incomeWorkbench"/);
  assert.match(finance,/const incomeReadable = /);
  assert.match(finance,/if \(incomeReadable\) renderIncomeWorkbench/);
  assert.match(finance,/金额／期次/);
  assert.match(finance,/银行转账/);
  assert.doesNotMatch(finance,/未通过 6 步核销/);
  assert.match(src("web/assets/js/pages/project.js"),/期次：\$\{esc\(y\.period\)\}/);
});
test("被冻结项目不会显示可修改入口，移动协作角色仅展示已授权操作", () => {
  assert.match(src("web/assets/js/pages/project.js"),/!\["已结算", "已归档"\]\.includes\(p\.status\)/);
  const mini=src("miniprogram/pages/project/index.js");
  assert.match(mini,/verify:exception_approve/);
  assert.match(mini,/contract:approve/);
  assert.match(src("miniprogram/pages/home/index.js"),/contract:approve/);
  assert.match(src("web/assets/js/lib/nav.js"),/contract:approve/);
  assert.match(src("server/lib/rbac.js"),/can\(user, "contract:approve"\)/);
  assert.match(mini,/statusNotes/);
  assert.match(mini,/canMaterials\|\|canApprove/);
});


test("逐页 UI 文字与操作入口符合测试版实际行为", () => {
  const projects=src("web/assets/js/pages/projects.js");
  assert.match(projects,/\{ k: "draft", n: "草稿／待审批" \}/);
  const approvals=src("web/assets/js/pages/approvals.js");
  assert.doesNotMatch(approvals,/api\/export\/projects/);
  assert.match(approvals,/view = b\.dataset\.v; render\(root, \[\]\)/);
  const dashboard=src("web/assets/js/pages/dashboard.js");
  assert.match(dashboard,/reachable\("flow"\) \? .*data-go="flow"/);
  const contracts=src("web/assets/js/pages/contracts.js");
  assert.match(contracts,/opts: \["草稿", "待签署"\]/);
  const materials=src("web/assets/js/pages/materials.js");
  assert.match(materials,/if\(requestId!==rightsRequestId\|\|pidSelect\.value!==pid\)return/);
  assert.match(materials,/esc\(p\.status\)/);
});

test("付款申请可查看已关联收款方资料，合同与劳务均只显示脱敏账户",()=>{
 const picker=src("web/assets/js/lib/payee-picker.js");
 const project=src("web/assets/js/pages/project.js");
 const finance=src("web/assets/js/pages/finance.js");
 assert.match(picker,/data-payee-linked-details/);
 for(const label of ["关联收款方资料（只读）","收款方：","关联金额：","开户行：","银行账号："]){
  assert.ok(picker.includes(label),label);
 }
 assert.match(picker,/x\.maskedAccount/);
 assert.doesNotMatch(picker,/x\.account\b|account_cipher|reveal\(/);
 assert.match(picker,/account\.value=""/);
 assert.match(picker,/bank\.value=""/);
 assert.match(picker,/changeChoice\(\)/);
 assert.match(picker,/seq/);
 assert.match(project,/await bindPayeePicker\(m,pid,false\)/);
 assert.match(finance,/await bindPayeePicker\(m,projects\[0\]\.id,true\)/);
 assert.match(src("server/lib/verified-payees.js"),/maskedAccount:"尾号 "\+account\.slice\(-4\)/);
});

test("核销劳务收款方自动关联开户行及加密银行账号，无需页面填写完整账号",()=>{
 const picker=src("web/assets/js/lib/payee-picker.js");
 const finance=src("web/assets/js/pages/finance.js");
 const project=src("web/assets/js/pages/project.js");
 const payees=src("server/lib/verified-payees.js");
 const api=src("server/api/finance.js");
 assert.match(picker,/bank\.value=x\.bank/);
 assert.match(picker,/account\.readOnly=true/);
 assert.match(picker,/account\.value=""/);
 assert.match(picker,/x\.source==="labor"&&x\.maskedAccount/);
 assert.match(picker,/由服务器安全填入/);
 assert.match(payees,/return \{name:x\.name,amount:x\.amount,bank:x\.bank,account,source:"labor"\}/);
 assert.match(api,/choice\?\.bank \|\| b\.payee_bank/);
 assert.match(api,/choice\?\.account \|\| b\.payee_account/);
 for(const p of [finance,project]){
   assert.match(p,/source\.source!=="labor"/);
 }
 assert.doesNotMatch(picker,/account_cipher|reveal\(/);
});
