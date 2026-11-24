"use strict";
/**
 * 废件箱（仅总管理员）。
 *
 * 只有明确删除的材料进入废件箱；合同更正流程产生的「历史版本归档」
 * 属于不可还原的签署证据，不得当作普通删除材料恢复。
 * 恢复原行原 ID / 项目 / 类别 / 原文件，不拷贝也不篡改原始上传时间。
 */
const { db, transaction } = require("../lib/db");
const { now, bad, notFound, forbidden, conflict } = require("../lib/util");
const { isSuper } = require("../lib/rbac");
const { getProject, settlementOf } = require("../lib/workflow");
const { storage } = require("../lib/storage");
const { logAudit } = require("../lib/audit");

const VERSION_ARCHIVE="合同更正版本归档";
function assertAdmin(user){
  if(!isSuper(user))throw forbidden("废件箱仅总管理员可以查看、下载和恢复材料");
}
function row(id){
  const m=db.prepare("SELECT * FROM materials WHERE id=?").get(id);
  if(!m||!m.deleted_at||m.deleted_by===VERSION_ARCHIVE)
    throw notFound("废件箱中不存在该材料，或已恢复");
  // 历史合同原件不可绕过合同更正机制直接回滚版本。
  if(m.kind==="合同"&&m.file_key &&
      db.prepare("SELECT 1 FROM contract_amendments WHERE pid=? AND old_file_key=? AND status='已生效'").get(m.pid,m.file_key))
    throw conflict("该文件属于已生效的合同更正历史版本，不可从废件箱恢复","CONTRACT_VERSION_ARCHIVED");
  return m;
}
function register(router){
  router.get("/api/recycle-bin/materials",async ctx=>{
    assertAdmin(ctx.user);
    const page=Math.max(1,Math.min(100000,Math.floor(Number(ctx.query?.page)||1)));
    const size=Math.max(1,Math.min(100,Math.floor(Number(ctx.query?.size)||20)));
    const q=String(ctx.query?.q||"").trim().slice(0,100);
    const params=[];
    let where="m.deleted_at IS NOT NULL AND m.deleted_at<>'' AND COALESCE(m.deleted_by,'')<>?";
    params.push(VERSION_ARCHIVE);
    if(q){
      where+=" AND (m.name LIKE ? OR m.file_name LIKE ? OR m.kind LIKE ? OR m.pid LIKE ? OR p.name LIKE ?)";
      for(let i=0;i<5;i++)params.push("%"+q+"%");
    }
    // 已签合同的更正历史只出现在合同「版本历史」，不能混入废件箱。
    where+=" AND NOT (m.kind='合同' AND m.file_key IS NOT NULL AND EXISTS ("+
      "SELECT 1 FROM contract_amendments ca WHERE ca.pid=m.pid AND ca.old_file_key=m.file_key AND ca.status='已生效'))";
    const base="FROM materials m JOIN projects p ON p.id=m.pid WHERE "+where;
    const total=db.prepare("SELECT COUNT(*) AS n "+base).get(...params).n;
    const rows=db.prepare(
      "SELECT m.id,m.pid,m.kind,m.name,m.version,m.uploader,m.created_at,m.file_key,m.file_name,m.file_size,m.file_mime,"+
        "m.deleted_at,m.deleted_by,p.name AS pname,p.status AS pstatus,p.assoc AS passoc "+
      base+" ORDER BY m.deleted_at DESC,m.id DESC LIMIT ? OFFSET ?"
    ).all(...params,size,(page-1)*size);
    return {rows,total,page,size,pages:Math.max(1,Math.ceil(total/size)),paged:true};
  });

  router.post("/api/recycle-bin/materials/:id/restore",async ctx=>{
    assertAdmin(ctx.user);
    const id=Number(ctx.params.id);
    if(!Number.isSafeInteger(id)||id<=0)throw bad("材料编号不合法");
    const m=row(id),p=getProject(m.pid);
    if(p.status==="已归档"||p.status==="已结算"||settlementOf(p.id))
      throw conflict("会议已结算或归档，必须先通过正式结算/归档更正流程，不能直接恢复材料","RECYCLE_PROJECT_FROZEN");
    if(m.file_key){
      const file=await storage().stat(m.file_key);
      if(!file)throw conflict("历史文件字节已不在存储中，无法原路恢复；请核查备份或存储","RECYCLE_FILE_MISSING");
      if(db.prepare("SELECT id FROM materials WHERE pid=? AND kind=? AND file_key=? AND deleted_at IS NULL AND id<>?")
        .get(p.id,m.kind,m.file_key,m.id))
        throw conflict("原项目此类别已有相同附件，禁止重复恢复","RECYCLE_DUPLICATE_FILE");
    }
    if(m.kind==="终版议程"&&m.version==="终版" &&
        db.prepare("SELECT 1 FROM materials WHERE pid=? AND kind='终版议程' AND version='终版' AND deleted_at IS NULL").get(p.id))
      throw conflict("原项目已经有另一份终版议程，请先核对终版版本后恢复","RECYCLE_FINAL_AGENDA_CONFLICT");

    // 已删材料中的合同原件可能同步软删了合同台账。必须同事务恢复，
    // 但恢复为「草稿」，不恢复已撤销的待签署审批，不能绕过审批直接进入签署。
    const linked=m.kind==="合同"&&m.file_key
      ?db.prepare("SELECT id,status,category FROM contracts WHERE pid=? AND file_key=? AND deleted_at IS NOT NULL").all(p.id,m.file_key)
      :[];
    if(linked.length>1)throw conflict("多份已删除合同引用同一文件，请先核对","RECYCLE_CONTRACT_AMBIGUOUS");
    const c=linked[0];
    if(c){
      if(!["草稿","待签署"].includes(c.status))
        throw conflict("已签署或已终止合同不得通过废件箱恢复，应走合同更正流程","RECYCLE_SIGNED_CONTRACT");
      if(p.status==="已核销"||
        db.prepare("SELECT 1 FROM verify_steps WHERE pid=? AND step_no=6 AND result='通过'").get(p.id))
        throw conflict("合同已进入核销锁定，请先办理核销更正","RECYCLE_CONTRACT_VERIFIED");
      if(c.category==="企业赞助"||
         db.prepare("SELECT 1 FROM meeting_sponsor_contracts WHERE ledger_contract_id=?").get(c.id))
        throw conflict("赞助合同与收入权益已关联，须先办理收入及权益更正","RECYCLE_SPONSOR_CONTRACT");
    }
    const stamp=now();
    const result=transaction(()=>{
      // 并发恢复保护：恢复同一行只允许成功一次。
      const current=row(m.id);
      if(current.deleted_at!==m.deleted_at)throw conflict("删除状态已经变化，请刷新废件箱","RECYCLE_CHANGED");
      if(m.file_key && db.prepare("SELECT id FROM materials WHERE pid=? AND kind=? AND file_key=? AND deleted_at IS NULL AND id<>?")
        .get(p.id,m.kind,m.file_key,m.id))
        throw conflict("已存在同类别附件，不能重复恢复","RECYCLE_DUPLICATE_FILE");
      const changed=db.prepare("UPDATE materials SET deleted_at=NULL,deleted_by=NULL WHERE id=? AND deleted_at=?")
        .run(m.id,m.deleted_at);
      if(!changed.changes)throw conflict("该材料已恢复，请刷新","RECYCLE_ALREADY_RESTORED");
      if(c){
        db.prepare("UPDATE contracts SET deleted_at=NULL,deleted_by=NULL,status='草稿' WHERE id=? AND deleted_at IS NOT NULL")
          .run(c.id);
      }
      return {id:m.id,pid:m.pid,kind:m.kind,linkedContract:c?.id||null};
    });
    logAudit({user:ctx.user,module:"废件箱",action:"恢复材料",target:p.id,
      detail:"材料#"+m.id+"；"+m.kind+"："+m.name+"；原文件："+(m.file_name||"无")+
        "；原删除人："+(m.deleted_by||"历史记录")+
        (c?"；关联合同 "+c.id+" 恢复为草稿，须重新审批签署":""),
      ip:ctx.ip});
    return {...result,restored_at:stamp,message:c
      ?"材料和关联合同已恢复原项目，合同退回草稿等待重新签署"
      :"材料已恢复原项目、原类别及原始附件"};
  });
}
module.exports={register};
