"use strict";
const {test}=require("node:test");
const assert=require("node:assert/strict");
const {extractSponsorContract,extractEnterprise,extractAmount}=require("../server/lib/sponsor-contract-extract");

test("赞助合同 OCR 候选：企业、金额、权益内容一并提取",()=>{
 const input=[
  "企业赞助合作协议",
  "赞助企业名称：广州睿康医疗科技有限公司",
  "合同总金额：人民币￥120,000.00",
  "权益内容：",
  "1. 主会场背景板 LOGO 露出",
  "2. 企业展位展示",
  "付款：合同签署后 30 日内支付"
 ].join("\n");
 const result=extractSponsorContract(input,{mode:"pdf-text",engine:"Poppler pdftotext"});
 assert.equal(result.status,"待人工确认");
 assert.equal(result.fields.enterprise,"广州睿康医疗科技有限公司");
 assert.equal(result.fields.amount,120000);
 assert.deepEqual(result.fields.rightsContent,["主会场背景板 LOGO 露出","企业展位展示"]);
});
test("万、元金额单位转换，冲突金额不得猜测",()=>{
 assert.equal(extractAmount("赞助合同金额：50万元"),500000);
 assert.equal(extractAmount("合同金额：10000元\n合同金额：20000元"),null);
 assert.equal(extractAmount("保证金10000元\n付款第1期1000元"),null);
});
test("无赞助方标记不得把甲乙方或主办单位误当赞助企业",()=>{
 assert.equal(extractEnterprise("甲方：某学术协会\n乙方：广州医疗科技有限公司"),"");
 assert.equal(extractEnterprise("乙方（赞助方）：广州医疗科技有限公司"),"广州医疗科技有限公司");
 const result=extractSponsorContract("甲方：某学术协会\n合同金额：10000元",{truncated:true});
 assert.equal(result.fields.enterprise,"");
 assert.deepEqual(result.fields.rightsContent,[]);
 assert.match(result.note,/后续页/);
});

test("合同台账通用OCR识别签约方及金额",()=>{
 const {extractLedgerContract}=require("../server/lib/sponsor-contract-extract");
 const doc="会议服务合同\n甲方：某医学协会\n乙方：深圳市卓越会务服务有限公司\n合同金额：人民币15万元\n付款方式：分期";
 const found=extractLedgerContract(doc,{mode:"pdf-text"});
 assert.equal(found.fields.vendor,"深圳市卓越会务服务有限公司");
 assert.equal(found.fields.amount,150000);
 const other=extractLedgerContract("签约方：广州睿康医疗科技有限公司\n合同总金额：12000元");
 assert.equal(other.fields.vendor,"广州睿康医疗科技有限公司");
 assert.equal(other.fields.amount,12000);
});

test("OCR 合同常见排版：同一行甲乙方、跨行总额、大写金额",()=>{
 const {extractLedgerContract}=require("../server/lib/sponsor-contract-extract");
 const a=extractLedgerContract("会议服务合同\n甲方：广东省医学会    乙方：深圳市卓越会务服务有限公司\n合同总价：人民币88,000.00元");
 assert.equal(a.fields.vendor,"深圳市卓越会务服务有限公司");
 assert.equal(a.fields.amount,88000);
 assert.doesNotMatch(a.note,/赞助企业|权益内容/);
 const b=extractLedgerContract("企业赞助合同\n甲方（赞助方）：广州睿康医疗科技有限公司\n乙方：广东省医学会\n合同金额\n人民币15万元");
 assert.equal(b.fields.vendor,"广州睿康医疗科技有限公司");
 assert.equal(b.fields.enterprise,"广州睿康医疗科技有限公司");
 assert.equal(b.fields.amount,150000);
 assert.equal(extractAmount("合同金额（含税）：人民币壹拾伍万元整"),150000);
 assert.equal(extractAmount("合同总价：100000元\n合同总价：200000元"),null);
 const amb=extractLedgerContract("甲方：甲科技有限公司\n乙方：乙科技有限公司\n合同总金额：20000元");
 assert.equal(amb.fields.vendor,"");
});
