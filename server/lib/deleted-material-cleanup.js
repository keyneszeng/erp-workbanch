"use strict";

/**
 * 删除材料只撤销其“有效证据”身份，不删除废件箱中的原始记录或文件。
 * 必须在标记 deleted_at 的同一个 DB 事务内调用，避免看板保留已删原件的旧核销结论。
 */
const STEP_BY_KIND={
  "立项文件":[1],"会议通知":[1],"招商函":[1],"串场":[1,4],
  "议程":[1,2,4],"终版议程":[1,2,4],
  "讲者照片":[2],"签到表":[3],"在线记录":[3],"会议截图":[3],
  "课件":[4],"串场课件":[4],"劳务表":[5],"劳务收集表":[5],
  "合同":[5,6],"会务协议":[6],"会务合同":[6],
  "会务发票":[6],"发票":[6],"权益照片":[7],"赞助合同":[7]
};

function dependentSteps(kind){
  const name=String(kind||"");
  if(STEP_BY_KIND[name])return STEP_BY_KIND[name];
  if(/赞助.*合同/.test(name))return [7];
  if(/劳务|专家/.test(name)&&/合同|协议/.test(name))return [5];
  if(/会务|会议服务/.test(name)&&/合同|协议/.test(name))return [6];
  if(/合同|协议/.test(name))return [5,6];
  return [];
}

/** 自适应历史证据结构，仅比较精确 id/key，不用模糊名称匹配。 */
function evidenceReferencesDeleted(evidence,ids,keys){
  if(!evidence||typeof evidence!=="object")return false;
  if(Array.isArray(evidence))return evidence.some(x=>evidenceReferencesDeleted(x,ids,keys));
  if(evidence.materialId!=null&&ids.has(Number(evidence.materialId)))return true;
  if(evidence.material_id!=null&&ids.has(Number(evidence.material_id)))return true;
  if(evidence.fileKey&&keys.has(String(evidence.fileKey)))return true;
  if(evidence.file_key&&keys.has(String(evidence.file_key)))return true;
  return Object.values(evidence).some(x=>x&&typeof x==="object"&&evidenceReferencesDeleted(x,ids,keys));
}

/** 仅处理此项目本次实际软删的材料，所有操作和删除本身同时提交/回滚。 */
function detachDeletedMaterialEvidence(db,pid,deletedRows,stamp,operator){
  const rows=(deletedRows||[]).filter(x=>Number.isSafeInteger(Number(x.id))&&Number(x.id)>0);
  if(!rows.length)return {materialIds:[],resetSteps:[],detachedTasks:0,detachedExceptions:0};
  const ids=new Set(rows.map(x=>Number(x.id)));
  const keys=new Set(rows.map(x=>String(x.file_key||"")).filter(Boolean));
  const placeholders=[...ids].map(()=>"?").join(",");
  const params=[...ids];
  const linkedExceptions=db.prepare(
    "SELECT step_no FROM exceptions WHERE pid=? AND evidence_material_id IN ("+placeholders+")"
  ).all(pid,...params);
  const taskResult=db.prepare(
    "UPDATE meeting_material_tasks SET status='未提交',material_id=NULL,updated_at=?,updated_by=? "+
    "WHERE pid=? AND material_id IN ("+placeholders+")"
  ).run(stamp,operator,pid,...params);
  const exceptionResult=db.prepare(
    "UPDATE exceptions SET evidence_material_id=NULL,resolution=NULL,resolved_at=NULL,resolved_by=NULL, "+
    "status=CASE WHEN status='已闭环' THEN '待复核' ELSE status END "+
    "WHERE pid=? AND evidence_material_id IN ("+placeholders+")"
  ).run(pid,...params);

  const affected=new Set(rows.flatMap(r=>dependentSteps(r.kind)));
  for(const e of linkedExceptions)if(Number(e.step_no)>0)affected.add(Number(e.step_no));

  // 删除最后一份有效原件会令整个核销门槛失效，不能保留任何旧通过结论。
  const remaining=db.prepare(
    "SELECT COUNT(*) AS n FROM materials WHERE pid=? AND (deleted_at IS NULL OR deleted_at='') "+
    "AND file_key IS NOT NULL AND file_key<>''"
  ).get(pid).n;
  const stepRows=db.prepare("SELECT step_no,evidence_json FROM verify_steps WHERE pid=?").all(pid);
  for(const step of stepRows){
    if(!remaining)affected.add(step.step_no);
    if(!step.evidence_json)continue;
    try{
      if(evidenceReferencesDeleted(JSON.parse(step.evidence_json),ids,keys))affected.add(step.step_no);
    }catch{
      // 格式损坏的旧证据无法排除已删除文件；要求人工重新核验。
      affected.add(step.step_no);
    }
  }
  const resetSteps=[...affected].filter(n=>Number.isInteger(n)&&n>=1&&n<=7).sort((a,b)=>a-b);
  for(const no of resetSteps){
    db.prepare("UPDATE verify_steps SET result='待判定', "+
      "remark='关联材料已删除，请使用当前有效原件重新核验', "+
      "evidence_json=NULL,invoice_amount=NULL,checked_by=NULL,checked_at=NULL "+
      "WHERE pid=? AND step_no=?").run(pid,no);
  }
  return {materialIds:[...ids],resetSteps,
    detachedTasks:taskResult.changes||0,detachedExceptions:exceptionResult.changes||0};
}

module.exports={detachDeletedMaterialEvidence,dependentSteps,evidenceReferencesDeleted};
