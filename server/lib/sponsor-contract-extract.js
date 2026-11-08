"use strict";
/**
 * 从 OCR / PDF 文本层 / Office 原生文本提取赞助合同字段。
 * 仅提取有明确标签的候选信息；无法确认或出现冲突时留空供人工核对。
 */
const {parseSponsorRights}=require("./sponsor-rights");

function clean(s){
  return String(s||"").normalize("NFKC").replace(/\r/g,"").replace(/\0/g,"").trim().slice(0,30000);
}
function company(raw){
  const s=String(raw||"").replace(/^[\s"'“”【】\[（(]+/u,"")
    .replace(/(?:统一社会信用代码|法定代表人|注册地址|联系人|联系电话|地址)\s*[:：]?.*$/u,"").trim();
  const m=/^([\u4e00-\u9fa5A-Za-z0-9·（）()&\s-]{2,95}?(?:有限责任公司|股份有限公司|集团有限公司|有限公司|股份公司|公司|集团|银行))/u.exec(s);
  return m?m[1].replace(/\s+/g,"").trim():"";
}
function extractEnterprise(text){
  const candidates=new Set();
  for(const line of clean(text).split("\n")){
    // 不从无角色标记的“甲方/乙方”推断企业，以免把主办单位错认为赞助商。
    const m=/^(?:(?:甲方|乙方)\s*[（(]\s*(?:赞助方|赞助商|赞助企业|出资方)\s*[)）]|(?:赞助企业名称|赞助企业|赞助商名称|赞助商|赞助单位|赞助方|品牌赞助方|合作赞助方))\s*[:：]\s*(.{2,120})$/u.exec(line.trim());
    if(m){
      const v=company(m[1]);
      if(v)candidates.add(v);
    }
  }
  return candidates.size===1?[...candidates][0]:"";
}
function moneyValue(raw){
  const s=String(raw||"").replace(/，/g,",").replace(/￥/g,"¥");
  const m=/(?:人民币|RMB|¥)?\s*(\d{1,3}(?:,\d{3})+|\d{1,10})(?:\.(\d{1,2}))?\s*(万元|万|元)?/iu.exec(s);
  if(!m)return null;
  const n=Number(m[1].replace(/,/g,"")+(m[2]?"."+m[2]:""))*(m[3]&&m[3]!=="元"?10000:1);
  if(!Number.isFinite(n)||n<=0||n>1e9||Math.round(n*100)/100!==n)return null;
  return Math.round(n*100)/100;
}
function extractAmount(text){
  const tagged=[];
  const pattern=/(赞助合同(?:总)?金额|合同总金额|赞助总金额|赞助金额|赞助费总额|合同金额|赞助费用|赞助费|合同总价|合计金额)\s*[:：]?\s*/gu;
  for(const line of clean(text).split("\n")){
    for(const m of line.matchAll(pattern)){
      const tail=line.slice(m.index+m[0].length).slice(0,75).split(/[；;。]/)[0];
      const v=moneyValue(tail);
      if(v===null)continue;
      const rank=/^(赞助合同|合同总|赞助总|赞助金额|赞助费总额)/u.test(m[1])?2:1;
      tagged.push({v,rank});
    }
  }
  if(!tagged.length)return null;
  const rank=Math.max(...tagged.map(x=>x.rank));
  const values=[...new Set(tagged.filter(x=>x.rank===rank).map(x=>x.v))];
  // 不确定究竟是总额还是分期款时，宁可空白。
  return values.length===1?values[0]:null;
}
function extractSponsorContract(text,meta={}){
  const source=clean(text);
  const fields={
    enterprise:extractEnterprise(source),
    amount:extractAmount(source),
    rightsContent:parseSponsorRights(source)
  };
  const missing=[];
  if(!fields.enterprise)missing.push("赞助企业名称");
  if(fields.amount===null)missing.push("赞助合同金额");
  if(!fields.rightsContent.length)missing.push("权益内容");
  const truncated=!!meta.truncated;
  const note=(missing.length?"以下信息未能可靠提取，请核对原件并手工填写："+missing.join("、")+"。":"三项信息已提取，请核对原件。")
    +(truncated?" 当前仅扫描前3页，后续页仍需人工检查。":"");
  return {status:missing.length?"待人工补全":"待人工确认",fields,note,
    engine:String(meta.engine||""),truncated,mode:String(meta.mode||"")};
}
module.exports={extractSponsorContract,extractEnterprise,extractAmount,moneyValue};
