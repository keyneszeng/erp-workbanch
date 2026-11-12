"use strict";
const {test}=require("node:test"),assert=require("node:assert/strict");
const {extractBankReceipt,extractPaymentRef,extractTransferAmount}=
  require("../server/lib/bank-receipt-extract");

test("银行电子回单：自动识别交易流水号和汇款金额，忽略账户余额和手续费",()=>{
  const result=extractBankReceipt([
    "某银行电子回单",
    "付款账号：6222000000001234567",
    "收款账号：6217000000098765432",
    "交易流水号：20261108000098765432",
    "交易金额：人民币 12,345.67 元",
    "账户余额：人民币 900,000.88 元",
    "手续费：5.00",
    "交易状态：交易成功"
  ].join("\n"),{mode:"pdf-text",engine:"Poppler pdftotext"});
  assert.deepEqual(result.fields,{paymentRef:"20261108000098765432",amount:12345.67});
  assert.equal(result.status,"待人工确认");
  assert.match(result.note,/自动预填/);
});
test("银行回单多种流水号写法：交易参考号优先于回单编号，跨行识别",()=>{
  const result=extractBankReceipt([
    "中国银行转账电子凭证",
    "电子回单编号：AB0000012266",
    "交 易 流 水 号：",
    "62210000000009999887",
    "转 账 金 额：",
    "¥8,600.50",
    "支付成功"
  ].join("\n"));
  assert.equal(result.fields.paymentRef,"62210000000009999887");
  assert.equal(result.fields.amount,8600.5);
});
test("单据仅有回单号可回退，但银行账号、日期和订单号不能当流水",()=>{
  assert.equal(extractPaymentRef("银行回单\n回单编号：YH2026000123\n付款账号：6222000012345678"),"YH2026000123");
  assert.equal(extractPaymentRef("银行回单\n付款账号：6222000012345678\n收款账号：6222999987654321\n交易日期：2026-11-08"),"");
  assert.equal(extractPaymentRef("银行回单\n商户订单号：20261108123456789"),"");
});
test("优先实际到账金额，不使用余额、税费或多笔交易金额",()=>{
  assert.equal(extractTransferAmount("银行收款回单\n实际到账金额：1,200.00元\n可用余额：72,000.00元"),1200);
  assert.equal(extractTransferAmount("银行转账回单\n余额：20000.00\n手续费：2.00"),null);
  assert.equal(extractTransferAmount("银行电子回单\n到账时间：2026-11-08 14:55:20\n账户余额：50000.00"),null,
    "不能把到账日期中的年份 2026 误识别成金额");
  assert.equal(extractTransferAmount("银行电子回单\n收入金额：2,500.00元\n入账日期：2026-11-08"),2500);
  assert.equal(extractTransferAmount("银行回单\n交易金额：100.00\n交易金额：200.00"),null);
  assert.equal(extractTransferAmount("银行电子回单\n金额：5,000.00元\n手续费：5.00元"),5000);
  assert.equal(extractTransferAmount("合同金额：8000元\n发票金额：8000元"),null);
});
test("冲突流水号时不猜测，图片文字不完整时允许人工核对",()=>{
  assert.equal(extractPaymentRef("银行流水号：202611081234\n银行流水号：202611081235"),"");
  const result=extractBankReceipt("某银行电子回单\n付款账号：6222000012345678\n手续费：5.00",
    {mode:"pdf-ocr",truncated:true});
  assert.deepEqual(result.fields,{paymentRef:"",amount:null});
  assert.equal(result.status,"待人工补全");
  assert.match(result.note,/前3页/);
});
