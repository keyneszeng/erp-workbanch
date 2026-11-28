"use strict";
const {db}=require("../lib/db");
const {getProject}=require("../lib/workflow");
const {can,isSuper,assertProjectVisible}=require("../lib/rbac");
const {bad,forbidden,conflict,formatBeijingDateTime}=require("../lib/util");
const {storage}=require("../lib/storage");
const PizZip=require("pizzip");
const {logAudit}=require("../lib/audit");
const {buildSelectedMaterialsPdf}=require("../lib/material-export-pdf");
const {buildDetail}=require("./project-ledger");
const archiveIndex=require("../lib/archive-material-index");
const {buildPaymentPptx}=require("../lib/archive-payment-pptx");
const {materialSlides}=require("../lib/archive-ppt-materials");

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
   return archiveIndex.sortDossierSources(orderedIds.map(id=>byId.get(id)));
 }
 const placeholders=kinds.map(()=>"?").join(",");
 const materials=db.prepare(
   "SELECT id,kind,name,version,file_key,file_name,file_mime,file_size FROM materials WHERE pid=? "+
   "AND (deleted_at IS NULL OR deleted_at='') AND file_key IS NOT NULL AND file_key<>'' "+
   "AND kind IN ("+placeholders+") ORDER BY id"
 ).all(pid,...kinds);
 if(!materials.length)
   throw bad("所选材料类别没有已上传的文件，不能生成 PDF");
 return archiveIndex.sortDossierSources(materials);
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
 const rows=db.prepare(
   "SELECT id,kind,name,file_name,file_mime,file_size FROM materials WHERE pid=? "+
   "AND (deleted_at IS NULL OR deleted_at='') AND file_key IS NOT NULL AND file_key<>'' "+
   "ORDER BY id"
 ).all(pid);
 return archiveIndex.sortDossierSources(rows);
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
// ZIP contains only selected, stored originals. Flat names, no generated pages,
// watermark, conversion, image compression or content-based deduplication.
function originalEntryName(source,used){
 const fallback=String(source.file_key||"").split(/[\\/]/).pop()||"原始文件";
 let name=String(source.file_name||fallback).split(/[\\/]/).pop()
  .replace(/[\u0000-\u001f\u007f<>:"|?*]/g,"_").replace(/[. ]+$/g,"").trim();
 if(!name||name==="."||name==="..")name=fallback;
 if(/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name))name="_"+name;
 const pos=name.lastIndexOf("."),ext=pos>0?name.slice(pos):"",stem=pos>0?name.slice(0,pos):name;
 let candidate=name,n=2;
 while(used.has(candidate.normalize("NFC").toLowerCase()))candidate=stem+" ("+n+++ ")" +ext;
 used.add(candidate.normalize("NFC").toLowerCase());
 return candidate;
}
async function buildOriginalZip(selected,store){
 const maxBytes=(store.name==="r2"?50:100)*1024*1024;
 let total=0;
 // 外层包内含 N 个「资料类目压缩包」：每个类目（15 类固定顺序）各自打成一个 ZIP，
 // 类目 ZIP 以类目名命名（如「签到表.zip」），里面是该类别的全部原件。
 const ordered=archiveIndex.sortDossierSources(selected);
 const groups=[]; // {kind, files:[{source,buffer}]}，按类目固定顺序
 const groupByKind=new Map();
 for(const source of ordered){
  if(!source.file_key||source.generated)throw bad("原始文件包只能下载实际留存的原件");
  // Read metadata first where available, then enforce actual byte length.
  if(typeof store.stat==="function"){
   const stat=await store.stat(source.file_key);
   if(!stat)throw conflict("原件缺失："+source.name,"ARCHIVE_ORIGINAL_MISSING");
   if(total+Number(stat.size)>maxBytes)throw bad("原始文件包总大小超过 "+maxBytes/1048576+" MB，请分批下载");
  }
  const file=await store.get(source.file_key);
  if(!file?.buffer?.length)throw conflict("原件缺失或为空："+source.name,"ARCHIVE_ORIGINAL_MISSING");
  total+=file.buffer.length;
  if(total>maxBytes)throw bad("原始文件包总大小超过 "+maxBytes/1048576+" MB，请分批下载");
  const kind=source.kind&&archiveIndex.GROUPS.includes(source.kind)?source.kind:
    (source.kind==="其他材料"?source.kind:archiveIndex.classifyMaterial(source));
  let group=groupByKind.get(kind);
  if(!group){group={kind,files:[]};groupByKind.set(kind,group);groups.push(group);}
  group.files.push({source,buffer:file.buffer});
 }
 const outer=new PizZip(),used=new Set();
 for(const group of groups){
  const inner=new PizZip(),innerUsed=new Set();
  for(const {source,buffer} of group.files)
   inner.file(originalEntryName(source,innerUsed),buffer,{binary:true,compression:"STORE"});
  const outerName=originalEntryName({file_key:group.kind,
    file_name:String(group.kind).replace(/[\\/]/g,"_")+".zip"},used);
  outer.file(outerName,inner.generate({type:"nodebuffer",compression:"STORE"}),{binary:true,compression:"STORE"});
 }
 return outer.generate({type:"nodebuffer",compression:"STORE"});
}
function register(router){
 router.get("/api/projects/:id/archive-pdf/options",async ctx=>{
   const project=getAllowedProject(ctx);
   return {project:{id:project.id,name:project.name,assoc:project.assoc,status:project.status},
     categories:availableKinds(project.id),materials:availableMaterials(project.id),
     groups:archiveIndex.categorySummary(archiveIndex.listArchiveSources(project)),
     sources:archiveIndex.listArchiveSources(project).map(archiveIndex.publicSource),
     can_customize_watermark:isSuper(ctx.user)};
 });
 const generate=async(ctx,legacyAll=false)=>{
   const project=getAllowedProject(ctx);
   const categories=availableKinds(project.id);
   const supplied=legacyAll?{categories:categories.filter(x=>x.files>0).map(x=>x.kind),watermark_mode:"default"}:(ctx.body||{});
   let materialRows,downloadStore=storage();
   if(!legacyAll&&(supplied.auto_all===true||supplied.source_ids!==undefined)){
     const sources=archiveIndex.listArchiveSources(project);
     const idList=supplied.auto_all===true?sources.map(s=>s.source_id):supplied.source_ids;
     if(!Array.isArray(idList)||!idList.length||idList.length>120||
        idList.some(id=>typeof id!=="string"||id.length>120)||
        new Set(idList).size!==idList.length)
       throw bad("来源清单不能为空、不能重复或超过120份");
     const lookup=new Map(sources.map(s=>[s.source_id,s]));
     if(idList.some(id=>!lookup.has(id)))
       throw bad("存在不属于当前会议项目的原件，请刷新后重试");
     const selection=archiveIndex.sortDossierSources(idList.map(id=>lookup.get(id)));
     const prepared=await archiveIndex.pdfMaterials(project,selection,downloadStore);
     materialRows=prepared.materials;downloadStore=prepared.store;
   }else{
     // Historical category/ID selections and GET links continue to work.
     materialRows=selectMaterials(project.id,supplied,categories);
   }
   const watermark=parseWatermark(ctx.user,supplied);
   const generatedAt=formatBeijingDateTime(new Date(),true)+"（北京时间）";
   const text=watermark.mode==="default"?"操作员："+String(ctx.user.name||ctx.user.username||"未知")+"  时间："+generatedAt:watermark.text;
   // Read the exact 项目台账 snapshot (settlement + categorized payments);
   // never recompute a parallel financial summary inside the PDF exporter.
   const ledgerDetail=buildDetail(project.id,ctx.user);
   const pdf=await buildSelectedMaterialsPdf({
     project,materials:materialRows,ledgerDetail,watermark:{mode:watermark.mode,text}
   },downloadStore);
   logAudit({user:ctx.user,module:"档案中心",action:"自动归集材料PDF下载",target:project.id,
     detail:"所选类别："+[...new Set(materialRows.map(m=>m.kind))].join("、")+
       "；提交来源数："+materialRows.length+"；按15类固定顺序生成、按原件内容去重；水印模式："+watermark.mode+
       "；操作员："+ctx.user.name+"；时间："+generatedAt,
     ip:ctx.ip});
   return {__file:{buffer:pdf,mime:"application/pdf",
       name:"会议材料_"+project.id+".pdf",download:true,cache:"no-store"}};
 };
 router.post("/api/projects/:id/archive-zip",async ctx=>{
   const project=getAllowedProject(ctx),ids=ctx.body?.source_ids;
   if(!Array.isArray(ids)||!ids.length||ids.length>120||
      ids.some(id=>typeof id!=="string"||!id||id.length>120)||new Set(ids).size!==ids.length)
     throw bad("请选择1～120份不重复的原始文件");
   const lookup=new Map(archiveIndex.listArchiveSources(project).map(s=>[s.source_id,s]));
   if(ids.some(id=>!lookup.has(id)))throw bad("存在不属于当前会议的原件，请刷新后重选");
   const chosen=ids.map(id=>lookup.get(id));
   if(chosen.some(s=>s.generated||!s.file_key))throw bad("系统生成摘要不属于原始文件，请仅选择真实原件");
   const buffer=await buildOriginalZip(chosen,storage());
   logAudit({user:ctx.user,module:"档案中心",action:"原始文件包下载",target:project.id,
     detail:"原件 "+chosen.length+" 份；按资料类目分组压缩包；不转换、不加水印、不按内容去重；来源："+ids.join("、"),ip:ctx.ip});
   return {__file:{buffer,mime:"application/zip",name:"会议原始文件包_"+project.id+".zip",download:true,cache:"no-store"}};
 });
 router.post("/api/projects/:id/archive-pdf",async ctx=>generate(ctx));
 // 兼容旧链接：默认导出所有类别并强制操作员/时间水印，不保留无水印漏洞。
 router.get("/api/projects/:id/archive-pdf",async ctx=>generate(ctx,true));
 /** PPTX: one payment table, then exactly the same selected/order dossier files. */
 const exportPpt=async ctx=>{
   const project=getAllowedProject(ctx);
   const supplied=ctx.body||{};
   const available=archiveIndex.listArchiveSources(project);
   const ids=supplied.source_ids===undefined?available.map(x=>x.source_id):supplied.source_ids;
   if(!Array.isArray(ids)||ids.length>120||ids.some(id=>typeof id!=="string"||id.length>120)
       ||new Set(ids).size!==ids.length)
     throw bad("PPT资料来源ID、重复来源或文件数量不合法");
   const lookup=new Map(available.map(source=>[source.source_id,source]));
   if(ids.some(id=>!lookup.has(id)))
     throw bad("PPT来源资料必须属于当前已归档会议，不能跨会议导出");
   const chosen=archiveIndex.sortDossierSources(ids.map(id=>lookup.get(id)));
   const prepared=await archiveIndex.pdfMaterials(project,chosen,storage());
   const dossier=await materialSlides(project,prepared.materials,prepared.store);
   const payments=db.prepare(
     "SELECT id,type,payee,amount,status,paid_at,receipt_file_key FROM payments WHERE pid=? ORDER BY created_at,id"
   ).all(project.id);
   const contracts=db.prepare(
     "SELECT id,vendor,amount,category,status,deleted_at FROM contracts WHERE pid=? AND deleted_at IS NULL ORDER BY created_at,id"
   ).all(project.id);
   const generatedAt=formatBeijingDateTime(new Date(),true);
   const watermarkText="操作员："+String(ctx.user.name||ctx.user.username||"未知")+"  时间："+generatedAt+"（北京时间）";
   const pptx=buildPaymentPptx(project,payments,contracts,dossier,{watermarkText});
   logAudit({user:ctx.user,module:"档案中心",action:"生成会议材料归集PPTX",target:project.id,
     detail:"封面1页+付款对照表1页+材料"+chosen.length+"份（可见页"+dossier.slides.length+"页）；"+
       "材料类别与PDF相同、用户指定的序列保持不变；水印时间："+generatedAt+"（北京时间）",
     ip:ctx.ip});
   return {__file:{buffer:pptx,
     mime:"application/vnd.openxmlformats-officedocument.presentationml.presentation",
     name:"会议完整卷宗_"+project.id+".pptx",download:true,cache:"no-store"}};
 };
 router.get("/api/projects/:id/archive-pptx",exportPpt);
 router.post("/api/projects/:id/archive-pptx",exportPpt);

 return router;
}
module.exports={register,assertArchiveDownloadAccess,selectMaterials,parseWatermark,availableKinds,availableMaterials,buildOriginalZip};
