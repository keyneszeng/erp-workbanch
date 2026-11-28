"use strict";
/** New project IDs: ASSOCIATION-YEAR-NNN, with year from the meeting start. */
const {bad,conflict}=require("./util");
const {getCode}=require("./associations");
function nextMeetingId(db,association,date){
 const code=getCode(association);
 const y=String(date||"").slice(0,4);
 if(!/^\d{4}$/.test(y)||!/^(\d{4})-\d{2}-\d{2}$/.test(String(date||"")))
  throw bad("会议举办日期不正确，无法生成会议编码");
 const year=Number(y);
 const record=db.prepare("SELECT last_seq FROM meeting_code_sequences WHERE code=? AND year=?").get(code,year);
 // Includes pre-migration records and stops a re-issued ID when old rows have
 // been deleted. Caller MUST wrap this allocation and project insert in transaction().
 const rows=db.prepare("SELECT id FROM projects WHERE id LIKE ?").all(code+"-"+y+"-%");
 let seen=0;
 const matcher=new RegExp("^"+code+"-"+y+"-([0-9]{2,3})$");
 for(const row of rows){
  const m=matcher.exec(row.id);
  if(m)seen=Math.max(seen,Number(m[1]));
 }
 const next=Math.max(Number(record?.last_seq)||0,seen)+1;
 if(next>999)throw conflict("该协会在"+y+"年已达到999场会议，三位会议序号已用完，请联系总管理员调整编码方案","MEETING_CODE_EXHAUSTED");
 db.prepare("INSERT INTO meeting_code_sequences(code,year,last_seq) VALUES (?,?,?) "+
   "ON CONFLICT(code,year) DO UPDATE SET last_seq=excluded.last_seq").run(code,year,next);
 return code+"-"+y+"-"+String(next).padStart(3,"0");
}
module.exports={nextMeetingId};
