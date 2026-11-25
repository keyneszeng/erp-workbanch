"use strict";
/** Ledger sponsorship is income, never an accounts-payable contract. */
const {now,conflict}=require("./util");
function linkedSponsor(db,ledgerId){
 return db.prepare("SELECT * FROM meeting_sponsor_contracts WHERE ledger_contract_id=?").get(ledgerId);
}
function ensureSponsorSignable(db,project,ledgerId){
 const s=linkedSponsor(db,ledgerId);
 if(!s)throw conflict("该企业赞助合同尚未关联到会议收入，请联系管理员","SPONSOR_LINK_MISSING");
 if(s.status!=="待确认")throw conflict("赞助合同状态已变化，请刷新后重试","SPONSOR_ALREADY_DECIDED");
 // 赞助收入独立于会议立项预算，不设预算上限。
 return s;
}
function setSponsorStatus(db,s,approve,userId){
 db.prepare("UPDATE meeting_sponsor_contracts SET status=?,approved_by=?,approved_at=? WHERE id=?")
 .run(approve?"已签署":"已驳回",userId,now(),s.id);
}
module.exports={linkedSponsor,ensureSponsorSignable,setSponsorStatus};
