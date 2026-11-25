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
  assert.match(finance,/data-finance-jump="incomeWorkbench">企业赞助<\/button>/);
  assert.doesNotMatch(finance,/会议收入 · 企业赞助/);
  assert.match(finance,/data-finance-jump="fin-payments">付款登记与凭证/);
  assert.match(finance,/data-finance-jump="fin-settlements">结算与归档/);
  assert.match(finance,/const incomeReadable = /);
  assert.match(finance,/if \(incomeReadable\) renderIncomeWorkbench/);
  assert.match(finance,/付款（勾选）/);
  assert.match(finance,/凭证详情/);
  assert.match(finance,/期次（分期付款填）/);
  assert.match(finance,/银行转账/);
  assert.doesNotMatch(finance,/未通过 6 步核销/);
  assert.match(src("web/assets/js/pages/project.js"),/y\.period/);
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

test("财务直接付款可查看已关联收款方资料，合同与劳务均只显示脱敏账户",()=>{
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
 assert.doesNotMatch(project,/#addPay|async function openPay\(/);
 assert.match(finance,/bindPayeePicker\(form,select\.value,true\)/);
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
 // 申请流程不再采集完整银行账号；财务直接付款需要核对银行账户，
 // 但劳务人员已核验账户仍只由服务端解密，不在前端预填或回显。
 assert.ok(api.includes('choice?.bank?parseBankName(choice.bank):""'));
 assert.ok(api.includes('choice?.account?parseBankAccount(choice.account):""'));
 const exec=src("web/assets/js/lib/payment-execution.js");
 assert.match(exec,/name="payee_bank"/);
 assert.match(exec,/name="payee_account"/);
 assert.match(exec,/\/account/);
 assert.match(finance,/name="payee_account"/);
 assert.match(finance,/data-direct-voucher/);
 assert.match(finance,/data-direct-paid/);
 assert.doesNotMatch(project,/name="payee_account"/);
 assert.doesNotMatch(picker,/account_cipher|reveal\(/);
});

test("核销判定可在线查看原件，第5步展示脱敏账号供人工核对",()=>{
 const judge=src("web/assets/js/lib/verify-ocr-judge.js");
 const css=src("web/assets/app-extra.css");
 // 在线预览窗口：PDF 用 iframe、图片用 img，并保留新窗口打开入口
 assert.match(judge,/data-view=/);
 assert.match(judge,/openViewer/);
 assert.match(judge,/iframe src=/);
 assert.match(judge,/新窗口打开/);
 assert.match(css,/\.fv-box/);
 // 第5步只展示尾号，绝不把完整账号渲染到页面
 assert.match(judge,/laborRecordsMasked/);
 assert.match(judge,/劳务表识别的收款账号（仅显示尾号）/);
 assert.doesNotMatch(judge,/bankAccount|bank_account|account_cipher/);
 assert.doesNotMatch(judge,/不从OCR自动导入付款系统/);
});

test("企业云端电路 LOGO 同步接入网页、微信小程序和浏览器标签",()=>{
  const web=fs.readFileSync(path.join(__dirname,"../web/assets/brand-logo.jpg"));
  const mini=fs.readFileSync(path.join(__dirname,"../miniprogram/assets/brand-logo.jpg"));
  assert.deepEqual(web,mini,"web 和小程序应使用同一份企业 LOGO");
  assert.deepEqual([...web.subarray(0,3)],[0xff,0xd8,0xff],"LOGO 应是可识别的 JPEG 图片");
  assert.equal(web.length,3451,"LOGO 资源应为经过压缩并验证的版本");
  const html=src("web/index.html");
  assert.match(html,/class="brand-logo" src="\/assets\/brand-logo\.jpg"/);
  assert.match(html,/<link rel="icon" type="image\/jpeg" href="\/assets\/brand-logo\.jpg">/);
  const login=src("web/assets/js/pages/login.js");
  assert.match(login,/class="login-brand-logo" src="\/assets\/brand-logo\.jpg"/);
  assert.match(login,/class="login-mobile-brand"/);
  assert.match(src("web/assets/app.css"),/\.brand-logo\{/);
  assert.match(src("web/assets/app-extra.css"),/\.login-brand-logo\{/);
  for(const file of [
    "miniprogram/pages/welcome/index.wxml",
    "miniprogram/pages/home/index.wxml",
    "miniprogram/pages/bind/index.wxml",
    "miniprogram/pages/public-proposal/index.wxml"
  ]){
    assert.match(src(file),/<image[^>]+src="\/assets\/brand-logo\.jpg"/,file);
  }
  assert.doesNotMatch(src("miniprogram/pages/welcome/index.wxml"),/hero-brand-mark/);
  assert.doesNotMatch(src("miniprogram/pages/home/index.wxml"),/hero-brand-mark/);
});


test("会规智云品牌在 Web、小程序、邀请函、导出 PDF 与发布文档中保持一致",()=>{
 const visible=[
  "web/index.html","web/invite.html","web/assets/js/app.js",
  "web/assets/js/pages/login.js","miniprogram/app.json",
  "miniprogram/pages/welcome/index.wxml",
  "miniprogram/pages/invite/index.wxml",
  "miniprogram/project.config.json","miniprogram/README.md","README.md",
  "server/lib/archive-pdf.js","server/lib/material-export-pdf.js",
  "server/lib/prep-invitation.js","server/api/auth.js",
  ".github/workflows/cloudflare-demo-release.yml"
 ];
 const legacyName=new RegExp("会规化"+"会务执行系统");
 for(const file of visible){
  const content=src(file);
  assert.match(content,/会规智云/,file+" 缺少统一品牌");
  assert.doesNotMatch(content,legacyName,file+" 存在旧品牌");
 }
 const html=src("web/index.html");
 assert.match(html,/<title>会规智云<\/title>/);
 assert.match(html,/class="brand-t">会规智云<\/div>/);
 assert.match(src("miniprogram/app.json"),/"navigationBarTitleText":"会规智云"/);
 assert.match(src("miniprogram/pages/invite/index.js"),/会规智云 · /);
 assert.match(src("miniprogram/pages/welcome/index.js"),/会规智云 · /);
 assert.match(src("server/lib/archive-pdf.js"),/setCreator\("会规智云"\)/);
 assert.match(src("server/lib/material-export-pdf.js"),/setCreator\("会规智云"\)/);
 assert.match(src("package.json"),/"description": "会规智云：/);
 assert.match(src("deploy/aliyun/deploy.sh"),/会规智云/);
 assert.match(src("README.md"),/erp-workbanch/,"保留技术仓库名称");
});

test("付款明细导出改为可搜索和多选会议，必须明确选择后 POST，并显示选择数量",()=>{
 const finance=src("web/assets/js/pages/finance.js");
 const server=src("server/api/system.js");
 assert.match(finance,/ep\.onclick = \(\) => openPaymentExport\(focusPid\)/);
 assert.match(finance,/按会议导出付款明细（支持多选）/);
 assert.match(finance,/data-payment-search/);
 assert.match(finance,/data-payment-select-visible/);
 assert.match(finance,/data-payment-clear/);
 assert.match(finance,/selected\.size===0/);
 assert.match(finance,/\[\.\.\.selected\]/);
 assert.match(finance,/method:"POST",body:\{pids:/);
 assert.match(server,/router\.post\("\/api\/export\/payments"/);
 assert.match(server,/selectedPaymentPids\(ctx\)/);
 assert.match(server,/scopeFilter\(ctx\.user\)/);
 assert.match(server,/会议编号/);
 assert.doesNotMatch(finance,/ep\.onclick = \(\) => dl\("\/api\/export\/payments"\)/);
});

test("材料收集统一由类别入口上传，Web 与小程序只关联已签赞助合同",()=>{
 const project=src("web/assets/js/pages/project.js");
 const materials=src("web/assets/js/pages/materials.js");
 const mini=src("miniprogram/pages/materials/index.js");
 const miniView=src("miniprogram/pages/materials/index.wxml");
 const server=src("server/api/verify.js");
 assert.match(project,/\["materials", "材料收集"\]/);
 assert.match(project,/data-material-kind/);
 assert.match(project,/await openMaterial\(root,pid,kind\)/);
 assert.doesNotMatch(project,/id="addMaterial"/);
 assert.match(materials,/canUploadAtStatus\(project\.status\)/);
 assert.doesNotMatch(materials,/UPLOAD_STATUSES/);
 assert.match(materials,/kindSelect\.disabled=!!defaultKind/);
 assert.match(materials,/kindSelect\.disabled=!!defaultKind;/);
 assert.match(materials,/c\.status==="已签署"/);
 assert.match(mini,/x\.status==="已签署"/);
 assert.match(mini,/!retired\.has\(k\)/);
 assert.doesNotMatch(miniView,/历史合同与会务协议资料（只读）/);
 assert.match(server,/RETIRED_MATERIAL_KINDS\.includes\(kind\)/);
 assert.match(materials,/RETIRED_KINDS\.has\(defaultKind\)/);
});
