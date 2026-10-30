import { api, can, state } from "../lib/api.js";
import { badge, esc, formHtml, modal, panel, readForm, table, toast, validate } from "../lib/ui.js";

export async function render(root) {
  const d = await api.get("/api/users");
  const roles = state.meta.roles;
  const manage = can("user:manage");

  root.innerHTML = `<div class="phead">
      <div><h2>用户与权限</h2><p>角色决定模块可见性与动作权限；总管理员为超级角色，拥有全部权限与全平台数据</p></div>
      <div class="acts">${manage ? '<button class="btn btn-p" id="newU">+ 新建账号</button>' : ""}</div>
    </div>

    <div class="panel">
      <div class="panel-h"><h2>账号列表</h2><span class="hint">${d.rows.length} 个账号</span></div>
      ${table([{ t: "姓名", w: "90px" }, { t: "账号", w: "110px" }, { t: "角色", w: "130px" }, { t: "所属协会", w: "130px" },
        { t: "部门", w: "90px" }, { t: "状态", w: "70px" }, { t: "创建时间", w: "130px" }, { t: "操作", w: "110px" }],
        d.rows.map((u) => ({
          c: [esc(u.name), `<span class="mono">${esc(u.username)}</span>`,
            `<span class="role-tag ${u.role === "admin" ? "super" : ""}">${esc(u.role_name)}</span>`,
            esc(u.assoc || (u.role === "admin" ? "全平台" : "—")), esc(u.dept || "—"),
            u.active ? badge("已启用") : badge("已停用"),
            `<span class="mono">${esc(u.created_at)}</span>`,
            manage ? `<button class="link" data-edit="${u.id}">编辑</button>` : "—"]
        })), { empty: "暂无账号" })}
    </div>

    <div class="panel">
      <div class="panel-h"><h2>角色权限矩阵</h2><span class="hint">★ 表示该角色可见模块</span></div>
      <div class="tw"><table><thead><tr><th>模块</th>${roles.map((r) => `<th>${esc(r.name)}${r.super ? " ★全部" : ""}</th>`).join("")}</tr></thead>
        <tbody>${state.meta.modules.map((m) => `<tr><td><b>${esc(m.n)}</b><div style="font-size:11.5px;color:var(--mute)">${esc(m.d)}</div></td>
          ${roles.map((r) => `<td>${r.modules.includes(m.k) ? '<span style="color:var(--green);font-weight:700">✓</span>' : '<span style="color:var(--mute)">—</span>'}</td>`).join("")}</tr>`).join("")}
        </tbody></table></div>
      <div class="chips mt">${roles.map((r) => `<span class="chip"><i>${esc(r.name)}</i><b>${esc(r.scope)}</b></span>`).join("")}</div>
    </div>

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

  const nb = root.querySelector("#newU");
  if (nb) nb.onclick = () => openCreate(root, roles);
  root.querySelectorAll("[data-edit]").forEach((b) => b.onclick = () => {
    const u = d.rows.find((x) => x.id === Number(b.dataset.edit));
    openEdit(root, u, roles);
  });
}

function openCreate(root, roles) {
  const fields = [
    { k: "username", l: "登录账号", req: 1, ph: "3~20 位字母/数字" },
    { k: "name", l: "姓名", req: 1 },
    { k: "role", l: "角色", t: "select", req: 1, opts: roles.map((r) => ({ v: r.key, l: r.name })) },
    { k: "assoc", l: "所属协会", t: "select", opts: [{ v: "", l: "（全平台）" }, ...state.meta.assocs] },
    { k: "dept", l: "部门", t: "select", opts: state.meta.depts },
    { k: "phone", l: "电话" },
    // V1.2.17 SEC-04：不再预填 123456 —— 预填等于「新建即弱口令」
    { k: "password", l: "初始密码", req: 1, ph: "至少 8 位，含字母和数字" }
  ];
  const m = modal({ title: "新建账号", width: "600px", body: formHtml(fields),
    footer: `<button class="btn btn-o" data-x="0">取消</button><button class="btn btn-p" data-x="1">创建</button>` });
  m.querySelector('[data-x="0"]').onclick = () => m.classList.remove("open");
  m.querySelector('[data-x="1"]').onclick = async () => {
    if (!validate(m, fields)) return;
    try {
      const r = await api.post("/api/users", readForm(m));
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
    { k: "assoc", l: "所属协会", t: "select", opts: [{ v: "", l: "（全平台）" }, ...state.meta.assocs] },
    { k: "dept", l: "部门", t: "select", opts: state.meta.depts },
    { k: "phone", l: "电话" },
    { k: "active", l: "账号状态", t: "select", opts: [{ v: "1", l: "启用" }, { v: "0", l: "停用" }] },
    { k: "password", l: "重置密码（留空不改）", ph: "留空不改；至少 8 位，含字母和数字" }
  ];
  const m = modal({ title: `编辑账号 · ${esc(u.name)}`, width: "600px", body: formHtml(fields, { ...u, active: String(u.active) }),
    footer: `<button class="btn btn-o" data-x="0">取消</button><button class="btn btn-p" data-x="1">保存</button>` });
  m.querySelector('[data-x="0"]').onclick = () => m.classList.remove("open");
  m.querySelector('[data-x="1"]').onclick = async () => {
    if (!validate(m, fields)) return;
    const v = readForm(m);
    const body = { name: v.name, role: v.role, assoc: v.assoc || null, dept: v.dept, phone: v.phone, active: Number(v.active) };
    if (v.password) body.password = v.password;
    try {
      const r = await api.patch(`/api/users/${u.id}`, body);
      toast(r.message, "ok");
      m.classList.remove("open");
      await render(root);
    } catch (e) { toast(e.message, "warn"); }
  };
}
