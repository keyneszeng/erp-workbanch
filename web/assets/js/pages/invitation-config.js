import { api } from "../lib/api.js";
import { esc, toast, confirmBox } from "../lib/ui.js";

/**
 * Only total administrators can reach this page. The server repeats the check
 * on every read/write/preview/publish request.
 */
let data=null;
let projects=[];
const field=(id,label,value,help="")=>
  '<label style="display:block;margin:12px 0 8px"><span style="display:block;font-weight:600;margin-bottom:6px">'+
  esc(label)+'</span><input id="'+id+'" style="width:100%;max-width:620px" value="'+esc(value||"")+'" />'+
  (help?'<span class="hint" style="display:block;margin-top:5px">'+esc(help)+'</span>':"")+'</label>';
const checkbox=(id,label,value)=>
  '<label style="display:inline-flex;align-items:center;gap:8px;margin:12px 22px 10px 0"><input type="checkbox" id="'+id+'"'+
  (value?" checked":"")+' />'+esc(label)+'</label>';
const templateBlock=(type,title,template)=>
  '<div class="panel mt" style="padding:18px"><h3>'+esc(title)+'</h3>'+
  field(type+"-subject","邀请函标题（支持 {{会议名称}} 等变量）",template.subject)+
  '<label style="display:block;margin-top:12px;font-weight:600">正文段落（每段一行）</label>'+
  '<textarea id="'+type+'-paragraphs" rows="10" style="width:100%;resize:vertical;border:1px solid var(--line,#d9e5f3);padding:12px;border-radius:8px">'+
  esc(template.paragraphs.join("\n"))+'</textarea>'+
  '<p class="hint">变量示例：{{主办协会}}、{{会议日期}}、{{受邀单位}}、{{受邀姓名}}、{{称谓}}、{{嘉宾角色}}。只支持纯文字，不执行 HTML。</p></div>';

function grab(){
  const templates={};
  for(const type of ["enterprise","guest"])templates[type]={
    subject:document.getElementById(type+"-subject").value.trim(),
    paragraphs:document.getElementById(type+"-paragraphs").value.split(/\r?\n/).map(x=>x.trim()).filter(Boolean)
  };
  return {
    enabled:document.getElementById("setting-enabled").checked,
    email_enabled:document.getElementById("setting-email").checked,
    wechat_enabled:document.getElementById("setting-wechat").checked,
    org_header:document.getElementById("org-header").value.trim(),
    org_footer:document.getElementById("org-footer").value.trim(),
    mail_from:document.getElementById("mail-from").value.trim(),
    public_base_url:document.getElementById("public-base-url").value.trim(),
    mini_appid:document.getElementById("mini-appid").value.trim(),
    mini_program_verified:document.getElementById("mini-published").checked,
    templates
  };
}

export async function render(root) {
  try {
    const [r,p]=await Promise.all([api.get("/api/admin/invitation-config"),api.get("/api/projects")]);
    data=r; projects=(p.rows||[]);
  } catch(e){root.textContent=e.message||"获取系统设置失败";return;}
  const config=data.draft||data.live;
  const ready=data.readiness;
  const versions=(data.history||[]).map(h=>
    '<option value="'+Number(h.version)+'">v'+Number(h.version)+' · '+esc(h.at||"")+' · '+esc(h.by||"")+'</option>').join("");
  root.innerHTML='<div class="phead"><div><h2>邀请函模板与上线配置</h2>'+
    '<p>仅总管理员可编辑、测试、发布和回退；配置发布后即时对新邀请函生效，不需要重新部署代码。</p></div></div>'+
    '<div class="panel"><div class="panel-h"><h2>当前上线状态 · v'+Number(data.version)+'</h2>'+
    '<span class="hint">'+(data.draft?'存在未发布草稿':'当前没有待发布草稿')+'</span></div>'+
    '<p>邮件服务端配置：<strong>'+ (ready.mail_service_ready?'已就绪':'未就绪')+
    '</strong>　｜　HTTPS 邀请地址：'+(ready.public_url_ready?'已配置':'未配置')+
    '　｜　微信发布确认：'+(ready.wechat_config_ready?'已配置':'待完善')+'</p>'+
    '<p class="hint">发件凭证已加密存储：'+(ready.mail_credential_stored?"是":"否")+
    '　｜　加密主密钥就绪：'+(ready.mail_encryption_ready?"是":"否")+
    '。微信审核状态由总管理员确认，不代表系统已实时查询微信平台。</p>'+
    checkbox("setting-enabled","开放筹备邀请函生成",config.enabled)+
    checkbox("setting-email","开放邮件发送",config.email_enabled)+
    checkbox("setting-wechat","开放微信小程序分享",config.wechat_enabled)+'</div>'+
    '<div class="panel mt"><div class="panel-h"><h2>协会抬头与落款</h2></div>'+
    field("org-header","PDF 抬头",config.org_header)+
    field("org-footer","补充落款 / 联系方式 / 说明",config.org_footer)+
    '<p class="hint">当前版支持文字抬头和落款；正式盖章图片与协会 Logo 需经授权后另行加入文件资产及 PDF 盖章流程。</p></div>'+
    '<div class="panel mt"><div class="panel-h"><h2>邮件服务在线配置</h2></div>'+
    field("mail-from","发件邮箱（须已在邮件平台验证）",config.mail_from)+
    field("public-base-url","对外邀请页 HTTPS 地址",config.public_base_url)+
    '<label style="display:block;margin:12px 0">Resend API Key（仅更新时填写，不回显）<input id="mail-credential" type="password" autocomplete="new-password" placeholder="re_..." style="width:100%;max-width:620px"/></label>'+
    '<button class="btn btn-o" id="save-mail-credential">加密保存发件凭证</button>'+
    '<button class="btn btn-o" id="remove-mail-credential" style="margin-left:8px">清除已存发件凭证</button>'+
    '<p class="hint" style="margin-top:10px">初次使用需运维在 Cloudflare 配置 ERP_MAIL_CONFIG_KEY（随机不少于32字符）；之后密钥可由总管理员自行更换，页面永不回显。发件邮箱、域名须保存草稿并发布后才生效。</p></div>'+
    '<div class="panel mt"><div class="panel-h"><h2>微信小程序上线信息</h2></div>'+
    field("mini-appid","小程序 AppID",config.mini_appid,"填写正式 AppID，不能使用 touristappid")+
    checkbox("mini-published","我确认小程序已审核发布，且业务域名已在微信后台配置",config.mini_program_verified)+
    '<p class="hint">此处只配置可用性，不会通过浏览器提交微信密钥，也不会自动提交微信审核。</p></div>'+
    templateBlock("enterprise","企业邀请（招商）函",config.templates.enterprise)+
    templateBlock("guest","嘉宾邀请函",config.templates.guest)+
    '<div class="panel mt"><div class="panel-h"><h2>预览与发布</h2></div>'+
    '<div class="filters"><label>使用会议资料预览<select id="preview-project">'+
    projects.map(p=>'<option value="'+esc(p.id)+'">'+esc(p.id+" · "+p.name)+'</option>').join("")+
    '</select></label><label>模板<select id="preview-type"><option value="enterprise">企业邀请（招商）函</option><option value="guest">嘉宾邀请函</option></select></label></div>'+
    '<div class="acts" style="margin-top:12px;display:flex;gap:10px;flex-wrap:wrap">'+
    '<button class="btn btn-o" id="save-draft">保存草稿</button>'+
    '<button class="btn btn-o" id="preview-pdf">预览草稿 PDF</button>'+
    '<button class="btn btn-p" id="publish">发布生效</button></div>'+
    '<p class="hint" style="margin-top:10px">请先保存草稿再预览；发布后新生成的邀请函使用新配置，旧邀请函继续保留原始 PDF 快照。</p></div>'+
    '<div class="panel mt"><div class="panel-h"><h2>历史版本与回退</h2></div>'+
    (data.history?.length?
      '<div class="filters"><select id="rollback-version">'+versions+'</select><button class="btn btn-o" id="rollback">恢复选中版本（生成新版本）</button></div>':
      '<p class="hint">尚无发布历史。发布后可以回退到之前的配置版本。</p>')+'</div>';

  root.querySelector("#save-mail-credential").onclick=async()=>{
    const input=root.querySelector("#mail-credential");
    if(!input.value.trim()){toast("请填写邮件服务 API Key","warn");return}
    try {await api.post("/api/admin/invitation-config/email-credentials",{resend_api_key:input.value.trim()});
      input.value=""; toast("密钥已在服务端加密保存","ok");await render(root);
    }catch(e){toast(e.message,"warn")}
  };
  root.querySelector("#remove-mail-credential").onclick=async()=>{
    if(!await confirmBox("确定删除当前加密保存的邮件凭证？这将影响依赖该凭证的发信功能。",{title:"清除邮件凭证",ok:"清除"}))return;
    try{await api.del("/api/admin/invitation-config/email-credentials");toast("已清除加密凭证","ok");await render(root)}
    catch(e){toast(e.message,"warn")}
  };
  root.querySelector("#save-draft").onclick=async()=>{
    try {
      data=await api.patch("/api/admin/invitation-config",{expected_version:data.version,config:grab()});
      toast("草稿已保存，尚未上线","ok");await render(root);
    }catch(e){toast(e.message,"warn")}
  };
  root.querySelector("#preview-pdf").onclick=async()=>{
    try {
      if(!data.draft){toast("请先保存草稿，再生成预览 PDF","warn");return}
      const pid=root.querySelector("#preview-project").value;
      const type=root.querySelector("#preview-type").value;
      const q=new URLSearchParams({pid,type});
      await api.download("/api/admin/invitation-config/preview?"+q);
      toast("预览 PDF 已生成","ok");
    }catch(e){toast(e.message,"warn")}
  };
  root.querySelector("#publish").onclick=async()=>{
    if(!data.draft){toast("请先保存草稿","warn");return}
    const ok=await confirmBox("确认发布邀请函业务配置？新生成邀请函会立即使用此版本。",{title:"确认发布上线",ok:"确认发布"});
    if(!ok)return;
    try {data=await api.post("/api/admin/invitation-config/publish",{expected_version:data.version});
      toast("邀请函配置已发布，版本 v"+data.version,"ok");await render(root);
    }catch(e){toast(e.message,"warn")}
  };
  const rollback=root.querySelector("#rollback");
  if(rollback)rollback.onclick=async()=>{
    const version=Number(root.querySelector("#rollback-version").value);
    if(!await confirmBox("确认将业务配置恢复至 v"+version+"？此操作将生成新的发布版本。",{title:"回退上线配置",ok:"确认回退"}))return;
    try {data=await api.post("/api/admin/invitation-config/rollback",{expected_version:data.version,target_version:version});
      toast("已回退，当前发布版本 v"+data.version,"ok");await render(root);
    }catch(e){toast(e.message,"warn")}
  };
}
