"use strict";
const crypto=require("node:crypto");

/** Search only this project's uploaded, undeleted contract files in the materials library. */
function contractPool(db,pid){
  const rows=db.prepare(
    "SELECT rowid AS id,name,file_name,file_key FROM materials WHERE pid=? AND kind='合同' "+
    "AND (deleted_at IS NULL OR deleted_at='') AND file_key IS NOT NULL AND file_key<>'' ORDER BY id"
  ).all(pid);
  // Opaque fingerprint: a renamed, added, deleted or replaced file invalidates old evidence.
  const signature=crypto.createHash("sha256").update(JSON.stringify(rows.map(r=>
    [r.id,r.name,r.file_name,r.file_key]))).digest("hex");
  return {rows,signature};
}
function personKey(s){
  return String(s??"").normalize("NFKC").replace(/\s+/g,"").trim();
}
function contractNameKey(text){
  return personKey(text)
    .replace(/\.(?:pdf|docx?|png|jpe?g|webp|xlsx?|pptx?)$/i,"")
    .replace(/(?:-|_|—|－)?(?:专家劳务合同|劳务服务合同|劳务合同|专家合同|讲课合同|合同)$/u,"");
}
// Match complete personal name, not a surname or a substring.
function matchesPerson(material,person){
  const name=personKey(person);
  return !!name && [material.file_name,material.name].some(t=>
    t && contractNameKey(t)===name);
}
function linkLaborContracts(db,pid,people){
  const pool=contractPool(db,pid);
  const linked=[],missing=[],ambiguous=[];
  for(const person of people){
    const hits=pool.rows.filter(m=>matchesPerson(m,person));
    if(hits.length===0)missing.push(String(person));
    else if(hits.length>1)ambiguous.push(String(person));
    else linked.push(hits[0]);
  }
  return {linked,missing,ambiguous,contractPoolSignature:pool.signature};
}
module.exports={contractPool,linkLaborContracts,contractNameKey,matchesPerson};
