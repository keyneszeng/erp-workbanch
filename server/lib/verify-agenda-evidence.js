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
 return normalize(raw).toLowerCase().replace(/^(?:课件主题|授课主题|课题|讲题|主题|题目|课程名称|课件名称|报告题目|授课题目|演讲题目)\s*[:：]/u,"")
  .replace(/[\s\u3000\u200b，,。.;；：:、"'“”‘’（）()《》【】\-—_·]/gu,"");
}
function agendaTopics(text){
 const all=[...ocr.parseAgenda(text).map(x=>x.topic),...ocr.extractTopics(text)];
 return [...new Map(all.map(x=>[topicKey(x),normalize(x)]).filter(([key])=>key.length>=3)).values()];
}
function courseTopics(text,agenda=[]){
 // Only the cover page/first slide is supplied here. Titles are often
 // unlabelled, or broken across two OCR lines.
 const lines=String(text||"").split(/\r?\n/u).slice(0,150)
  .map(s=>s.trim()).filter(Boolean);
 const known=new Set(agenda.map(topicKey));
 const LABEL=/^(?:课件主题|授课主题|课题|讲题|主题|题目|课程名称|课件名称|报告题目|授课题目|演讲题目)\s*[:：]/u;
 const clean=s=>String(s||"").replace(LABEL,"").trim();
 // Labels are reliable even when the topic was not in the agenda.
 const proposals=[...ocr.extractTopics(lines.join("\n"))];
 for(const line of lines){
  if(LABEL.test(line))proposals.push(clean(line));
 }
 // Exact whole-line (or two adjoining lines) agenda matching catches large
 // cover typography. No substring matching of paragraphs, authors or logos.
 const exact=[];
 for(let i=0;i<lines.length;i++){
  const one=clean(lines[i]);
  if(one.length>=4&&one.length<=120&&known.has(topicKey(one)))exact.push(one);
  if(i+1<lines.length){
   const two=clean(lines[i])+clean(lines[i+1]);
   if(two.length>=4&&two.length<=120&&known.has(topicKey(two)))exact.push(two);
  }
 }
 const chosen=[...proposals,...exact];
 return [...new Map(chosen.map(x=>[topicKey(x),normalize(x)]).filter(([key])=>key.length>=3)).values()];
}

/**
 * The agenda OCR may have the correct lecture title on a plain line or in an
 * OCR table cell while parseAgenda()/extractTopics() fails to classify it.
 * Recover COMPLETE fields only: never search a topic as a substring in prose,
 * a longer lecture title, the speaker's name, or the conference header.
 */
function agendaTitleFields(text){
 const lines=ocr.cleanText(text).split(/\r?\n/u).slice(0,1800).map(s=>s.trim()).filter(Boolean);
 const fields=new Map();
 const label=/^(?:课件主题|授课主题|课题|讲题|主题|题目|课程名称|课件名称|报告题目|授课题目|演讲题目|报告主题)\s*[:：]\s*/iu;
 const time=/^\s*\d{1,2}[:：]\d{2}\s*(?:[-~—–至]\s*\d{1,2}[:：]\d{2})?\s*/u;
 const generic=/^(?:终版议程|会议议程|会议日程|活动安排|会议通知|会议时间|会议地点|主办单位|承办单位|专家介绍|嘉宾介绍|开幕致辞|会议主持|签到|讨论|讨论环节|茶歇|休息|总结|目录|时间|姓名|讲题|课题|主题|报告人)$/u;
 const add=(raw)=>{
  const value=normalize(raw).replace(time,"").replace(label,"").trim();
  const key=topicKey(value);
  if(!key||key.length<4||key.length>120||generic.test(value)||
    /^(?:\d{1,4}|[0-9:：./-]+)$/u.test(value)||
    /^(?:会议名称|主办方|承办方|联系电话|地址|日期|地点)\s*[:：]/u.test(value))return;
  if(!fields.has(key))fields.set(key,value);
 };
 for(const line of lines){
  add(line);
  const cells=line.split(/\t+|\s{2,}|[|｜]/u).map(s=>s.trim()).filter(Boolean);
  if(cells.length>1)for(const cell of cells)add(cell);
  const labelled=line.match(/(?:^|[\t|｜]|\s{2,})(?:课题|讲题|授课主题|报告题目|主题)\s*[:：]\s*([^\t|｜\n]{4,120})/u);
  if(labelled)add(labelled[1]);
 }
 // Two OCR rows may split one heading without any separator. Only accept
 // adjacency as an entire title; do not generate arbitrary longer paragraphs.
 for(let i=0;i+1<lines.length;i++){
  if(lines[i].length<=60&&lines[i+1].length<=60)
   add(lines[i]+lines[i+1]);
 }
 return [...fields.values()];
}
function compareCourseAgenda(agendaText,courseText){
 const structured=agendaTopics(agendaText);
 const literal=agendaTitleFields(agendaText);
 const agendaKeys=new Set([...structured,...literal].map(topicKey));
 // Passing independently extracted agenda fields to courseTopics permits a
 // title printed plainly on the cover even when agenda structured OCR is empty.
 const extracted=courseTopics(courseText,[...structured,...literal]);
 const missing=extracted.filter(title=>!agendaKeys.has(topicKey(title)));
 const matched=extracted.length>0&&missing.length===0;
 const inferred=extracted.filter(title=>!new Set(structured.map(topicKey)).has(topicKey(title)));
 return {matched,extracted,missing,structured,inferred,agendaFieldCount:agendaKeys.size};
}

module.exports={speakerName,photoName,agendaSpeakers,compareNames,topicKey,agendaTopics,courseTopics,agendaTitleFields,compareCourseAgenda};
