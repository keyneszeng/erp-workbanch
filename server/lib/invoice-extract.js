"use strict";
/**
 * Chinese VAT/e-invoice fields from OCR or a document text layer.
 * Never substitute invoice code/check digits for invoice number, or pretax
 * amount/tax amount for the payable tax-inclusive invoice total.
 */
const {moneyValue}=require("./sponsor-contract-extract");
const clean=v=>String(v||"").normalize("NFKC").replace(/\r/g,"")
  .replace(/[\u200b-\u200d\ufeff]/g,"").slice(0,30000);
function lines(text){
 return clean(text).split("\n").map(x=>x.trim()
   .replace(/发\s*票\s*号\s*码/gu,"发票号码")
   .replace(/发\s*票\s*号(?!\s*码)/gu,"发票号")
   .replace(/价\s*税\s*合\s*计/gu,"价税合计")
   .replace(/开\s*票\s*金\s*额/gu,"开票金额")
   .replace(/总\s*金\s*额/gu,"总金额"));
}
function invoiceNumber(raw){
 const s=String(raw||"").normalize("NFKC").replace(/^[\s:：#（(]*|[）)\s]*$/g,"");
 const match=/^(?:No\.?\s*)?([0-9A-Z][0-9A-Z \t-]{5,29})/iu.exec(s);
 if(!match)return "";
 const n=match[1].replace(/[\t ]+/g,"").replace(/-+$/g,"").toUpperCase();
 // Never take a date, invoice code, verification code or unrelated short ID.
 return /^[0-9A-Z][0-9A-Z-]{5,29}$/.test(n)&&
   (/\d/.test(n))?n:"";
}
function extractInvoiceNo(text){
 const found=new Set();
 const rx=/(?:全电发票号码|数电票号码|电子发票号码|发票号码|发票号|票据号码|票据号|开票号码)\s*[:：#]?\s*/gu;
 const rows=lines(text);
 for(let i=0;i<rows.length;i++){
  const line=rows[i];
  for(const m of line.matchAll(rx)){
   const after=line.slice(m.index+m[0].length).split(/(?:发票代码|校验码|开票日期|购买方|销售方|价税合计|合计金额)/u)[0];
   let no=invoiceNumber(after);
   if(!no&&i+1<rows.length&&!/^(?:发票代码|校验码|开票日期|金额|税额|价税合计)/u.test(rows[i+1]))
     no=invoiceNumber(rows[i+1]);
   if(no)found.add(no);
  }
 }
 // Avoid silently picking one of multiple conflicting invoice numbers.
 return found.size===1?[...found][0]:"";
}
function priceCandidates(text){
 const rows=lines(text);
 const matches=[];
 const tags=[
  {rx:/(?:价税合计|价税总计|含税合计|合计含税金额|含税总金额|金额合计(?:\s*[（(]含税[)）])?|总金额(?:\s*[（(]含税[)）]))\s*(?:[（(]\s*(小写|大写)\s*[)）])?\s*[:：]?\s*/gu,rank:4},
  {rx:/(?:开票金额|发票金额|发票总额|发票总金额|含税金额|应付总额|总金额)\s*(?:[（(]\s*(小写|大写)\s*[)）])?\s*[:：]?\s*/gu,rank:3},
  {rx:/(?:合计金额|金额合计)\s*(?:[（(]\s*(小写|大写)\s*[)）])?\s*[:：]?\s*/gu,rank:2},
  {rx:/^金额\s*[:：]\s*/gu,rank:1}
 ];
 for(let i=0;i<rows.length;i++){
  const row=rows[i];
  // Bare "金额" on a VAT invoice is normally pretax, not the gross invoice total.
  if(/^(?:金额|不含税金额)\s*[:：]?/u.test(row)&&/税额|税率|价税合计/u.test(rows.join("\n")))continue;
  for(const tag of tags)for(const m of row.matchAll(tag.rx)){
   let tail=row.slice(m.index+m[0].length).split(/(?:税额|税率|发票号码|发票代码|校验码|购买方|销售方)/u)[0];
   const small=tail.match(/(?:\(?小写\)?|小\s*写)\s*[:：]?\s*(?:人民币|¥)?\s*[\d,.]+/u);
   let value=moneyValue(small?small[0]:tail);
   if(value===null&&i+1<rows.length){
     const next=rows[i+1];
     if(/^(?:\(?小写\)?|\(?大写\)?|人民币|¥|[0-9])/u.test(next))
       value=moneyValue(next);
   }
   if(value!==null)matches.push({value,rank:tag.rank});
  }
 }
 return matches;
}
function extractInvoiceAmount(text){
 const candidates=priceCandidates(text);
 if(!candidates.length)return null;
 const rank=Math.max(...candidates.map(x=>x.rank));
 const values=[...new Set(candidates.filter(x=>x.rank===rank).map(x=>x.value))];
 return values.length===1?values[0]:null;
}
/** Step 6: sum only reliably identified tax-inclusive totals, in cents.
 * A missing, conflicting or unreadable invoice never counts as zero. */
function sumInvoiceAmounts(texts){
 if(!Array.isArray(texts)||!texts.length)return null;
 let totalCents=0;
 for(const text of texts){
  const value=extractInvoiceAmount(text);
  if(value===null||!Number.isSafeInteger(Math.round(value*100)))return null;
  totalCents+=Math.round(value*100);
  if(!Number.isSafeInteger(totalCents))return null;
 }
 return totalCents/100;
}
function extractInvoice(text,meta={}){
 const fields={invoiceNo:extractInvoiceNo(text),amount:extractInvoiceAmount(text)};
 const missing=[];
 if(!fields.invoiceNo)missing.push("发票号码");
 if(fields.amount===null)missing.push("开票金额（价税合计）");
 const truncated=!!meta.truncated;
 return {
  status:missing.length?"待人工补全":"待人工确认",fields,
  note:(missing.length?"无法可靠提取："+missing.join("、")+"，请对照发票原件填写。":
    "已识别发票号码和价税合计金额并自动预填，请核对原件。")+
    (truncated?" 仅扫描前3页，请核对其余页面。":""),
  engine:String(meta.engine||""),mode:String(meta.mode||""),truncated
 };
}
module.exports={extractInvoice,extractInvoiceNo,extractInvoiceAmount,sumInvoiceAmounts};
