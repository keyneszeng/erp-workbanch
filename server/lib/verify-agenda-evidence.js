"use strict";
/**
 * Shared normalization for verification steps 2 and 4.
 * A speaker-photo's user-visible filename identifies its speaker; OCR of the
 * image pixels cannot reliably establish an identity. Never use fuzzy/substring
 * name matching, which silently accepts swapped and extra photos.
 */
const ocr=require("./ocr-engine");
const IMAGE_EXT=/\.(?:jpe?g|png|webp|gif|heic|bmp)$/i;
const NAME_TITLES=/(?:主任医师|副主任医师|主治医师|副教授|教授|博士|主任|医生|医师|老师)$/u;
const PHOTO_TAGS=/(?:讲者照片|专家照片|讲师照片|人物照片|照片|photo|speaker|讲者|讲师|专家|授课者)/giu;
const normalize=x=>String(x??"").normalize("NFKC").replace(/[\u200B-\u200D\uFEFF]/g,"").trim();
function speakerName(value,{filename=false}={}){
 let s=normalize(value);
 if(filename)s=s.replace(IMAGE_EXT,"").replace(/\.[^.\\/]+$/,"");
 s=s.replace(/(?:^|[（(【\[])\s*(?:讲者|讲师|专家|photo|speaker)\s*[）)】\]]?\s*[:：_—-]?\s*/giu,"")
  .replace(/[（(【\[]\s*(?:讲者|讲师|专家)?\s*(?:照片|photo|speaker)\s*[）)】\]]/giu,"")
  .replace(/(?:[_\s—-]*(?:讲者照片|专家照片|讲师照片|照片|photo|speaker))$/giu,"")
  .replace(/[\s\u3000]/g,"").trim();
 // Remove a recognized title only if doing so leaves an actual full name.
 const without=s.replace(NAME_TITLES,"");
 if(without.length>=2)s=without;
 if(s.length<2||s.length>48||/[\/\\|、,，;；:：]/.test(s))return "";
 if(!/^[\u3400-\u9fffA-Za-z.'·-]+$/u.test(s))return "";
 if(/^(?:姓名|讲者|讲师|专家|照片|课程|课题|主题|主持|主办|会议|speaker|photo|image|img|headshot)$/u.test(s))return "";
 return s.toLowerCase();
}
function photoName(material){
 const file=String(material.file_name||"").trim();
 // Older registrations used a placeholder ("speaker.png") while entering
 // the actual speaker name in material.name. Fall back ONLY for such explicit
 // placeholder filenames; never override a real person-named original.
 const generic=/^(?:speaker|photo|image|img|headshot|讲者照片|照片)(?:[-_ ]?\d+)?\.(?:jpe?g|png|webp|gif|heic|bmp)$/iu.test(file);
 if(generic)return speakerName(material.name,{filename:true});
 return speakerName(file||material.name,{filename:true});
}
function agendaSpeakers(text){
 const names=[];
 const add=value=>{
  const name=speakerName(value);
  if(name)names.push(name);
 };
 for(const item of ocr.parseAgenda(text))add(item.speaker);
 // Agenda speaker-only rows have no topic: the existing timetable parser
 // intentionally skips these, but the speaker roster must still find them.
 for(const m of String(text||"").matchAll(/(?:^|\n)[ \t]*(?:讲者|讲师|主讲人|授课人|演讲人|专家)(?:姓名)?[ \t]*[:：][ \t]*([^\n]{2,90})/gu)){
  const raw=m[1].split(/(?:课题|讲题|主题|报告题目)\s*[:：]/u)[0].trim();
  for(const part of raw.split(/[、，,;；]/u))add(part);
 }
 return [...new Set(names)];
}
function compareNames(agendaNames,photoNames){
 const a=agendaNames.map(x=>speakerName(x)).filter(Boolean);
 const b=photoNames.map(x=>speakerName(x)).filter(Boolean);
 const setA=new Set(a),setB=new Set(b);
 const unique=a.length===setA.size&&b.length===setB.size;
 const missing=[...setA].filter(x=>!setB.has(x));
 const extra=[...setB].filter(x=>!setA.has(x));
 const duplicate=[...new Set(b.filter((x,i)=>b.indexOf(x)!==i))];
 const matched=!!a.length&&!!b.length&&unique&&!missing.length&&!extra.length;
 return {matched,missing,extra,duplicate,agendaCount:a.length,photoCount:b.length};
}
function topicKey(raw){
 return normalize(raw).toLowerCase().replace(/^(?:课件主题|授课主题|课题|讲题|主题|题目)\s*[:：]/u,"")
  .replace(/[\s\u3000\u200b，,。.;；：:、"'“”‘’（）()《》【】\-—_·]/gu,"");
}
function agendaTopics(text){
 const all=[...ocr.parseAgenda(text).map(x=>x.topic),...ocr.extractTopics(text)];
 return [...new Map(all.map(x=>[topicKey(x),normalize(x)]).filter(([key])=>key.length>=3)).values()];
}
function courseTopics(text,agenda=[]){
 const first=String(text||"").split(/\r?\n/u).slice(0,20);
 const proposals=ocr.extractTopics(first.join("\n"));
 const candidates=proposals.length?proposals:
  first.slice(0,10).map(s=>s.trim()).filter(s=>s.length>=4&&s.length<=100);
 const known=new Set(agenda.map(topicKey));
 // When an unlabeled slide has a clear full-line title, exact equality is safe;
 // do not accept a substring buried in a slide body.
 const chosen=proposals.length?proposals:candidates.filter(x=>known.has(topicKey(x)));
 return [...new Map(chosen.map(x=>[topicKey(x),normalize(x)]).filter(([key])=>key.length>=3)).values()];
}
module.exports={speakerName,photoName,agendaSpeakers,compareNames,topicKey,agendaTopics,courseTopics};
