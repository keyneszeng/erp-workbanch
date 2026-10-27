import { api } from "../lib/api.js";
import { esc } from "../lib/ui.js";

const DEMO = [
  ["admin", "总管理员", "全部权限 · 全平台"],
  ["assoc", "协会管理员", "本协会 · 全流程"],
  ["exec", "会务执行", "授权会议 · 执行与取证"],
  ["finance", "财务与核销", "核销判定 · 付款结算"],
  ["guest", "普通用户 / 嘉宾", "仅本人数据"]
];

export function render(root, onSuccess) {
  root.innerHTML = `<div class="login-box">
    <div class="login-left">
      <div>
        <div class="sub">MEETING OPS ERP</div>
        <h1>协会会议执行 ERP</h1>
      </div>
      <p>从立项审批到数字卷宗，一条链跑完会议全生命周期。<br>核销是付款的唯一前置门，6 步 SOP 不可跳过。</p>
      <div class="login-points">
        <div><b>01</b><span>立项 → 审批 → 筹备 → 执行，9 状态 8 流转全程留痕</span></div>
        <div><b>02</b><span>6 步核销 + 例外单闭环，未核销项目付款直接拦截</span></div>
        <div><b>03</b><span>结算单生成即冻结结论，材料 8/8 才允许归档</span></div>
        <div><b>04</b><span>每个动作写审计日志，4W 可追溯、可导出</span></div>
      </div>
    </div>
    <div class="login-right">
      <div>
        <h2>登录工作台</h2>
        <div class="hint">使用分配给你的账号登录，权限与数据范围由角色决定</div>
      </div>
      <div class="login-err" id="lerr"></div>
      <form id="lform" autocomplete="off">
        <div class="login-field" style="margin-bottom:12px">
          <label>账号</label>
          <input name="username" placeholder="如 admin" autocomplete="username">
        </div>
        <div class="login-field">
          <label>密码</label>
          <input name="password" type="password" placeholder="演示密码 123456" autocomplete="current-password">
        </div>
        <button class="login-btn" type="submit" id="lbtn">登 录</button>
      </form>
      <div>
        <div class="hint" style="margin-bottom:7px">演示账号（点击自动填入，密码均为 123456）</div>
        <div class="demo-users">${DEMO.map(([u, n, d]) =>
          `<button class="demo-user" data-u="${u}"><b>${esc(n)}</b><span>${u} · ${esc(d)}</span></button>`).join("")}</div>
      </div>
      <div class="login-foot">生产版 v1.2.12 · 数据存储于 SQLite · 所有操作写入审计日志</div>
    </div>
  </div>`;

  const form = root.querySelector("#lform");
  const err = root.querySelector("#lerr");
  const btn = root.querySelector("#lbtn");

  root.querySelectorAll("[data-u]").forEach((b) => b.addEventListener("click", () => {
    form.username.value = b.dataset.u;
    form.password.value = "123456";
    form.password.focus();
  }));

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    err.style.display = "none";
    btn.disabled = true;
    btn.textContent = "登录中…";
    try {
      await api.post("/api/auth/login", { username: form.username.value.trim(), password: form.password.value });
      await onSuccess();
    } catch (ex) {
      err.textContent = ex.message;
      err.style.display = "block";
    } finally {
      btn.disabled = false;
      btn.textContent = "登 录";
    }
  });

  form.username.focus();
}
