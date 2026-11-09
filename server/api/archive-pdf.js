"use strict";
const {db}=require("../lib/db");
const {getProject}=require("../lib/workflow");
const {can,isSuper,assertProjectVisible}=require("../lib/rbac");
const {bad,forbidden,conflict}=require("../lib/util");
const {storage}=require("../lib/storage");
const {logAudit}=require("../lib/audit");
const {buildSelectedMaterialsPdf}=require("../lib/material-export-pdf");

/** 与原归档下载相同的角色边界；仅允许当前所属协会管理员或总管理员。 */
function assertArchiveDownloadAccess(user,project){
 if(!can(user,"archive:download"))throw forbidden("当前账号未获材料PDF下载权限");
 assertProjectVisible(user,project);
}
function getAllowedProject(ctx){
 const p=getProject(ctx.params.id);
 assertArchiveDownloadAccess(ctx.user,p);
 if(p.status!=="已归档")
   throw conflict("会议尚未归档，材料下载尚不可用","ARCHIVE_REQUIRED",{status:p.status});
 return p;
}
/** 只选择已存在于当前项目材料库的有效类别；不接受客户端指定附件key。 */
function selectMaterials(pid,body,allKinds){
 const selected=body?.categories;
 if(!Array.isArray(selected)||!selected.length)
   throw bad("请至少勾选一个材料类别");
 if(selected.length>120||selected.some(s=>typeof s!=="string"||!s.trim()||s.length>20))
   throw bad("材料类别参数不合法");
 const kinds=[...new Set(selected.map(s=>s.trim()))];
 const valid=new Set(allKinds.map(s=>s.kind));
 if(kinds.some(x=>!valid.has(x)))
   throw bad("存在不属于该项目的材料类别，请刷新后重选");
 // Optional ordered selection of individual material IDs: validate against this project's
 // active material rows; never accept arbitrary file keys or foreign-project IDs.
 const orderedIds=body?.material_ids;
 if(orderedIds!==undefined){
   if(!Array.isArray(orderedIds)||!orderedIds.length||orderedIds.length>120||
      orderedIds.some(id=>!Number.isSafeInteger(id)||id<1)||
      new Set(orderedIds).size!==orderedIds.length)
     throw bad("所选材料或排序参数不合法");
   const placeholders=orderedIds.map(()=>"?").join(",");
   const selectedRows=db.prepare(
     "SELECT id,kind,name,version,file_key,file_name,file_mime,file_size FROM materials "+
     "WHERE pid=? AND (deleted_at IS NULL OR deleted_at='') AND file_key IS NOT NULL AND file_key<>'' "+
     "AND id IN ("+placeholders+")"
   ).all(pid,...orderedIds);
   const byId=new Map(selectedRows.map(m=>[m.id,m]));
   if(selectedRows.length!==orderedIds.length||selectedRows.some(m=>!kinds.includes(m.kind)))
     throw bad("所选材料不属于当前项目或未在勾选类目中，请刷新后重选");
   return orderedIds.map(id=>byId.get(id));
 }
 const placeholders=kinds.map(()=>"?").join(",");
 const materials=db.prepare(
   "SELECT id,kind,name,version,file_key,file_name,file_mime,file_size FROM materials WHERE pid=? "+
   "AND (deleted_at IS NULL OR deleted_at='') AND file_key IS NOT NULL AND file_key<>'' "+
   "AND kind IN ("+placeholders+") ORDER BY kind,id"
 ).all(pid,...kinds);
 if(!materials.length)
   throw bad("所选材料类别没有已上传的文件，不能生成 PDF");
 return materials;
}
function availableKinds(pid){
 const rows=db.prepare(
  "SELECT kind,COUNT(*) AS entries,SUM(CASE WHEN file_key IS NOT NULL AND file_key<>'' THEN 1 ELSE 0 END) AS files "+
  "FROM materials WHERE pid=? AND (deleted_at IS NULL OR deleted_at='') GROUP BY kind ORDER BY kind"
 ).all(pid);
 return rows.map(row=>({kind:row.kind,entries:row.entries,files:Number(row.files)||0}));
}
/** Available originals within current project; limited fields, no raw file keys exposed in options. */
function availableMaterials(pid){
 return db.prepare(
   "SELECT id,kind,name,file_name,file_mime,file_size FROM materials WHERE pid=? "+
   "AND (deleted_at IS NULL OR deleted_at='') AND file_key IS NOT NULL AND file_key<>'' "+
   "ORDER BY kind,id"
 ).all(pid);
}
function parseWatermark(user,body={}){
 const mode=body.watermark_mode??"default";
 if(!["default","none","custom"].includes(mode))throw bad("水印模式不合法");
 if(!isSuper(user)&&mode!=="default")
   throw forbidden("仅总管理员可取消水印或设置自定义水印");
 const text=mode==="custom"?String(body.watermark_text??"").trim():"";
 if(mode==="custom"&&(!text||text.length>80||/[\u0000-\u001f\u007f]/.test(text)))
   throw bad("自定义水印必须为1至80个有效字符");
 return {mode,text};
}
function register(router){
 router.get("/api/projects/:id/archive-pdf/options",async ctx=>{
   const project=getAllowedProject(ctx);
   return {project:{id:project.id,name:project.name,assoc:project.assoc,status:project.status},
     categories:availableKinds(project.id),materials:availableMaterials(project.id),can_customize_watermark:isSuper(ctx.user)};
 });
 const generate=async(ctx,legacyAll=false)=>{
   const project=getAllowedProject(ctx);
   const categories=availableKinds(project.id);
   const supplied=legacyAll?{categories:categories.filter(x=>x.files>0).map(x=>x.kind),watermark_mode:"default"}:(ctx.body||{});
   const materialRows=selectMaterials(project.id,supplied,categories);
   const watermark=parseWatermark(ctx.user,supplied);
   const generatedAt=new Date().toISOString().replace("T"," ").slice(0,19)+" UTC";
   const text=watermark.mode==="default"?"操作员："+String(ctx.user.name||ctx.user.username||"未知")+"  时间："+generatedAt:watermark.text;
   const pdf=await buildSelectedMaterialsPdf({
     project,materials:materialRows,watermark:{mode:watermark.mode,text}
   },storage());
   logAudit({user:ctx.user,module:"档案中心",action:"材料勾选PDF下载",target:project.id,
     detail:"所选类别："+[...new Set(materialRows.map(m=>m.kind))].join("、")+
       "；材料数："+materialRows.length+"；水印模式："+watermark.mode+
       "；操作员："+ctx.user.name+"；时间："+generatedAt,
     ip:ctx.ip});
   return {__file:{buffer:pdf,mime:"application/pdf",
       name:"会议材料_"+project.id+".pdf",download:true,cache:"no-store"}};
 };
 router.post("/api/projects/:id/archive-pdf",async ctx=>generate(ctx));
 // 兼容旧链接：默认导出所有类别并强制操作员/时间水印，不保留无水印漏洞。
 router.get("/api/projects/:id/archive-pdf",async ctx=>generate(ctx,true));
 return router;
}
module.exports={register,assertArchiveDownloadAccess,selectMaterials,parseWatermark,availableKinds,availableMaterials};
