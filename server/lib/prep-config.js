"use strict";
/**
 * Invite-template admin configuration with versioned publish/rollback.
 * Stored in the existing settings table, no credentials or arbitrary HTML.
 * Published content changes only when super-admin explicitly publishes.
 */
const { db } = require("./db");
const { bad, conflict } = require("./util");
const { TEMPLATES } = require("./prep-invitation");
const KEY="prep_invite_admin_config_v1";
const ALLOWED_VARS=new Set(["会议编号","会议名称","主办协会","会议日期","会议形式","会议议程",
  "项目负责人","生成日期","受邀单位","受邀姓名","称谓","嘉宾角色","课题说明"]);
const bool = x => x===true;
function defaults(){
  return {
    enabled:true,
    email_enabled:false,
    wechat_enabled:false,
    org_header:"协会会议执行 · 邀请函",
    org_footer:"",
    mini_appid:"",
    mini_program_verified:false,
    templates:Object.fromEntries(Object.entries(TEMPLATES).map(([key,t])=>[key,{
      subject:t.subject,paragraphs:[...t.paragraphs]
    }]))
  };
}
function safeText(v,label,max=250){
  if(typeof v!=="string")throw bad(label+"必须是字符串");
  if(v.length>max)throw bad(label+"不能超过"+max+"字");
  if(/[\x00-\x08\x0b\x0e-\x1f]/.test(v))throw bad(label+"含非法字符");
  if(/<\/?[a-z][^>]*>/i.test(v))throw bad(label+"不能包含 HTML 标签");
  for(const token of v.matchAll(/\{\{([^{}]+)\}\}/g)){
    if(!ALLOWED_VARS.has(token[1]))throw bad(label+"包含不受支持的变量："+token[1]);
  }
  // Reject malformed or nested braces which would be silently dropped.
  if(v.replace(/\{\{[^{}]+\}\}/g,"").includes("{{") ||
     v.replace(/\{\{[^{}]+\}\}/g,"").includes("}}")) throw bad(label+"模板变量不完整");
  return v.trim();
}
function validateConfig(raw){
  if(!raw || typeof raw!=="object" || Array.isArray(raw))throw bad("配置内容格式错误");
  const permitted=["enabled","email_enabled","wechat_enabled","org_header","org_footer","mini_appid","mini_program_verified","templates"];
  const unknown=Object.keys(raw).filter(k=>!permitted.includes(k));
  if(unknown.length) throw bad("配置包含未授权字段："+unknown.join("、"));
  const d=defaults();const c={...d,...raw};
  for(const k of ["enabled","email_enabled","wechat_enabled","mini_program_verified"])
    if(typeof c[k]!=="boolean")throw bad(k+"必须是布尔值");
  c.org_header=safeText(c.org_header,"文档抬头",100);
  c.org_footer=safeText(c.org_footer,"落款补充",180);
  c.mini_appid=safeText(c.mini_appid,"小程序 AppID",32);
  if(c.mini_appid && !/^wx[a-fA-F0-9]{16}$/.test(c.mini_appid))
    throw bad("小程序 AppID 应为 wx 开头的18位标识");
  if(!c.templates || typeof c.templates!=="object" || Array.isArray(c.templates))
    throw bad("模板内容必须包括企业与嘉宾两种模板");
  if(Object.keys(c.templates).sort().join(",")!=="enterprise,guest")
    throw bad("只能编辑内置的企业邀请函和嘉宾邀请函");
  const templates={};
  for(const key of ["enterprise","guest"]){
    const t=c.templates[key];
    if(!t || typeof t!=="object" || Array.isArray(t))throw bad("缺少"+key+"模板");
    if(Object.keys(t).sort().join(",")!=="paragraphs,subject")throw bad("模板字段仅支持主题与正文段落");
    const subject=safeText(t.subject,key+"主题",180);
    if(!subject)throw bad(key+"主题不能为空");
    if(!Array.isArray(t.paragraphs)||t.paragraphs.length<3||t.paragraphs.length>16)
      throw bad(key+"正文需3到16段");
    const paragraphs=t.paragraphs.map((v,i)=>safeText(v,key+"正文第"+(i+1)+"段",600));
    if(paragraphs.join("").length>5000)throw bad(key+"正文总长度超过上限");
    templates[key]={subject,paragraphs};
  }
  c.templates=templates;
  return c;
}
function read(){
  const row=db.prepare("SELECT v FROM settings WHERE k=?").get(KEY);
  if(!row)return {version:0,live:defaults(),draft:null,history:[]};
  try{
    const data=JSON.parse(row.v);
    return {version:Number(data.version)||0,live:validateConfig(data.live||defaults()),
      draft:data.draft?validateConfig(data.draft):null,
      history:Array.isArray(data.history)?data.history.slice(0,10):[]};
  }catch{throw conflict("上线配置记录无法解析，请管理员检查数据","CONFIG_CORRUPTED")}
}
function save(state){
  db.prepare("INSERT OR REPLACE INTO settings (k,v) VALUES (?,?)").run(KEY,JSON.stringify(state));
}
function editDraft(config,expectedVersion){
  const state=read();
  if(expectedVersion!==state.version)throw conflict("其他管理员已发布新版本，请刷新再编辑","CONFIG_VERSION_CONFLICT");
  state.draft=validateConfig(config);
  save(state);return state;
}
function publish(expectedVersion,username){
  const state=read();
  if(expectedVersion!==state.version)throw conflict("发布版本已变动，请刷新","CONFIG_VERSION_CONFLICT");
  if(!state.draft)throw bad("尚无待发布草稿");
  if(state.draft.wechat_enabled && (!state.draft.mini_appid || !state.draft.mini_program_verified))
    throw bad("启用微信分享前须填写正式小程序 AppID 并确认已发布审核通过");
  state.history.unshift({version:state.version,config:state.live,at:new Date().toISOString(),by:username});
  state.history=state.history.slice(0,10);
  state.live=state.draft;state.draft=null;state.version+=1;
  save(state);return state;
}
function rollback(targetVersion,username){
  const state=read();
  const item=state.history.find(h=>h.version===targetVersion);
  if(!item)throw bad("没有可回退的目标版本");
  state.history.unshift({version:state.version,config:state.live,at:new Date().toISOString(),by:username});
  state.history=state.history.slice(0,10);
  state.live=validateConfig(item.config);state.version+=1;state.draft=null;
  save(state);return state;
}
function live(){return read().live}
module.exports={defaults,read,live,editDraft,publish,rollback,validateConfig,ALLOWED_VARS};
