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
/**
 * Extract every recognizable person name in the final agenda, including OCR
 * tables, speaker-only rows, numbered lists and text with no lecture topic.
 * When photo names are known, verify their literal presence in the OCR text as
 * a final recall path: "李四" in "李四主任" is sufficient even if the OCR
 * timetable lost its column separators. This is exact-name matching, not fuzzy.
 */
function agendaSpeakers(text,photoNames=[]){
 const source=ocr.cleanText(String(text||""));
 const names=new Set();
 const add=value=>{const name=speakerName(value);if(name)names.add(name);};
 for(const item of ocr.parseAgenda(source))add(item.speaker);
 for(const row of ocr.parseAgendaRows(source))add(row.speaker);
 for(const candidate of ocr.extractNames(source))add(candidate);
 // Labelled speaker/host and bare "姓名" columns commonly survive OCR without a topic.
 const LABEL=/(?:^|[\n\t|｜])\s*(?:讲者|讲师|主讲人|授课人|演讲人|专家|报告人|主持人|姓名)(?:姓名)?\s*[:：\s]+([^\n]{2,100})/gu;
 for(const m of source.matchAll(LABEL)){
   const value=m[1].split(/(?:课题|讲题|主题|报告题目|医院|单位|职务|时间|会议|\bTopic\b)\s*[:：]/iu)[0];
   for(const part of value.split(/[、，,;；|｜\t\s]{1,}/u))add(part);
 }
 // Some OCR engines emit a two-column "姓名    机构" row without a label.
 for(const m of source.matchAll(/(?:^|\n)\s*(?:\d{1,3}[.、．]?\s*)?([\u3400-\u9fff]{2,4}(?:教授|主任|医师|医生|博士|老师)?)\s{2,}[^\n]{2,60}(?:医院|大学|学院|研究所|中心)/gu))
   add(m[1]);
 // Accept only whole-name OCR occurrences (spaces between glyphs are allowed).
 // "张三" must not be accepted from a different person "张三丰教授".
 const normalizedSource=normalize(source).toLowerCase();
 for(const photo of photoNames){
   const name=speakerName(photo);
   if(!name)continue;
   const separated=[...name].map(ch=>/^[a-z\u3400-\u9fff]$/iu.test(ch)?ch:"\\"+ch).join("\\s*");
   const whole=new RegExp("(?:^|[^\\p{Script=Han}A-Za-z])"+separated+
     "(?=$|[^\\p{Script=Han}A-Za-z]|教授|副教授|主任|医师|医生|老师|博士|院长)","iu");
   if(whole.test(normalizedSource))add(name);
 }
 return [...names];
}
/** Every uploaded photo must be present in the agenda; agenda-only people do not block approval. */
function compareNames(agendaNames,photoNames){
 const a=agendaNames.map(x=>speakerName(x)).filter(Boolean);
 const b=photoNames.map(x=>speakerName(x)).filter(Boolean);
 const setA=new Set(a),setB=new Set(b);
 const missing=[...setA].filter(x=>!setB.has(x)); // Agenda names without photos: informational.
 const extra=[...setB].filter(x=>!setA.has(x));   // Uploaded photo not in agenda: fail.
 const duplicate=[...new Set(b.filter((x,i)=>b.indexOf(x)!==i))];
 const matched=!!a.length&&!!b.length&&!extra.length;
 return {matched,missing,extra,duplicate,agendaCount:setA.size,photoCount:b.length};
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
 // Step 4 only reads the first five pages/slides. Each slide may have many
 // OCR lines, so the old 20-line ceiling could miss a title on slide 4 or 5.
 const first=String(text||"").split(/\r?\n/u).slice(0,150);
 const proposals=ocr.extractTopics(first.join("\n"));
 const known=new Set(agenda.map(topicKey));
 const exactLines=first.map(s=>s.trim()).filter(s=>s.length>=4&&s.length<=120)
  .filter(x=>known.has(topicKey(x)));
 // An exact full-line slide title is valid even when earlier slides also have
 // labelled topics. Do not accept a substring of a paragraph or slide body.
 const chosen=[...proposals,...exactLines];
 return [...new Map(chosen.map(x=>[topicKey(x),normalize(x)]).filter(([key])=>key.length>=3)).values()];
}
module.exports={speakerName,photoName,agendaSpeakers,compareNames,topicKey,agendaTopics,courseTopics};
