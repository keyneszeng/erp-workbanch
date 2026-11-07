import { api, can, state } from "../lib/api.js";
import { badge, esc, formHtml, modal, panel, readForm, table, toast, validate } from "../lib/ui.js";

function associationPicker(selected=[]) {
  const values=new Set(selected||[]);
  return `<fieldset class="fld full" style="grid-column:1/-1"><legend>所属协会（可多选）</legend>
    <div class="chips" style="max-height:160px;overflow:auto">
      ${(state.meta.assocs||[]).map(a=>`<label class="chip" style="cursor:pointer">
        <input type="checkbox" data-assoc-pick value="${esc(a)}" ${values.has(a)?"checked":""}> ${esc(a)}
      </label>`).join("")}
    </div><small class="hint">总管理员天然拥有全平台权限；其他账号至少选择一个协会。</small>
  </fieldset>`;
}
function selectedAssocs(root) {
  return [...root.querySelectorAll("[data-assoc-pick]:checked")].map(x=>x.value);
}

// 已停用的旧部门仅作为当前值保留，避免编辑姓名/手机号时误改为“供应商”。
function departmentOptions(current = "") {
  const active = state.meta.depts || [];
  return [
    { v: "", l: "请选择部门" },
    ...(current && !active.includes(current)
      ? [{ v: current, l: "历史部门（待重新分类）" }]
      : []),
    ...active.map(d => ({ v: d, l: d }))
  ];
}

export async function render(root) {
  const d = await api.get("/api/users");
  const roles = state.meta.roles;
  const manage = can("user:manage");

  root.innerHTML = `<div class="phead">
      <div><h2>${state.demo ? "用户与权限" : "手机号白名单与权限"}</h2><p>${state.demo ? "总管理员默认拥有全部功能权限；其他账号由总管理员按需分配模块和操作权限" : "账号无角色默认权限；总管理员自行给每个账号授权"}</p></div>
      <div class="acts">${manage ? `<button type="button" class="btn btn-p" id="newU">+ ${state.demo ? "新建账号" : "录入手机号"}</button>` : ""}</div>
    </div>

    <div class="panel">
      <div class="panel-h"><h2>账号列表</h2><span class="hint">${d.rows.length} 个账号</span></div>
      ${table([{ t: "姓名", w: "90px" }, { t: state.demo ? "账号" : "白名单手机号", w: "140px" }, { t: "角色", w: "130px" }, { t: "所属协会", w: "130px" },
        { t: "部门", w: "90px" }, { t: "功能权限", w: "100px" }, { t: "状态", w: "70px" }, { t: "创建时间", w: "130px" }, { t: "操作", w: "110px" }],
        d.rows.map((u) => ({
          c: [esc(u.name), `<span class="mono">${esc(u.username)}</span>`,
            `<span class="role-tag ${u.role === "admin" ? "super" : ""}">${esc(u.role_name)}</span>`,
            esc(u.role==="admin" ? "全平台" : (u.assocs||[u.assoc]).filter(Boolean).join("、") || "—"), esc(u.dept === "会务部" ? "待重新分类" : (u.dept || "—")),
            u.role==="admin" ? "全部权限" : "独立分配",
            u.active ? badge("已启用") : badge("已停用"),
            `<span class="mono">${esc(u.created_at)}</span>`,
            manage ? `<button class="link" data-edit="${u.id}">编辑</button>${state.super?` <button class="link" data-user-access="${u.id}">分配权限</button>`:""}` : "—"]
        })), { empty: "暂无账号" })}
    </div>

    ${state.super ? `<div class="panel mt" id="assocManager">
       <div class="panel-h"><h2>协会分类管理</h2><button id="addAssoc" class="btn btn-p btn-sm">+ 增加协会</button></div>
       <p class="hint">仅总管理员可维护。已关联用户或项目的协会不可直接删除，以免丢失历史业务归属。</p>
       <div class="chips mt">${(state.meta.assocs||[]).map(n=>`<span class="chip"><b>${esc(n)}</b><button class="link danger" data-remove-assoc="${esc(n)}">停用</button></span>`).join("")}</div>
     </div>` : ""}
    <div class="panel"><div class="panel-h"><h2>按账号分配权限</h2></div><p class="hint" style="padding:12px 16px">除总管理员外，所有角色默认无内置功能权限。角色只表示身份和数据范围；总管理员在用户列表点击「分配权限」，独立授权模块与具体操作。</p></div>

    ${state.super && state.demo ? `<div class="panel danger-zone">
      <div class="panel-h"><h2>危险操作</h2><span class="hint">仅总管理员可见 · 不可恢复</span></div>
      <div style="padding:14px 16px">
        <div class="reset-warn" style="margin-bottom:12px"><div class="t">重置为出厂数据</div>
          清空全部项目、合同、付款、结算、材料、审计与账号，重新写入 18 场演示会议与 8 个演示账号。
          用于「演示环境数据乱了，重来一次」。
          <span style="color:var(--red);font-weight:700">删除不可恢复</span>，且所有人当场掉线，需要重新登录。</div>
        <button class="btn btn-d" id="resetAll">重置为出厂数据</button>
      </div>
    </div>` : ""}`;

  const ra = root.querySelector("#resetAll");
  if (ra) ra.onclick = () => openReset(root);

  root.querySelector("#addAssoc")?.addEventListener("click",async()=>{
    const name=await import("../lib/ui.js").then(m=>m.promptBox({title:"增加协会分类",label:"协会名称",ok:"增加"}));
    if(!name)return;
    try{await api.post("/api/associations",{name});state.meta.assocs=(await api.get("/api/associations")).rows;toast("协会已增加","ok");await render(root);}
    catch(e){toast(e.message,"warn");}
  });
  root.querySelectorAll("[data-remove-assoc]").forEach(btn=>btn.addEventListener("click",async()=>{
    const name=btn.dataset.removeAssoc;
    const ok=await import("../lib/ui.js").then(m=>m.confirmBox("确认停用 "+esc(name)+"？关联项目或账号的协会无法停用。",{title:"停用协会",ok:"确认停用"}));
    if(!ok)return;
    try{await api.del("/api/associations/"+encodeURIComponent(name));state.meta.assocs=(await api.get("/api/associations")).rows;toast("已停用","ok");await render(root);}
    catch(e){toast(e.message,"warn");}
  }));
  root.querySelectorAll("[data-user-access]").forEach(b=>b.onclick=()=>{
    const target=d.rows.find(x=>String(x.id)===b.dataset.userAccess);
    if(target)openAccessEditor(root,target);
  });
  const nb = root.querySelector("#newU");
  if (nb) nb.onclick = () => openCreate(root, roles);
  root.querySelectorAll("[data-edit]").forEach((b) => b.onclick = () => {
    const u = d.rows.find((x) => x.id === Number(b.dataset.edit));
    openEdit(root, u, roles);
  });
}

function openCreate(root, roles) {
  const fields = [
    ...(state.demo ? [{ k: "username", l: "登录账号", req: 1, ph: "3~20 位字母/数字" }] : []),
    { k: "name", l: "姓名", req: 1 },
    { k: "role", l: "角色", t: "select", req: 1, opts: roles.filter((r) => !r.super).map((r) => ({ v: r.key, l: r.name })) },
    
    { k: "dept", l: "部门", t: "select", req: 1, opts: departmentOptions() },
    { k: "phone", l: state.demo ? "电话" : "白名单手机号（11 位）", req: !state.demo, ph: "13800138000" },
    ...(state.demo ? [{ k: "password", l: "初始密码", req: 1, ph: "至少 8 位，含字母和数字" }] : [])
  ];
  const m = modal({ title: state.demo ? "新建账号" : "录入手机白名单", width: "600px", body: formHtml(fields)+associationPicker(),
    footer: `<button class="btn btn-o" data-x="0">取消</button><button class="btn btn-p" data-x="1">创建</button>` });
  m.querySelector('[data-x="0"]').onclick = () => m.classList.remove("open");
  m.querySelector('[data-x="1"]').onclick = async () => {
    if (!validate(m, fields)) return;
    try {
      const v = readForm(m);
      v.assocs=selectedAssocs(m);
      const r = await api.post("/api/users", v);
      toast(r.message, "ok");
      m.classList.remove("open");
      await render(root);
    } catch (e) { toast(e.message, "warn"); }
  };
}

/**
 * 重置为出厂数据（V1.2.22）。
 *
 * 三道确认，缺一不可：
 *   1. 按钮在「危险操作」区里，红底、和正常操作拉开距离；
 *   2. 弹窗先把**将要删除的数量**摆出来（18 个项目 / 14 笔付款…），不是只说「确定吗」；
 *   3. 必须手动输入「重置」两个字，按钮才启用 —— 防手滑、也防有人顺手点掉。
 *
 * 执行后 session 被清空，所有人都掉线，所以这里直接 reload 回登录页。
 */
async function openReset(root) {
  let d;
  try { d = await api.get("/api/admin/reset-preview"); }
  catch (e) { return toast(e.message, "warn"); }

  const chips = d.rows.filter((r) => r.count > 0)
    .map((r) => `<span>${esc(r.label)}<b>${r.count}</b></span>`).join("");

  const m = modal({
    title: "重置为出厂数据",
    width: "560px",
    body: `<div class="reset-warn"><div class="t">将删除以下全部数据</div>
        共 ${d.total} 条记录。重置后恢复 18 场演示会议与 8 个演示账号，
        <span style="color:var(--red);font-weight:700">删除不可恢复</span>。</div>
      <div class="reset-list">${chips || '<span>当前没有业务数据</span>'}</div>
      <div class="fld">
        <label>请手动输入「重置」两个字确认<span class="req">*</span></label>
        <input type="text" id="resetWord" placeholder="重置" autocomplete="off" spellcheck="false">
      </div>
      <div class="hint" style="margin-top:6px">执行后所有人会掉线，需要重新登录。</div>`,
    footer: `<button class="btn btn-o" data-x="0">取消</button>
      <button class="btn btn-d" id="doReset" disabled>确认重置</button>`
  });

  const word = m.querySelector("#resetWord");
  const go = m.querySelector("#doReset");
  word.oninput = () => { go.disabled = word.value.trim() !== "重置"; };
  word.onkeydown = (e) => { if (e.key === "Enter" && !go.disabled) go.click(); };

  m.querySelector('[data-x="0"]').onclick = () => m.classList.remove("open");
  go.onclick = async () => {
    go.disabled = true;
    go.textContent = "重置中…";
    try {
      const r = await api.post("/api/admin/reset", { confirm: "RESET-ALL-DATA" });
      toast(r.message || "已重置为出厂数据", "ok");
      setTimeout(() => location.reload(), 1200);
    } catch (e) {
      toast(e.message, "warn");
      go.disabled = false;
      go.textContent = "确认重置";
    }
  };
}

function openEdit(root, u, roles) {
  const fields = [
    { k: "name", l: "姓名", req: 1 },
    { k: "role", l: "角色", t: "select", req: 1, opts: roles.map((r) => ({ v: r.key, l: r.name })) },
    
    { k: "dept", l: "部门", t: "select", opts: departmentOptions(u.dept) },
    { k: "phone", l: state.demo ? "电话" : "白名单手机号", req: !state.demo },
    { k: "active", l: "账号状态", t: "select", opts: [{ v: "1", l: "启用" }, { v: "0", l: "停用" }] },
    ...(state.demo ? [{ k: "password", l: "重置密码（留空不改）", ph: "留空不改；至少 8 位，含字母和数字" }] :
      [{ k: "resetPassword", l: "重置为初始密码 123456（要求重新短信改密）", t: "select", opts: [{ v: "0", l: "不重置" }, { v: "1", l: "重置" }] }])
  ];
  const m = modal({ title: `编辑账号 · ${esc(u.name)}`, width: "600px", body: formHtml(fields, { ...u, active: String(u.active) })+associationPicker(u.assocs||[u.assoc]),
    footer: `<button class="btn btn-o" data-x="0">取消</button><button class="btn btn-p" data-x="1">保存</button>` });
  m.querySelector('[data-x="0"]').onclick = () => m.classList.remove("open");
  m.querySelector('[data-x="1"]').onclick = async () => {
    if (!validate(m, fields)) return;
    const v = readForm(m);
    const body = { name: v.name, role: v.role, assocs:selectedAssocs(m), dept: v.dept, phone: v.phone, active: Number(v.active) };
    if (state.demo && v.password) body.password = v.password;
    if (!state.demo && v.resetPassword === "1") body.resetPassword = true;
    try {
      const r = await api.patch(`/api/users/${u.id}`, body);
      toast(r.message, "ok");
      m.classList.remove("open");
      await render(root);
    } catch (e) { toast(e.message, "warn"); }
  };
}

/** 独立的账号功能授权弹窗。角色只标识岗位身份，不代表模块和操作权限。 */
async function openAccessEditor(root,user){
 let d;
 try{d=await api.get("/api/users/"+user.id+"/access");}
 catch(err){toast(err.message,"warn");return;}
 const mods=new Set(d.access.modules),perms=new Set(d.access.permissions);
 const names={
 "project:create":"创建立项","project:approve":"项目审批","project:transition":"推进项目阶段",
 "project:change":"修改项目/变更申请","change:execute":"执行预算变更",
 "project:member":"管理项目成员","contract:write":"录入及修改合同",
 "contract:approve":"合同审批","invite:manage":"企业/嘉宾邀请",
 "demand:write":"会务需求确认","payment:create":"付款申请",
 "payment:approve":"付款审批","payment:pay":"财务确认付款",
 "verify:check":"核销判定","verify:exception":"核销例外处理",
 "verify:exception_approve":"核销例外审批","verify:conclude":"核销结论",
 "settle:create":"生成结算单","archive:write":"项目归档",
 "archive:download":"自选材料PDF下载","material:write":"材料上传管理",
 "material:file:replace":"替换材料附件","audit:read":"查看审计日志",
 "export:any":"导出数据","user:manage":"用户与账号管理",
 "setting:write":"系统设置","ledger:read":"项目台账查看"
 };
 const cb=(key,label,group,checked)=>'<label class="chip" style="display:flex;align-items:center;gap:7px;margin:4px;cursor:pointer"><input type="checkbox" data-grant="'+group+'" value="'+esc(key)+'"'+(checked?" checked":"")+'><span>'+esc(label)+'</span></label>';
 const moduleRows=d.available_modules.map(m=>cb(m.k,m.n,"module",mods.has(m.k))).join("");
 const permissionRows=d.available_permissions.map(k=>cb(k,names[k]||k,"permission",perms.has(k))).join("");
 const m=modal({title:"权限分配 · "+esc(user.name),width:"760px",
  body:'<p class="hint">只修改当前账号的权限；不影响其他同角色账号。保存后此账号需重新登录。</p>'+
  '<div class="material-export-tools" style="margin-top:14px"><b>模块访问权限</b> <button type="button" class="link" data-grant-all="module">全选</button><button type="button" class="link" data-grant-none="module">清空</button></div>'+
  '<div class="chips" style="max-height:190px;overflow:auto">'+moduleRows+'</div>'+
  '<div class="material-export-tools" style="margin-top:16px"><b>具体操作权限</b> <button type="button" class="link" data-grant-all="permission">全选</button><button type="button" class="link" data-grant-none="permission">清空</button></div>'+
  '<div class="chips" style="max-height:250px;overflow:auto">'+permissionRows+'</div>'+
  (d.immutable?'<p class="hint">总管理员拥有全部权限，不允许取消授权。</p>':""),
  footer:'<button class="btn btn-o" data-x="0">取消</button><button class="btn btn-p" data-x="1"'+(d.immutable?" disabled":"")+'>保存授权</button>'});
 for(const group of ["module","permission"]){
  for(const kind of ["all","none"]){
   m.querySelector('[data-grant-'+kind+'="'+group+'"]').onclick=()=>
    m.querySelectorAll('[data-grant="'+group+'"]').forEach(x=>x.checked=kind==="all");
  }
 }
 if(d.immutable)m.querySelectorAll('input[data-grant]').forEach(x=>x.disabled=true);
 m.querySelector('[data-x="0"]').onclick=()=>m.classList.remove("open");
 const submit=m.querySelector('[data-x="1"]');
 submit.onclick=async()=>{
  if(submit.disabled)return;
  const selected=group=>[...m.querySelectorAll('[data-grant="'+group+'"]:checked')].map(x=>x.value);
  submit.disabled=true;submit.textContent="正在保存…";
  try{
   const result=await api.patch("/api/users/"+user.id+"/access",{
      modules:selected("module"),permissions:selected("permission")});
   toast(result.message||"已保存授权","ok");
   m.classList.remove("open");
   await render(root);
  }catch(err){toast(err.message,"warn");submit.disabled=false;submit.textContent="保存授权";}
 };
}
