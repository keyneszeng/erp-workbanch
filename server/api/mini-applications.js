"use strict";
/** 微信端立项入口：普通用户仅能在本人协会以本人身份申请，进入原有审批工作流。 */
const {db}=require("../lib/db");
const {now,nextId,bad,forbidden,conflict}=require("../lib/util");
const {isDemoMode}=require("../lib/runtime");
const {getProject,transition}=require("../lib/workflow");
const {ASSOCS}=require("../lib/constants");
const {validate}=require("./projects");
const {assertCan}=require("../lib/rbac");
const {logAudit}=require("../lib/audit");
function requireMini(){
  if(isDemoMode()||process.env.ERP_MINIPROGRAM_ENABLED!=="1")
    throw Object.assign(new Error("正式微信小程序功能尚未启用"),{status:404,code:"MINI_DISABLED"});
}
function ownApplication(ctx,id){
  const p=getProject(id);
  if(Number(p.created_by)!==Number(ctx.user.id))throw forbidden("只能修改或提交本人创建的申请");
  return p;
}
function formFor(ctx,b){
  const actor=ctx.user;
  if(!actor.assoc && actor.role!=="admin")throw forbidden("尚未配置所属协会，请联系管理员完善账号后再立项");
  const assoc=actor.role==="admin"?String(b.assoc||""):String(actor.assoc);
  if(!require("../lib/associations").has(assoc))throw bad("请使用系统中有效的所属协会");
  if(actor.role!=="admin" && b.assoc && b.assoc!==assoc)throw forbidden("只能申请本协会项目");
  const v={
    name:String(b.name||"").trim(),assoc,
    form:String(b.form||"线下"),date:String(b.date||""),
    days:b.days===undefined?1:b.days,budget:b.budget,people:b.people===undefined?0:b.people,
    owner:actor.name,owner_id:actor.id,phone:String(b.phone||""),
    dept:String(b.dept||"会务部"),agenda:String(b.agenda||"").trim()
  };
  validate(v);
  return v;
}
function register(router){
  router.get("/api/mini/applications",async ctx=>{
    requireMini();
    assertCan(ctx.user,"mini:apply","当前账号尚未获微信端立项申请权限");
    const rows=db.prepare("SELECT id,name,assoc,form,date,days,budget,people,status,created_at,updated_at FROM projects WHERE created_by=? ORDER BY created_at DESC,id DESC LIMIT 100")
      .all(ctx.user.id);
    return {rows,total:rows.length};
  });
  router.get("/api/mini/applications/:id",async ctx=>{
    requireMini();
    assertCan(ctx.user,"mini:apply","当前账号尚未获微信端立项申请权限");
    const p=ownApplication(ctx,ctx.params.id);
    const {id,name,assoc,form,date,days,budget,people,phone,dept,agenda,status,created_at}=p;
    return {project:{id,name,assoc,form,date,days,budget,people,phone,dept,agenda,status,created_at}};
  });
  router.post("/api/mini/applications",async ctx=>{
    requireMini();
    assertCan(ctx.user,"mini:apply","当前账号尚未获微信端立项申请权限");
    const v=formFor(ctx,ctx.body||{});
    const pending=db.prepare("SELECT COUNT(*) AS n FROM projects WHERE created_by=? AND status IN ('草稿','待审批')").get(ctx.user.id).n;
    if(pending>=5)throw conflict("你已有 5 份未审批的申请，请先处理现有申请","APPLICATION_LIMIT");
    const id=nextId(db,"projects","id","MP"),at=now();
    db.prepare("INSERT INTO projects (id,name,assoc,form,date,days,budget,people,owner,owner_id,phone,dept,agenda,status,status_at,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
      .run(id,v.name,v.assoc,v.form,v.date,Number(v.days),Number(v.budget),Number(v.people),v.owner,v.owner_id,v.phone,v.dept,v.agenda,"草稿",at,ctx.user.id,at,at);
    db.prepare("INSERT OR IGNORE INTO project_members (project_id,user_id,role) VALUES (?,?,?)").run(id,ctx.user.id,"创建人");
    logAudit({user:ctx.user,module:"项目管理",action:"微信立项申请草稿",target:id,detail:"按本人协会创建申请草稿",ip:ctx.ip});
    return {project:{id,status:"草稿"},message:"草稿已保存，尚未提交审批"};
  });
  router.patch("/api/mini/applications/:id",async ctx=>{
    requireMini();
    assertCan(ctx.user,"mini:apply","当前账号尚未获微信端立项申请权限");
    const p=ownApplication(ctx,ctx.params.id);
    if(p.status!=="草稿")throw conflict("申请已提交，只能编辑草稿","APPLICATION_LOCKED");
    const v=formFor(ctx,ctx.body||{});
    db.prepare("UPDATE projects SET name=?,assoc=?,form=?,date=?,days=?,budget=?,people=?,phone=?,dept=?,agenda=?,updated_at=? WHERE id=?")
      .run(v.name,v.assoc,v.form,v.date,Number(v.days),Number(v.budget),Number(v.people),v.phone,v.dept,v.agenda,now(),p.id);
    logAudit({user:ctx.user,module:"项目管理",action:"修改本人立项草稿",target:p.id,detail:"提交前补充申请信息",ip:ctx.ip});
    return {project:{id:p.id,status:p.status},message:"草稿已更新"};
  });
  router.post("/api/mini/applications/:id/submit",async ctx=>{
    requireMini();
    assertCan(ctx.user,"mini:apply","当前账号尚未获微信端立项申请权限");
    const p=ownApplication(ctx,ctx.params.id);
    if(p.status!=="草稿")throw conflict("只有草稿可以提交审批","APPLICATION_LOCKED");
    return transition(p.id,"submit",ctx.user,{},ctx.ip);
  });
}
module.exports={register};
