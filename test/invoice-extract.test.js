"use strict";
const {test}=require("node:test"),assert=require("node:assert/strict");
const {extractInvoice,extractInvoiceNo,extractInvoiceAmount}=require("../server/lib/invoice-extract");

test("增值税发票：自动提取发票号码及价税合计（不是未税金额/税额）",()=>{
 const result=extractInvoice([
  "增值税电子普通发票",
  "发票代码：044001234567",
  "发票号码：12345678",
  "金额：10000.00  税率：6%  税额：600.00",
  "价税合计（大写）壹万零陆佰元整",
  "价税合计（小写）￥10,600.00",
 ].join("\n"),{mode:"pdf-text",engine:"Poppler pdftotext"});
 assert.deepEqual(result.fields,{invoiceNo:"12345678",amount:10600});
 assert.equal(result.status,"待人工确认");
 assert.match(result.note,/自动预填/);
});
test("数电票20位号码、跨行价税合计及空白排版均可识别",()=>{
 const result=extractInvoice([
  "电子发票（普通发票）",
  "发 票 号 码 ：",
  "25000000000012345678",
  "金额    900.00",
  "税额     54.00",
  "价 税 合 计",
  "（小写） ￥954.00"
 ].join("\n"));
 assert.equal(result.fields.invoiceNo,"25000000000012345678");
 assert.equal(result.fields.amount,954);
});
test("不把发票代码、校验码、税额或不含税金额当发票字段",()=>{
 const f=extractInvoice("发票代码：044001234567\n校验码：88444923456728102239\n金额：1000.00\n税额：60.00");
 assert.equal(f.fields.invoiceNo,"");
 assert.equal(f.fields.amount,null);
 assert.equal(f.status,"待人工补全");
});
test("同字段内容冲突时留空，不猜测发票号或含税金额",()=>{
 assert.equal(extractInvoiceNo("发票号码：12345678\n发票号码：87654321"),"");
 assert.equal(extractInvoiceAmount("价税合计：100元\n价税合计：200元"),null);
});
test("支持标准开票金额及同一号码重复出现",()=>{
 assert.equal(extractInvoiceAmount("开票金额：人民币 2,500.50 元"),2500.5);
 assert.equal(extractInvoiceNo("发票号码：000012345678\n发票号码：000012345678"),"000012345678");
});
test("OCR 页数截断说明以及可识别字段缺失的提示",()=>{
 const r=extractInvoice("发票号码：12345678",{truncated:true,mode:"pdf-ocr"});
 assert.equal(r.fields.invoiceNo,"12345678");
 assert.equal(r.fields.amount,null);
 assert.match(r.note,/前3页/);
 assert.equal(r.truncated,true);
});
