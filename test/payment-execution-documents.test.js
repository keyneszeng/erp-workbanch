"use strict";
const {test}=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs");
const path=require("node:path");
const read=p=>fs.readFileSync(path.join(__dirname,"..",p),"utf8");

test("会议付款明细不要求重新录入收款银行账户",()=>{
 const finance=read("web/assets/js/pages/finance.js");
 assert.doesNotMatch(finance,/name="payee_account"|name="payee_bank"|directPayForm/);
 assert.match(finance,/confirm_paid:true/);
 assert.match(finance,/data-receipt/);
});

test("财务执行付款从权限校验接口读取原件并可在窗口内预览",()=>{
 const service=read("server/api/finance.js"),files=read("server/api/files.js");
 const widget=read("web/assets/js/lib/payment-execution.js");
 const project=read("web/assets/js/pages/project.js");
 const finance=read("web/assets/js/pages/finance.js");
 assert.match(service,/router.get\("\/api\/payments\/:id\/evidence"/);
 assert.match(service,/assertProjectVisible\(ctx.user,p\)/);
 assert.match(service,/assertCan\(ctx.user,"payment:pay"/);
 assert.match(service,/payee_source_id/);
 assert.match(service,/choice\?\.bank\?parseBankName/);
 assert.match(service,/choice\?\.account\?parseBankAccount/);
 assert.match(files,/can\(ctx.user,"payment:pay"\)/);
 assert.match(widget,/<iframe title=/);
 assert.match(widget,/<img alt=/);
 assert.match(widget,/银行实际转账由财务线下操作/);
 assert.match(widget,/data-verified/);
 assert.ok(widget.includes('encodeURIComponent(id)+"/account"'));
 assert.ok(widget.includes('encodeURIComponent(id)+"/pay"'));
 assert.match(project,/openPaymentExecution\(id,/);
 assert.match(finance,/showPaymentEvidence/);
 assert.match(finance,/<iframe title=/);
 assert.match(finance,/<img alt=/);
 assert.match(service,/payee-evidence/);
 assert.match(read("server/lib/db.js"),/addColumn\("payments", "payee_source_id"/);
});

test("导出付款明细先选择会议并允许多选，表单提交单次带所选会议列表",()=>{
 const frontend=read("web/assets/js/pages/finance.js");
 const backend=read("server/api/system.js");
 assert.match(frontend,/ep\.onclick = \(\) => openPaymentExport\(focusPid\)/);
 assert.match(frontend,/按会议导出付款明细（支持多选）/);
 assert.match(frontend,/data-payment-search/);
 assert.match(frontend,/data-payment-select-visible/);
 assert.match(frontend,/data-payment-clear/);
 assert.match(frontend,/selected\.add/);
 assert.match(frontend,/selected\.size===0/);
 assert.match(frontend,/method:"POST",body:\{pids:\[\.\.\.selected\]\}/);
 assert.match(backend,/router\.post\("\/api\/export\/payments"/);
 assert.match(backend,/selectedPaymentPids\(ctx\)/);
 assert.match(backend,/scopeFilter\(ctx\.user\)/);
 assert.match(backend,/会议编号/);
 assert.doesNotMatch(frontend,/ep\.onclick = \(\) => dl\("\/api\/export\/payments"\)/);
});
