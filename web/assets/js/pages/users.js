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
    </div>`;

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
    { k: "password", l: "初始密码", v: "123456" }
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

function openEdit(root, u, roles) {
  const fields = [
    { k: "name", l: "姓名", req: 1 },
    { k: "role", l: "角色", t: "select", req: 1, opts: roles.map((r) => ({ v: r.key, l: r.name })) },
    { k: "assoc", l: "所属协会", t: "select", opts: [{ v: "", l: "（全平台）" }, ...state.meta.assocs] },
    { k: "dept", l: "部门", t: "select", opts: state.meta.depts },
    { k: "phone", l: "电话" },
    { k: "active", l: "账号状态", t: "select", opts: [{ v: "1", l: "启用" }, { v: "0", l: "停用" }] },
    { k: "password", l: "重置密码（留空不改）", ph: "不修改请留空" }
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
