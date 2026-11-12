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

test("扫描件 OCR 逐字空格：标签与公司名仍能识别，且不会错取乙方",()=>{
 const {extractLedgerContract}=require("../server/lib/sponsor-contract-extract");
 // 真实扫描件经 RapidOCR 后常见形态：每个汉字之间被插入空格
 const r=extractLedgerContract(
  "甲 方 ： 广 州 康 泰 医 药 有 限 公 司\n乙 方 ： 广 东 省 医 学 会\n合 同 金 额 ： 300000 元");
 assert.equal(r.fields.vendor,"广州康泰医药有限公司","签约方应为甲方公司，不能被错认成乙方协会");
 assert.equal(r.fields.amount,300000);
 assert.equal(r.status,"待人工确认");
});

test("逐字空格不能破坏同一行并排的甲乙方",()=>{
 const {extractLedgerContract}=require("../server/lib/sponsor-contract-extract");
 const r=extractLedgerContract(
  "甲方：广东省医学会    乙方：深圳市卓越会务服务有限公司\n合同总价：人民币88,000.00元");
 assert.equal(r.fields.vendor,"深圳市卓越会务服务有限公司");
 assert.equal(r.fields.amount,88000);
});

test("劳动报酬／劳务报酬金额用于劳务合同 OCR 自动预填",()=>{
 const {extractLaborAmount,extractLedgerContract}=require("../server/lib/sponsor-contract-extract");
 const text=[
   "专家劳务合同",
   "甲方：广东省医学会",
   "乙方：张三",
   "劳动报酬（税前）：人民币12,600.50元",
   "付款第1期：3000元",
   "保证金：500元"
 ].join("\n");
 assert.equal(extractLaborAmount(text),12600.50);
 const result=extractLedgerContract(text,{}, {category:"劳务专家"});
 assert.equal(result.fields.amount,12600.5);
 assert.equal(result.fields.amountSource,"劳动报酬");
 assert.match(result.note,/签约方/,"个人姓名缺少可靠角色证据时应提示人工补填，但金额仍需正确预填");
 assert.equal(extractLaborAmount("劳务报酬总额：1.25万元"),12500);
 assert.equal(extractLaborAmount("专家劳务费：人民币壹万贰仟元整"),12000);
 assert.equal(extractLaborAmount("讲课费：人民币800元"),800);
});
test("劳务专家 OCR 优先明确劳动报酬，避免误把其他合同条款金额写入",()=>{
 const {extractLedgerContract,extractLaborAmount}=require("../server/lib/sponsor-contract-extract");
 const sample="合同总金额：人民币20,000元\n劳务报酬：人民币18,000元\n第一期支付：人民币2,000元";
 assert.equal(extractLedgerContract(sample,{}, {category:"劳务专家"}).fields.amount,18000);
 assert.equal(extractLedgerContract(sample).fields.amount,20000);
 assert.equal(extractLaborAmount("劳动报酬标准：每月 5000元\n合作期限：12个月"),null);
 assert.equal(extractLaborAmount("专家报酬总额：1000元\n专家报酬总额：1200元"),null);
 const ambiguous=extractLedgerContract("劳务报酬：1000元\n劳动报酬：1200元\n合同金额：5000元",{}, {category:"劳务专家"});
 assert.equal(ambiguous.fields.amount,null);
 assert.match(ambiguous.note,/多处不同金额/);
});
test("劳动报酬跨行／OCR汉字间空格可以读取，非报酬数字不被误识别",()=>{
 const {extractLedgerContract}=require("../server/lib/sponsor-contract-extract");
 const wrapped=extractLedgerContract("劳务报酬：\n人民币12,800元",{}, {category:"劳务专家"});
 assert.equal(wrapped.fields.amount,12800);
 const spaced=extractLedgerContract("劳 务 报 酬 ： 15000 元",{}, {category:"劳务专家"});
 assert.equal(spaced.fields.amount,15000);
 const unsupported=extractLedgerContract("劳动报酬标准：每场1000元\n合同期限：2027年",{}, {category:"劳务专家"});
 assert.equal(unsupported.fields.amount,null);
});
