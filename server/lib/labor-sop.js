"use strict";
/** 只认有附件、未删除的「劳务表」，兼容历史「劳务收集表」类别。 */
function laborSheetInfo(db,pid){
 const rows=db.prepare("SELECT id FROM materials WHERE pid=? AND kind IN ('劳务表','劳务收集表') AND (deleted_at IS NULL OR deleted_at='') AND file_key IS NOT NULL AND file_key<>'' ORDER BY id").all(pid);
 return {required:rows.length>0,signature:rows.map((r,i)=>String(r.id??("mock-"+i))).join(",")};
}
module.exports={laborSheetInfo};
