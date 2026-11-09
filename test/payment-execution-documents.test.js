"use strict";
const {test}=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs");
const path=require("node:path");
const read=p=>fs.readFileSync(path.join(__dirname,"..",p),"utf8");

test("合同录入及付款申请均不要求开户行和账号，付款前才补录",()=>{
 const ledger=read("web/assets/js/pages/contracts.js");
 const project=read("web/assets/js/pages/project.js");
 const finance=read("web/assets/js/pages/finance.js");
 const contractModal=ledger.slice(ledger.indexOf("function openCreate("));
 const localContract=project.slice(project.indexOf("function openContract("),project.indexOf("async function payAct(")>project.indexOf("function openContract(")?project.indexOf("async function payAct("):undefined);
 const localRequest=project.slice(project.indexOf("async function openPay("),project.indexOf("function openException(",project.indexOf("async function openPay(")));
 const financeRequest=finance.slice(finance.indexOf("async function openPay("));
 for(const part of [contractModal,localRequest,financeRequest]){
  assert.doesNotMatch(part,/\{ k: "payee_(?:bank|account)", l:/);
 }
 assert.match(localContract,/合同原件/);
 for(const part of [localRequest,financeRequest]){
  assert.match(part,/bindPayeePicker/);
  assert.doesNotMatch(part,/请填写收款方开户行|请填写银行账号/);
 }
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
 assert.match(service,/const payeeBank=choice\?\.bank/);
 assert.match(service,/const payeeAccount=choice\?\.account/);
 assert.match(files,/can\(ctx.user,"payment:pay"\)/);
 assert.match(widget,/<iframe title=/);
 assert.match(widget,/<img alt=/);
 assert.match(widget,/银行实际转账由财务线下操作/);
 assert.match(widget,/data-verified/);
 assert.match(widget,/\/"\+encodeURIComponent\(id\)\+"\/account"/);
 assert.match(widget,/\/"\+encodeURIComponent\(id\)\+"\/pay"/);
 assert.match(project,/openPaymentExecution\(id,/);
 assert.match(finance,/openPaymentExecution\(id,/);
 assert.match(read("server/lib/db.js"),/addColumn\("payments", "payee_source_id"/);
});
