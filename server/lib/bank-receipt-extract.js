"use strict";
/**
 * Bank transfer receipt OCR candidate extraction.
 * A bank account, balance, fee, date or merchant order number is NOT evidence
 * of a transfer amount/reference. Ambiguous candidates are left blank.
 */
const {moneyValue}=require("./sponsor-contract-extract");
const clean=v=>String(v||"").normalize("NFKC").replace(/\r/g,"")
  .replace(/[\u200b-\u200d\ufeff]/g,"").slice(0,30000);
function rows(text){
  return clean(text).split("\n").map(x=>x.trim()
    .replace(/交\s*易\s*流\s*水\s*号/gu,"交易流水号")
    .replace(/银\s*行\s*流\s*水\s*号/gu,"银行流水号")
    .replace(/转\s*账\s*金\s*额/gu,"转账金额")
    .replace(/交\s*易\s*金\s*额/gu,"交易金额")
    .replace(/回\s*单\s*编\s*号/gu,"回单编号"));
}
const REF_TAG=/((?:银行|转账|转款|付款|汇款|收款|入账|交易|业务|支付)(?:流水|序列|参考)(?:号码|编号|号)?|(?:银行|交易|业务|转账|转款|支付)(?:交易)?(?:编号|序号)|(?:交易|银行|支付)参考(?:号码|编号|号)|流水(?:号码|编号|号)|电子回单(?:编号|号码|号)|回单(?:编号|号码|号)|凭证(?:编号|号码|号))\s*(?:[:：#]|为|是)?\s*/gu;
const BLOCKED_REF=/^(?:账号|账户|帐号|卡号|户名|开户|收款账户|付款账户|对方账户|余额|校验码|验证码|订单号|合同号|手机号|身份证|银行号)/u;
const OTHER_TAG=/(?:付款账号|付款账户|收款账号|收款账户|对方账号|对方账户|开户银行|银行账号|银行账户|客户账号|账户余额|账户名称|本次金额|交易金额|金额|交易日期|交易时间|交易状态|人民币|账户名|回单编号|电子回单编号|流水号|交易流水号|业务流水号|交易序号)\s*[:：]/gu;
function validReference(raw){
  const s=String(raw||"").normalize("NFKC").replace(/^[\s:：#【\[（(]+/u,"");
  const m=/^([A-Za-z0-9][A-Za-z0-9 _./-]{4,79})/u.exec(s);
  if(!m)return "";
  const ref=m[1].trim().replace(/[ \t]+/g,"").replace(/[.，,;；。、]+$/g,"").toUpperCase();
  if(!/^[A-Z0-9][A-Z0-9_./-]{4,79}$/.test(ref))return "";
  if(!/[0-9]/.test(ref)||/^\d{4}[-/]\d{1,2}[-/]\d{1,2}$/.test(ref))return "";
  if(/^(?:RMB|CNY|USD|NO|ACCOUNT|N\/A)$/i.test(ref))return "";
  return ref;
}
function referenceRank(tag){
  if(/(?:银行流水|交易流水|业务流水|转账流水|转款流水|付款流水|汇款流水|入账流水|支付流水|交易参考|银行参考|支付参考)/u.test(tag))return 4;
  if(/(?:交易序号|交易编号|银行编号|业务编号|转账编号|流水|序列)/u.test(tag))return 3;
  return 2;
}
function extractPaymentRef(text){
  const found=[];
  const parts=rows(text);
  for(let i=0;i<parts.length;i++){
    const line=parts[i];
    for(const m of line.matchAll(REF_TAG)){
      const tag=m[1],tail=line.slice(m.index+m[0].length);
      if(BLOCKED_REF.test(tag))continue;
      const boundary=[...tail.matchAll(OTHER_TAG)][0];
      const segment=(boundary?tail.slice(0,boundary.index):tail).trim();
      let value=validReference(segment);
      if(!value&&i+1<parts.length){
        const next=parts[i+1];
        if(!/^[\u4e00-\u9fa5]{2,12}\s*[:：]/u.test(next))value=validReference(next);
      }
      if(value)found.push({value,rank:referenceRank(tag)});
    }
  }
  if(!found.length)return "";
  const rank=Math.max(...found.map(x=>x.rank));
  const values=[...new Set(found.filter(x=>x.rank===rank).map(x=>x.value))];
  return values.length===1?values[0]:"";
}
const AMOUNT_TAG=/((?:(?:本次|实际|成功|已)?(?:到账|入账|收款|回款|汇款|转账|转款|付款|支付|交易|转入|转出)(?:金额|数额)|(?:实收|实付)(?:金额)?|(?:入账|到账|汇出|汇入|收入)金额|交易币种及金额|转账币种及金额|银行转账金额|人民币金额|本次交易金额|交易金额|交易总金额|回单金额|汇款数额))\s*(?:[（(](?:人民币|元|CNY|RMB)[）)])?\s*(?:[:：]|为|是)?\s*/gu;
const FALLBACK=/^(?:金额|交易额|汇款额|转账额|转出金额|转入金额)\s*(?:[（(](?:元|人民币|CNY|RMB)[）)])?\s*[:：]\s*/u;
const BLOCKED_AMOUNT=/^(?:余额|可用余额|账户余额|手续费|服务费|附加费|费用合计|贷款余额|应付|合同金额|信用额度|汇率|税额|累计金额|本年累计)/u;
function amountCandidates(text){
  const parts=rows(text),found=[];
  for(let i=0;i<parts.length;i++){
    const line=parts[i];
    if(BLOCKED_AMOUNT.test(line))continue;
    const tags=[...line.matchAll(AMOUNT_TAG)].map(m=>({index:m.index,after:m.index+m[0].length,rank:4}));
    const bare=FALLBACK.exec(line);
    if(bare)tags.push({index:0,after:bare[0].length,rank:1});
    for(const tag of tags){
      let tail=line.slice(tag.after).split(/(?:账户余额|可用余额|手续费|服务费|备注|用途|户名|收款账号|付款账号|收款账户|付款账户|交易时间|交易日期|交易流水号|银行流水号|流水号)/u)[0];
      let value=moneyValue(tail);
      if(value===null&&i+1<parts.length){
        const next=parts[i+1];
        if(/^(?:(?:人民币|CNY|RMB|¥|￥)\s*)?(?:[\d,]+(?:\.\d{1,2})?\s*(?:元|万元|万)?|[壹贰叁肆伍陆柒捌玖拾佰仟万亿零整正]+元)/iu.test(next))
          value=moneyValue(next);
      }
      if(value!==null)found.push({value,rank:tag.rank});
    }
  }
  // Only use bare 金额 when the document unambiguously identifies itself as
  // a bank transaction/receipt, never an unrelated contract or invoice.
  const transferEvidence=/(?:银行|网上银行|电子回单|转账|转款|汇款|收款回单|付款回单|交易流水|银行流水|交易成功|银行电子凭证)/u.test(clean(text));
  const eligible=transferEvidence?found:found.filter(x=>x.rank>=4);
  if(!eligible.length)return [];
  const top=Math.max(...eligible.map(x=>x.rank));
  return eligible.filter(x=>x.rank===top).map(x=>x.value);
}
function extractTransferAmount(text){
  const values=[...new Set(amountCandidates(text))];
  return values.length===1?values[0]:null;
}
function extractBankReceipt(text,meta={}){
  const fields={paymentRef:extractPaymentRef(text),amount:extractTransferAmount(text)};
  const missing=[];
  if(!fields.paymentRef)missing.push("银行交易流水号");
  if(fields.amount===null)missing.push("实际转款金额");
  const truncated=!!meta.truncated;
  return {status:missing.length?"待人工补全":"待人工确认",fields,
    note:(missing.length?"无法可靠识别："+missing.join("、")+"，请对照银行转账原件人工填写。":
      "已识别银行流水号码和转款金额并自动预填，请核对交易是否实际到账。")+
      (truncated?" 仅检查了前3页，请核对剩余页面。":""),
    engine:String(meta.engine||""),mode:String(meta.mode||""),truncated};
}
module.exports={extractBankReceipt,extractPaymentRef,extractTransferAmount};
