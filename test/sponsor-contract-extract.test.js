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
