"use strict";
const crypto=require("node:crypto");
/** Only explicitly named sponsorship deliverables; never infer from generic commercial language. */
const SECTION=/^(?:第?[一二三四五六七八九十\d]+[章节、.．\s]*)?(?:赞助|合作|品牌)?(?:回报|权益)(?:内容|清单|明细|项目|条款|方案)?\s*[:：]?$/u;
const STOP=/^(?:第?[一二三四五六七八九十\d]+[章节、.．\s]*)?(?:合同金额|赞助金额|付款|结算|违约|争议解决|保密|合同生效|协议生效|签字|盖章|甲方|乙方|法律|附则|费用)[\s：:]/u;
const RIGHTS=/Logo|LOGO|品牌|展示|展位|展台|背景板|鸣谢|冠名|宣传|广告|手册|物料|胸牌|屏幕|展架|签到墙|播放|冠名|主持人口播|邀请函|宣传册|直播|展播|采访|海报|易拉宝|权益/iu;
function cleanCategory(s){
  return String(s||"").normalize("NFKC").replace(/[\u0000-\u001f]/g," ").replace(/\s+/g," ")
    .replace(/^(?:\(?\d{1,2}\)?[.．、)）-]|[一二三四五六七八九十]+[、.．]|[①②③④⑤⑥⑦⑧⑨⑩]|[-*•·])\s*/u,"")
    .replace(/^(?:权益(?:内容|项目)?|回报(?:项目)?|宣传权益)[:：]\s*/u,"").trim()
    .replace(/[;；。]+$/u,"").trim();
}
function parseSponsorRights(text){
  const lines=String(text||"").split(/\r?\n/).map(s=>s.trim()).filter(Boolean);
  const rights=[],seen=new Set();let section=false,seenSection=false;
  function push(raw){
    const s=cleanCategory(raw).replace(/\s+(?:由甲方|由乙方|应当|负责提供).*$/u,"").trim();
    if(s.length<3||s.length>90||!RIGHTS.test(s)||
      /^(赞助权益|权益清单|权益内容|合作权益|品牌权益)$/u.test(s))return;
    const key=s.replace(/\s/g,"").toLowerCase();
    if(!seen.has(key)&&rights.length<60){seen.add(key);rights.push(s);}
  }
  for(const raw of lines){
    if(STOP.test(raw)){section=false;continue;}
    if(SECTION.test(raw)){section=true;seenSection=true;continue;}
    // "权益：主背景板LOGO露出" inline clause, separate from heading.
    const direct=/^(?:赞助|合作|品牌)?权益(?:内容|项目)?[:：]\s*(.{3,90})$/u.exec(raw);
    if(direct&&RIGHTS.test(direct[1])){push(direct[1]);seenSection=true;continue;}
    if(!section)continue;
    if(raw.length>140 && !/^[（(]?\d+[)）.、]/.test(raw))continue;
    // Individual bullet headings, never claim OCR body paragraphs to be categories.
    const item=/^(?:\(?\d{1,2}\)?[.．、)）]|[一二三四五六七八九十]+[、.．]|[①②③④⑤⑥⑦⑧⑨⑩]|[-*•·])\s*(.{3,100})$/u.exec(raw);
    if(item){push(item[1]);continue;}
    const named=/^(?:权益|项目|内容)[:：]\s*(.{3,90})$/u.exec(raw);
    if(named)push(named[1]);
  }
  return rights;
}
function normalizedCategories(v){
  if(!Array.isArray(v)||v.length>60)throw Object.assign(new Error("权益类目必须为不超过60项的数组"),{status:400,code:"SPONSOR_RIGHTS_INVALID"});
  const a=v.map(cleanCategory);
  if(a.some(s=>s.length<2||s.length>90)||new Set(a).size!==a.length)
    throw Object.assign(new Error("权益类目不能为空、超过90字或重复"),{status:400,code:"SPONSOR_RIGHTS_INVALID"});
  return a;
}
function sponsorRights(db,pid){
  const contracts=db.prepare("SELECT id,pid,enterprise,contract_no,status,file_key,file_name FROM meeting_sponsor_contracts WHERE pid=? ORDER BY id").all(pid);
  const rights=db.prepare("SELECT r.id,r.pid,r.sponsor_id,r.category,r.source,r.confirmed,r.updated_at FROM sponsor_rights r WHERE r.pid=? ORDER BY r.sponsor_id,r.id").all(pid);
  const photos=db.prepare("SELECT id,pid,kind,name,file_key,file_name,version,deleted_at,sponsor_right_id FROM materials WHERE pid=? AND kind='权益照片' AND (deleted_at IS NULL OR deleted_at='') ORDER BY id").all(pid);
  const active=contracts.filter(c=>c.status==="已签署");
  const activeIds=new Set(active.map(c=>c.id));
  const needed=rights.filter(r=>activeIds.has(r.sponsor_id));
  const associated=photos.filter(p=>p.sponsor_right_id!=null);
  const signature=crypto.createHash("sha256").update(JSON.stringify({
    contracts:active.map(c=>[c.id,c.status,c.file_key]),
    rights:needed.map(r=>[r.id,r.sponsor_id,r.category,r.confirmed,r.updated_at]),
    photos:associated.filter(p=>needed.some(r=>r.id===p.sponsor_right_id)).map(p=>[p.id,p.sponsor_right_id,p.name,p.file_key,p.version])
  })).digest("hex");
  return {required:active.length>0,contracts,rights,photos,activeContracts:active,
    requiredRights:needed,signature};
}
function validateRightsEvidence(db,pid,evidence){
  const snap=sponsorRights(db,pid);
  if(!snap.required)throw Object.assign(new Error("没有已签署赞助合同，第7项不适用"),{status:409,code:"SOP_NOT_APPLICABLE"});
  for(const c of snap.activeContracts){
    const items=snap.requiredRights.filter(r=>r.sponsor_id===c.id);
    if(!items.length || items.some(r=>!r.confirmed))
      throw Object.assign(new Error("赞助合同「"+c.enterprise+"」尚未确认完整的权益类目，请先校正OCR建议"),{status:409,code:"SPONSOR_RIGHTS_UNCONFIRMED"});
  }
  const wanted=snap.requiredRights.map(r=>r.id).sort((a,b)=>a-b);
  const checked=Array.isArray(evidence?.verifiedRights)?evidence.verifiedRights.map(Number).sort((a,b)=>a-b):[];
  if(!wanted.length || checked.length!==wanted.length ||
    new Set(checked).size!==checked.length || checked.some((id,i)=>id!==wanted[i]))
    throw Object.assign(new Error("必须逐项打开权益照片，人工确认每项与对应赞助合同权益内容相符"),{status:409,code:"RIGHTS_REVIEW_INCOMPLETE"});
  for(const right of snap.requiredRights){
    const docs=snap.photos.filter(m=>m.sponsor_right_id===right.id && m.file_key);
    if(!docs.length)throw Object.assign(new Error("权益「"+right.category+"」缺少相应的已上传权益照片"),{status:409,code:"RIGHT_PHOTO_MISSING"});
  }
  return {rightsMatched:wanted.length,sponsorsMatched:snap.activeContracts.length,
    rightsSignature:snap.signature,contentManuallyReviewed:true};
}
module.exports={parseSponsorRights,cleanCategory,normalizedCategories,sponsorRights,validateRightsEvidence};
