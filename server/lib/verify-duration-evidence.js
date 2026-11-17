"use strict";
/**
 * Parse OCR/native Office attendance duration text, never wall-clock timestamps.
 * "30 minutes" is NOT enough; "30m01s", ">30 minutes", and "0:31:00"
 * when explicitly labelled as a duration are enough.
 */
const normalize=text=>String(text||"").normalize("NFKC").replace(/[ \t\u3000]+/g," ").replace(/小時/g,"小时").replace(/分鐘/g,"分钟");
const NUMBER=String.raw`(?:\d{1,4}(?:\.\d{1,2})?|[零〇一二两三四五六七八九十百半]{1,7})`;
function numeric(raw){
 const value=String(raw||"").trim();
 if(/^\d+(?:\.\d+)?$/.test(value))return Number(value);
 if(value==="半")return 0.5;
 const digits={零:0,〇:0,一:1,二:2,两:2,三:3,四:4,五:5,六:6,七:7,八:8,九:9};
 if(!/^[零〇一二两三四五六七八九十百]+$/.test(value))return NaN;
 const section=part=>{
  if(part==="")return 0;
  if(!part.includes("十"))return [...part].reduce((n,c)=>n*10+(digits[c]??0),0);
  const [hi,lo]=part.split("十");
  if(part.split("十").length!==2)return NaN;
  return (hi?digits[hi]:1)*10+(lo?digits[lo]:0);
 };
 if(value.includes("百")){
  const parts=value.split("百");
  if(parts.length!==2||!(parts[0] in digits))return NaN;
  return digits[parts[0]]*100+section(parts[1].replace(/^零/,""));
 }
 return section(value);
}
function extractDurations(raw){
 const text=normalize(raw);
 const out=[];
 const push=(m,minutes,strict=false)=>{
  if(!Number.isFinite(minutes)||minutes<0)return;
  if(out.some(x=>x.start===m.index&&x.raw===m[0]))return;
  out.push({raw:m[0].trim().slice(0,80),minutes,qualifies:minutes>30||strict,start:m.index});
 };
 // Time-unit phrases: 35分钟, 31 min, 三十五分钟, 0小时31分, 1.5小时.
 const hours=new RegExp("("+NUMBER+")\\s*(?:小时|钟头|hours?|hrs?|h)(?:\\s*("+NUMBER+")\\s*(?:分钟|分|minutes?|mins?|m))?(?:\\s*("+NUMBER+")\\s*(?:秒钟?|seconds?|secs?|s))?","giu");
 for(const m of text.matchAll(hours)){
  const h=numeric(m[1]),min=m[2]?numeric(m[2]):0,sec=m[3]?numeric(m[3]):0;
  push(m,h*60+min+sec/60);
 }
 const minutes=new RegExp("("+NUMBER+")\\s*(?:分钟|分(?!钟)|minutes?|mins?|min|m)(?:\\s*("+NUMBER+")\\s*(?:秒钟?|seconds?|secs?|s))?","giu");
 for(const m of text.matchAll(minutes))push(m,numeric(m[1])+(m[2]?numeric(m[2]):0)/60);
 // "1时20分" can also mean a wall-clock time; accept it only next to
 // an explicit duration label rather than treating every meeting time as long attendance.
 const contextualHours=new RegExp("(?:时长|用时|耗时|累计|持续|在线|观看|参会)\\s*[:：=]?\\s*("+NUMBER+")\\s*时\\s*("+NUMBER+")\\s*分","giu");
 for(const m of text.matchAll(contextualHours))push(m,numeric(m[1])*60+numeric(m[2]));
 // Common screenshots show watch duration as HH:MM[:SS]. Never parse an
 // unlabelled 10:45 wall-clock time as 10 hours 45 minutes.
 const clock=/(?:有效|累计|实际|在线|观看|参会|听课|直播|讲者)?(?:时长|观看时间|持续时间|停留时间|在线时间)\s*[:：=]?\s*(\d{1,3})[:：]([0-5]\d)(?:[:：]([0-5]\d))?/giu;
 for(const m of text.matchAll(clock))push(m,Number(m[1])*60+Number(m[2])+Number(m[3]||0)/60);
 // ">30分钟" and "超过30分钟" assert a strict duration threshold, even
 // without an exact recorded number; do not treat "30分钟以上" as strictly >30.
 const gt=/(?:超过|大于|高于|多于|>|＞)\s*(?:30|三十)\s*(?:分钟|分|minutes?|mins?|min)/giu;
 for(const m of text.matchAll(gt))push(m,30,true);
 return out;
}
module.exports={extractDurations};
