"use strict";
/**
 * Conservative contract-field extraction from OCR, PDF text layers and native Office text.
 * A preview is a suggestion only; ambiguous parties or prices are intentionally not guessed.
 */
const {parseSponsorRights}=require("./sponsor-rights");

function clean(s){
 return String(s||"").normalize("NFKC").replace(/\r/g,"").replace(/\0/g,"")
   .replace(/[\u200b-\u200d\ufeff]/g,"").trim().slice(0,30000);
}
/**
 * OCR（尤其扫描件）常把中文逐字断开："合 同 金 额 ：" "广 州 康 泰 有 限 公 司"。
 * 这类文本直接解析会同时丢掉金额标签和公司名后缀，签约方还会被错认成乙方。
 *
 * 但不能无条件去空格：同一行并排的「甲方：A 公司    乙方：B 公司」靠空格分界，
 * 压掉就把两个签约方粘成一个。所以只在常规解析拿不到关键字段时，才用这份
 * 「汉字间无空格」的文本重试，两者取字段更全的结果。
 */
function despace(text){
 return String(text||"").replace(/([\u4e00-\u9fa5])[ \t\u00a0\u3000]+(?=[\u4e00-\u9fa5])/g,"$1");
}
function filledCount(r){
 const f=r?.fields||{};
 return [f.vendor,f.enterprise,f.amount].filter(v=>v!==null&&v!==undefined&&v!=="").length;
}
function normalizedLine(raw){
 return String(raw||"").replace(/\u00a0/g," ")
   .replace(/([甲乙])[\t ]+方/gu,"$1方").trim();
}
function company(raw){
 const text=String(raw||"").replace(/^[\s"'“”【】\[（(]+/u,"")
   .replace(/(?:统一社会信用代码|法定代表人|注册地址|联系人|联系电话|地址)\s*[:：]?.*$/u,"").trim();
 const m=/^([\u4e00-\u9fa5A-Za-z0-9·（）()&\s-]{2,95}?(?:有限责任公司|股份有限公司|集团有限公司|有限公司|股份公司|公司|集团|银行|事务所|研究院|合作社))/u.exec(text);
 return m?m[1].replace(/\s+/g,"").trim():"";
}
function organization(raw){
 const c=company(raw);
 if(c)return c;
 const name=String(raw||"").split(/[;\t；,，、]/)[0].trim().replace(/\s+/g,"");
 if(name.length>=3&&name.length<=90&&/^[\u4e00-\u9fa5A-Za-z0-9·（）()-]+$/u.test(name)&&
   /(协会|学会|医院|卫生院|学校|学院|大学|研究所|委员会|基金会|中心|事务所|研究院)$/u.test(name))return name;
 return "";
}
const LABEL=/(?:^|[ \t;；,，])((?:甲|乙)\s*方|合同签约方|签约方|赞助企业名称|赞助企业|赞助商名称|赞助商|赞助单位|赞助方|品牌赞助方|合作赞助方|承包方|承办方|服务提供方|服务方|供应商|合作方)\s*(?:[（(]\s*([^）)]{1,16})\s*[）)])?\s*[:：]\s*/gu;
function labeledParties(text){
 const entries=[];
 for(const raw of clean(text).split("\n")){
   const line=normalizedLine(raw);
   const labels=[...line.matchAll(LABEL)];
   for(let i=0;i<labels.length;i++){
     const m=labels[i],next=labels[i+1];
     const v=line.slice(m.index+m[0].length,next?next.index:undefined).trim();
     const companyName=organization(v);
     if(!companyName)continue;
     entries.push({role:m[1].replace(/\s+/g,""),qualifier:String(m[2]||"").trim(),
       value:companyName});
   }
 }
 return entries;
}
function unique(values){
 const vals=[...new Set(values.filter(Boolean))];
 return vals.length===1?vals[0]:"";
}
function extractEnterprise(text){
 const candidates=labeledParties(text).filter(x=>
   /赞助|出资/.test(x.role+x.qualifier)).map(x=>company(x.value));
 return unique(candidates);
}
/** Contract counterparty: a named party, otherwise the one company opposite a medical society. */
function extractCounterparty(text){
 const rows=labeledParties(text);
 const explicit=rows.filter(x=>/^(?:合同签约方|签约方|供应商|承包方|服务提供方|服务方|承办方)$/.test(x.role));
 const named=unique(explicit.map(x=>x.value));
 if(named)return named;
 if(new Set(explicit.map(x=>x.value)).size>1)return "";
 const parties=rows.filter(x=>x.role==="甲方"||x.role==="乙方");
 const companyA=unique(parties.filter(x=>x.role==="甲方").map(x=>company(x.value)));
 const companyB=unique(parties.filter(x=>x.role==="乙方").map(x=>company(x.value)));
 if(companyA&&companyB){
   // Two commercial companies have no reliable association-side anchor.
   return companyA===companyB?companyA:"";
 }
 if(companyA&&!companyB){
   const other=parties.find(x=>x.role==="乙方");
   return other&&/(协会|学会|医院|基金会|委员会|大学)$/.test(other.value)?companyA:"";
 }
 if(companyB&&!companyA){
   const other=parties.find(x=>x.role==="甲方");
   return !other||/(协会|学会|医院|基金会|委员会|大学)$/.test(other.value)?companyB:"";
 }
 // Non-company institutional counterparties can be captured from clearly labeled 乙方.
 if(parties.length===1&&parties[0].role==="乙方")return parties[0].value;
 return "";
}
function chineseNumber(text){
 const chars=String(text||"").replace(/人民币/g,"").replace(/整|正/g,"");
 if(!/^[零〇一二两三四五六七八九壹贰叁肆伍陆柒捌玖拾佰仟拾佰仟十百千万亿]+$/u.test(chars))return null;
 const digits={零:0,〇:0,一:1,二:2,两:2,三:3,四:4,五:5,六:6,七:7,八:8,九:9,壹:1,贰:2,叁:3,肆:4,伍:5,陆:6,柒:7,捌:8,玖:9};
 const units={十:10,拾:10,百:100,佰:100,千:1000,仟:1000};
 let total=0,section=0,num=0;
 for(const ch of chars){
   if(Object.hasOwn(digits,ch))num=digits[ch];
   else if(Object.hasOwn(units,ch)){section+=(num||1)*units[ch];num=0;}
   else if(ch==="万"||ch==="亿"){
     section+=num;
     total+=section*(ch==="万"?10000:100000000);
     section=0;num=0;
   }else return null;
 }
 const n=total+section+num;
 return n>0&&n<=1e9?n:null;
}
function moneyValue(raw){
 const s=String(raw||"").normalize("NFKC").replace(/，/g,",");
 const m=/(?:人民币|RMB|CNY|¥)?\s*(\d{1,3}(?:,\d{3})+|\d{1,10})(?:\.(\d{1,2}))?\s*(万元|万|元)?/iu.exec(s);
 if(m){
   const n=Number(m[1].replace(/,/g,"")+(m[2]?"."+m[2]:""))*(m[3]&&m[3]!=="元"?10000:1);
   if(Number.isFinite(n)&&n>0&&n<=1e9&&Math.round(n*100)/100===n)return Math.round(n*100)/100;
 }
 const c=/(?:人民币)?([零〇一二两三四五六七八九壹贰叁肆伍陆柒捌玖拾佰仟十百千万亿]+)\s*元/u.exec(s);
 return c?chineseNumber(c[1]):null;
}
function extractAmount(text){
 const tagged=[];
 const lines=clean(text).split("\n").map(normalizedLine);
 const pattern=/(赞助合同(?:总)?金额|合同总金额|赞助总金额|赞助金额|赞助费总额|合同金额|赞助费用|赞助费|合同总价款|合同总价|合同价款|合同总额|协议总金额|协议金额|服务合同金额|服务费总额|费用总额|合计金额|金额合计|价款总计|总计金额|合同费用|合同款项|本合同总价)\s*(?:[(（](?:含税|税前|税后)[)）])?\s*(?:[:：]|为|是|人民币)?\s*/gu;
 for(let i=0;i<lines.length;i++){
   const line=lines[i];
   for(const m of line.matchAll(pattern)){
     let tail=line.slice(m.index+m[0].length).slice(0,100).split(/[;；。]/)[0];
     let value=moneyValue(tail);
     if(value===null){
       // PDF text layers frequently wrap the amount onto the following line.
       const next=lines[i+1]||"";
       if(next&&!/^(?:甲方|乙方|签约方|付款|银行账号|合同编号|合同期限|签订日期)/u.test(next))
         value=moneyValue(next.slice(0,80));
     }
     if(value===null)continue;
     const rank=/^(?:赞助合同|合同总|赞助总|赞助金额|赞助费总额|金额合计|合计金额|价款总计|总计金额)/u.test(m[1])?3:2;
     tagged.push({value,rank});
   }
 }
 if(!tagged.length)return null;
 const high=Math.max(...tagged.map(x=>x.rank));
 const values=[...new Set(tagged.filter(x=>x.rank===high).map(x=>x.value))];
 return values.length===1?values[0]:null;
}
/**
 * Labor agreements often say "劳动报酬 / 劳务报酬" without a "合同金额" label.
 * Only fixed monetary amounts are candidates: salary rates and payment schedules
 * must never be guessed as the total contractual remuneration.
 */
function laborAmountEvidence(text){
 const lines=clean(text).split("\n").map(normalizedLine);
 const labels=/(?:劳动报酬|劳务报酬|劳务费用|劳务费|专家劳务费|专家服务费|专家酬金|专家报酬|讲者报酬|讲师报酬|讲师酬金|讲课费|授课费|劳动合同金额|报酬总额|酬金总额)\s*(?:总额|总金额|金额|合计|共计)?\s*(?:[（(](?:税前|税后|含税|不含税)[）)])?\s*(?:[:：]|为|是)?\s*/gu;
 const values=[];
 let labeled=false;
 for(let i=0;i<lines.length;i++){
  for(const match of lines[i].matchAll(labels)){
   labeled=true;
   const tail=lines[i].slice(match.index+match[0].length).trim().slice(0,100);
   // Rates, not fixed contract totals: there is no safe amount to auto-fill.
   if(/^(?:标准|单价|每(?:月|日|天|年|小时|场|次)|按(?:月|日|天|年|小时|场|次))/.test(tail))continue;
   let value=moneyValue(tail.split(/[;；。]/)[0]);
   if(value===null && !tail){
    const next=(lines[i+1]||"").trim();
    if(next&&!/^(?:甲方|乙方|身份证|合同编号|签订日期|支付方式|付款方式)/.test(next) &&
       !/^(?:标准|单价|每(?:月|日|天|年|小时|场|次)|按(?:月|日|天|年|小时|场|次))/.test(next))
      value=moneyValue(next.slice(0,80));
   }
   if(value!==null)values.push(value);
  }
 }
 const distinct=[...new Set(values)];
 return {detected:labeled,amount:distinct.length===1?distinct[0]:null,ambiguous:distinct.length>1};
}
function extractLaborAmount(text){return laborAmountEvidence(text).amount;}

function sponsorOnce(source,meta){
 const fields={
   enterprise:extractEnterprise(source),amount:extractAmount(source),
   rightsContent:parseSponsorRights(source)};
 const missing=[];
 if(!fields.enterprise)missing.push("赞助企业名称");
 if(fields.amount===null)missing.push("赞助合同金额");
 if(!fields.rightsContent.length)missing.push("权益内容");
 return result(meta,fields,missing);
}
function extractSponsorContract(text,meta={}){
 const source=clean(text);
 const once=sponsorOnce(source,meta);
 if(once.fields.enterprise&&once.fields.amount!==null)return once;
 const alt=despace(source);
 return alt===source?once:(filledCount(sponsorOnce(alt,meta))>filledCount(once)?sponsorOnce(alt,meta):once);
}
function result(meta,fields,missing){
 const truncated=!!meta.truncated;
 const note=(missing.length?"未能可靠识别，请对照原件补全："+missing.join("、")+"。":"已识别并预填，请核对原件。")+
   (truncated?" 当前仅扫描前3页，后续页仍需人工检查。":"");
 return {status:missing.length?"待人工补全":"待人工确认",fields,note,
   engine:String(meta.engine||""),truncated,mode:String(meta.mode||"")};
}
function ledgerOnce(source,meta,options={}){
 const enterprise=extractEnterprise(source);
 const vendor=extractCounterparty(source)||enterprise;
 const labor=laborAmountEvidence(source);
 const generic=extractAmount(source);
 const isLabor=options.category==="劳务专家";
 // For a labor contract, a clear "劳动报酬" is more specific than an unrelated
 // amount (deposit/installment/other party). Conflicting remuneration stays blank.
 const amount=isLabor?(labor.detected?labor.amount:generic):(generic??labor.amount);
 const rightsContent=parseSponsorRights(source);
 const missing=[];
 if(!vendor)missing.push("签约方");
 if(amount===null)missing.push(labor.ambiguous?"合同报酬有多处不同金额，请人工核对":"合同金额／劳动报酬");
 const answer=result(meta,{vendor,enterprise,amount,rightsContent,
  amountSource:amount!==null&&labor.amount===amount?"劳动报酬":"合同金额"},missing);
 return answer;
}
function extractLedgerContract(text,meta={},options={}){
 const source=clean(text);
 const once=ledgerOnce(source,meta,options);
 if(once.fields.vendor&&once.fields.amount!==null)return once;
 const alt=despace(source);
 return alt===source?once:(filledCount(ledgerOnce(alt,meta,options))>filledCount(once)?ledgerOnce(alt,meta,options):once);
}
module.exports={extractSponsorContract,extractEnterprise,extractCounterparty,extractAmount,extractLaborAmount,extractLedgerContract,moneyValue};
