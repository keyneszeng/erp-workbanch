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
  assert.match(finance,/金额／期次/);
  assert.match(finance,/银行转账/);
  assert.doesNotMatch(finance,/未通过 6 步核销/);
  assert.match(src("web/assets/js/pages/project.js"),/期次：\$\{esc\(y\.period\)\}/);
});
test("被冻结项目不会显示可修改入口，移动协作角色仅展示已授权操作", () => {
  assert.match(src("web/assets/js/pages/project.js"),/!\["已结算", "已归档"\]\.includes\(p\.status\)/);
  const mini=src("miniprogram/pages/project/index.js");
  assert.match(mini,/verify:exception_approve/);
  assert.match(mini,/statusNotes/);
  assert.match(mini,/canMaterials\|\|canApprove/);
});
