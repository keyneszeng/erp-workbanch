"use strict";
/**
 * 劳务表收款记录提取。
 *
 * 输入：劳务表原件的 OCR 文本，或 XLSX/CSV 的原生文本提取结果。
 * 输出：{records:[{name,time,role,amount,bankAccount,bankName}],skipped,rows,mode}
 *
 * 真实劳务表常同时含「身份证号码 / 手机号码 / 银行卡号」三列数字，
 * 金额也有「应税金额 / 个税 / 实发数」多列。所以优先按表头定位列，
 * 绝不能按「最长数字串」猜，否则会把身份证号当银行账号、把税前金额当劳务费。
 *
 * 原则是「宁缺勿错」：姓名、银行账号、金额三者缺一项就跳过该行。
 * 账号原文只在服务端内存中使用，落库前由 verified-payees 做 AES-GCM 加密；
 * 对外（报告 / 页面 / 审计）一律只给尾号。
 */

// OCR 常把中文逐字断开（"张 老 师"）。只压「汉字-空格-汉字」，
// 不能包含 \t：制表符是表格列分隔符，压掉会把两列粘成一列。
const CJK_GAP=/([\u4e00-\u9fa5])[ \u00a0\u3000]+(?=[\u4e00-\u9fa5])/g;
const DATE=/(20\d{2})\s*[-/年.]\s*(\d{1,2})\s*[-/月.]\s*(\d{1,2})\s*日?/;
const BANK=/([\u4e00-\u9fa5]{2,18}(?:银行|信用社|支行|分行|营业部))/;
const ROLE=/(讲者|主持|专家|嘉宾|翻译|会务|主席|授课|讲演|讲师)/;
const HEADER_WORDS=[/姓\s*名/,/账\s*号|帐\s*号|开户行/,/金\s*额|劳务费/,/时\s*间|日\s*期/,
 /角\s*色/,/合\s*计|序\s*号/,/备\s*注/];
const isHeader=line=>HEADER_WORDS.filter(re=>re.test(String(line||""))).length>=2;
const NOT_NAME=/^(?:姓名|时间|日期|角色|金额|银行账号|开户行|备注|合计|序号|劳务费|人民币|元)$/;
const SPLIT=/\t|\||,|，|;|；|\s{2,}/;

function clean(s){
 return String(s||"").normalize("NFKC").replace(/\r/g,"").replace(/\0/g,"")
  .replace(/[\u200b-\u200d\ufeff]/g,"")
  .replace(CJK_GAP,"$1")
  .trim().slice(0,30000);
}
const onlyDigits=s=>String(s||"").replace(/\D/g,"");
const validAccount=d=>d.length>=10&&d.length<=25;
const validName=n=>/^[\u4e00-\u9fa5·]{2,6}$/.test(String(n||"").trim());
const splitCells=line=>String(line||"").split(SPLIT).map(x=>x.trim());

/** 按表头定位列，解析 XLSX/CSV/带表头的表格文本。 */
function parseByHeader(lines){
 const hi=lines.findIndex(l=>splitCells(l).some(c=>/^(?:姓名|讲者姓名|专家姓名|收款人姓名)$/.test(c)));
 if(hi<0)return null;
 const head=splitCells(lines[hi]);
 const find=re=>head.findIndex(c=>re.test(c));
 const nameIdx=find(/^(?:姓名|讲者姓名|专家姓名|收款人姓名)$/);
 const accountIdx=find(/(?:银行卡号|银行帐号|银行账号|银行帐户|帐号|账号|卡号)/);
 if(nameIdx<0||accountIdx<0)return null;
 const bankIdx=find(/开户行|开户银行|银行名称/);
 const timeIdx=find(/^(?:时间|日期|发放日期|服务时间)$/);
 const roleIdx=find(/^(?:角色|职务|身份|类别)$/);
 // 金额：优先「实发数/实发金额」（与劳务合同金额口径一致），
 // 其次普通金额列；明确排除个税、增值税、附加税列。
 const moneyCols=head.map((c,i)=>({c,i}))
  .filter(x=>/(?:金额|劳务费|实发|应付|课酬|酬金)/.test(x.c)&&!/(?:个税|增值税|附加税|税率)/.test(x.c));
 const net=moneyCols.find(x=>/实发|应付|实付/.test(x.c));
 const amountIdx=net?net.i:(moneyCols.length?moneyCols[0].i:-1);
 const records=[],seen=new Set();
 let skipped=0;
 for(const line of lines.slice(hi+1)){
  if(/^工作表\s*\d+/.test(line))continue;
  if(isHeader(line))continue;
  if(!/\d/.test(line))continue;
  const cs=splitCells(line);
  const name=String(cs[nameIdx]||"").trim();
  const bankAccount=onlyDigits(cs[accountIdx]||"");
  const amountRaw=amountIdx>=0?String(cs[amountIdx]||"").replace(/[^\d.]/g,""):"";
  const amount=Number(amountRaw);
  if(!validName(name)||!validAccount(bankAccount)||!Number.isFinite(amount)||amount<=0){
   // 只有「姓名列确实是个姓名」的行才算漏项需人工补录；
   // 工作表标题、表头、合计行不计入，否则 6 人表会误报 7 行待补录。
   if(validName(name)&&!NOT_NAME.test(name))skipped++;
   continue;
  }
  const bankName=bankIdx>=0?String(cs[bankIdx]||"").trim():"";
  const time=timeIdx>=0?dateOf(cs[timeIdx]||""):dateOf(line);
  const role=roleIdx>=0?String(cs[roleIdx]||"").trim():roleOf(line);
  const key=name+"\u001f"+bankAccount;
  if(seen.has(key)){skipped++;continue;}
  seen.add(key);
  records.push({name,time,role,amount,bankAccount,bankName});
 }
 return {records,skipped,rows:lines.length,mode:"header"};
}

function dateOf(text){
 const m=String(text||"").match(DATE);
 if(!m)return "";
 return `${m[1]}-${String(Number(m[2])).padStart(2,"0")}-${String(Number(m[3])).padStart(2,"0")}`;
}
function roleOf(line){
 const m=String(line||"").match(ROLE);
 return m?m[1]:"";
}
function bankOf(line){
 const m=String(line||"").match(BANK);
 return m?m[1]:"";
}
/**
 * 把已识别出的账号从行里剔除。
 * 不能用 /(?:\d[\s-]?){10,25}/ 粗暴匹配：\s 含制表符，会把「1200\t6222…」
 * 当成一个 20 位数字一起吞掉，金额就取不到了。
 */
function withoutAccount(text,account){
 const d=onlyDigits(account);
 if(d.length<6)return String(text||"");
 return String(text||"").replace(new RegExp(d.split("").join("[\\s\\-—－]?"),"g")," ");
}
function amountOf(text,account){
 const t=withoutAccount(String(text||"").replace(DATE," "),account);
 const found=[...t.matchAll(/(?:¥|￥|RMB|人民币)?\s*(\d{1,7}(?:\.\d{1,2})?)\s*(?:元)?/g)]
  .map(m=>Number(m[1])).filter(x=>Number.isFinite(x)&&x>0&&x<=1e7);
 return found.length?found[found.length-1]:null;
}
/** 无表头文本：按数字长度排除身份证(18)与手机号(11)，优先 16/19 位银行卡。 */
function accountOf(line){
 const cs=splitCells(line);
 for(const c of cs){
  const d=onlyDigits(c);
  if(validAccount(d)&&/^[\d\s\-—－Xx]+$/.test(c)&&!/[Xx]/.test(c)&&d.length>=16)return d;
 }
 const runs=[...String(line||"").matchAll(/(?<!\d)(\d{10,25})(?!\d)/g)].map(m=>m[1]);
 const good=runs.filter(d=>d.length!==11&&d.length!==18);
 const pool=good.length?good:runs;
 if(!pool.length)return "";
 return pool.sort((a,b)=>
  (b.length===16||b.length===19)-(a.length===16||a.length===19)||b.length-a.length)[0];
}
function nameOf(line,account){
 let s=withoutAccount(String(line||""),account);
 s=s.replace(DATE," ").replace(BANK," ").replace(ROLE," ");
 s=s.replace(/\d+(?:\.\d+)?/g," ");
 s=s.replace(/[|,，;；:：]/g," ");
 for(const token of s.split(/\s+/).filter(Boolean)){
  const t=token.replace(/[^\u4e00-\u9fa5·]/g,"");
  if(t.length<2||t.length>6||NOT_NAME.test(t))continue;
  if(/(银行|支行|分行|信用社|营业部|劳务|合计|小计)/.test(t))continue;
  return t;
 }
 return "";
}
function parseLine(raw){
 const line=clean(raw);
 if(!line)return null;
 if(isHeader(line)&&!/\d{12,}/.test(line))return null;
 const bankAccount=accountOf(line);
 if(!bankAccount)return null;
 const amount=amountOf(line,bankAccount);
 if(!amount)return null;
 const name=nameOf(line,bankAccount);
 if(!name)return null;
 return {name,time:dateOf(line),role:roleOf(line),amount,bankAccount,bankName:bankOf(line)};
}
function extractLaborRecords(text){
 const lines=clean(text).split("\n").map(x=>x.trim()).filter(Boolean);
 const byHeader=parseByHeader(lines);
 if(byHeader&&byHeader.records.length)return byHeader;
 // 退化：无表头 / 表头无法定位列时按行猜测，只取信息齐全的行。
 const records=[],seen=new Set();
 let skipped=0;
 for(const line of lines){
  if(isHeader(line)&&!/\d{12,}/.test(line))continue;
  const row=parseLine(line);
  if(!row){
   // 标题、说明等没有长数字的行不算「未导入」；只有疑似账号行才提示人工补录。
   if(/\d{10,}/.test(line))skipped++;
   continue;
  }
  const key=row.name+"\u001f"+row.bankAccount;
  if(seen.has(key)){skipped++;continue;}
  seen.add(key);
  records.push(row);
 }
 return {records,skipped,rows:lines.length,mode:"line"};
}
const mask=account=>{
 const d=onlyDigits(account);
 return d.length>=4?"尾号 "+d.slice(-4):"";
};
module.exports={extractLaborRecords,mask,parseLine,clean};
