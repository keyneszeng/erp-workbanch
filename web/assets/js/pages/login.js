import { api } from "../lib/api.js";
import { esc } from "../lib/ui.js";

const DEMO = [
  ["admin", "总管理员", "全部权限 · 全平台"],
  ["assoc", "协会管理员", "本协会 · 全流程"],
  ["exec", "会务执行", "授权会议 · 执行与取证"],
  ["finance", "财务与核销", "核销判定 · 付款结算"],
  ["guest", "普通用户 / 嘉宾", "仅本人数据"]
];

export function render(root, onSuccess, { demo = false } = {}) {
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
        <h2>登录工作台<span style="${demo ? "display:inline-block;" : "display:none;"}margin-left:8px;padding:2px 9px;border-radius:999px;background:#fdf8ec;color:#b7791f;border:1px solid #f0dfb8;font-size:11px;font-weight:600;vertical-align:middle;letter-spacing:0">演示环境 · 数据非真实</span></h2>
        <div class="hint">${demo ? "使用演示账号登录" : "仅允许白名单手机号登录；初始密码 123456，首次必须短信验证并改密"}，权限与数据范围由角色决定${demo ? "；演示数据可由总管理员重置" : ""}</div>
      </div>
      <div class="login-err" id="lerr"></div>
      <form id="lform" autocomplete="off">
        <div class="login-field" style="margin-bottom:12px">
          <label>${demo ? "账号" : "白名单手机号"}</label>
          <input name="username" placeholder="${demo ? "如 admin" : "请输入登记的 11 位手机号码"}" autocomplete="${demo ? "username" : "tel"}" ${demo ? "" : 'inputmode="numeric" maxlength="11"'}>
        </div>
        <div class="login-field">
          <label>密码</label>
          <input name="password" type="password" placeholder="${demo ? "演示密码 123456" : "请输入密码"}" autocomplete="current-password">
        </div>
        <button class="login-btn" type="submit" id="lbtn">登 录</button>
      </form>
      ${demo ? "" : `<div style="margin-top:8px;text-align:right"><button type="button" class="link" id="forgotOpen">忘记密码？使用手机验证码找回</button></div>
      <div id="resetPane" style="display:none">
        <p class="hint" style="margin:12px 0">仅支持系统登记的手机号。验证短信后设置新密码，旧设备将全部退出。</p>
        <form id="resetForm" autocomplete="off">
          <div class="login-field" style="margin-bottom:12px">
            <label>登记手机号</label>
            <input name="phone" type="tel" inputmode="numeric" maxlength="11" autocomplete="tel" placeholder="11 位手机号" required>
          </div>
          <div class="login-field" style="margin-bottom:12px">
            <label>短信验证码</label>
            <input name="smsCode" inputmode="numeric" maxlength="6" autocomplete="one-time-code" placeholder="6 位验证码" required>
            <button type="button" class="btn btn-o btn-sm" id="resetSend" style="margin-top:8px">发送短信验证码</button>
          </div>
          <div class="login-field" style="margin-bottom:12px">
            <label>新密码</label>
            <input name="newPassword" type="password" autocomplete="new-password" placeholder="8~64 位，需包含字母和数字" required>
          </div>
          <div class="login-field">
            <label>确认新密码</label>
            <input name="confirmPassword" type="password" autocomplete="new-password" placeholder="再次输入新密码" required>
          </div>
          <button class="login-btn" type="submit" id="resetConfirm">验证手机并重设密码</button>
        </form>
        <button type="button" class="link" id="forgotBack" style="margin-top:12px">返回密码登录</button>
      </div>`}
      <div>
        <div class="hint" style="${demo ? "" : "display:none;"}margin-bottom:7px">演示账号（点击自动填入，密码均为 123456）</div>
        <div class="demo-users" style="${demo ? "" : "display:none;"}">${(demo ? DEMO : []).map(([u, n, d]) =>
          `<button class="demo-user" data-u="${u}"><b>${esc(n)}</b><span>${u} · ${esc(d)}</span></button>`).join("")}</div>
      </div>
      <div class="login-foot">${demo ? "演示环境 · 数据非真实" : "正式业务系统"} · 所有操作写入审计日志</div>
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


  if (!demo) {
    const pane = root.querySelector("#resetPane");
    const resetForm = root.querySelector("#resetForm");
    const send = root.querySelector("#resetSend");
    const resetConfirm = root.querySelector("#resetConfirm");
    const setError = (message) => { err.textContent = message; err.style.display = "block"; };
    const toggle = (show) => {
      err.style.display = "none";
      form.style.display = show ? "none" : "";
      pane.style.display = show ? "" : "none";
      root.querySelector("#forgotOpen").style.display = show ? "none" : "";
      if (show) {
        resetForm.elements.phone.value = form.elements.username.value.trim();
        resetForm.elements.phone.focus();
      } else form.elements.password.focus();
    };
    root.querySelector("#forgotOpen").onclick = () => toggle(true);
    root.querySelector("#forgotBack").onclick = () => toggle(false);

    send.onclick = async () => {
      const phone = resetForm.elements.phone.value.trim();
      if (!/^1[3-9]\\d{9}$/.test(phone)) return setError("请输入有效的 11 位登记手机号");
      err.style.display = "none";
      send.disabled = true;
      send.textContent = "发送中…";
      try {
        const response = await api.post("/api/auth/password/reset/request", { phone });
        // Same message regardless of whether this number exists: account enumeration protection.
        const msg = root.querySelector("#resetNotice") || document.createElement("p");
        msg.id = "resetNotice";
        msg.className = "hint";
        msg.textContent = response.message;
        send.after(msg);
        send.textContent = "60 秒后可重发";
        window.setTimeout(() => { if (send.isConnected) { send.disabled = false; send.textContent = "重新发送验证码"; } }, 60000);
      } catch (ex) {
        setError(ex.message);
        send.disabled = false;
        send.textContent = "发送短信验证码";
      }
    };

    resetForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      err.style.display = "none";
      const data = {
        phone: resetForm.elements.phone.value.trim(),
        smsCode: resetForm.elements.smsCode.value.trim(),
        newPassword: resetForm.elements.newPassword.value,
        confirmPassword: resetForm.elements.confirmPassword.value
      };
      if (data.newPassword !== data.confirmPassword) return setError("两次输入的新密码不一致");
      resetConfirm.disabled = true;
      resetConfirm.textContent = "验证中…";
      try {
        await api.post("/api/auth/password/reset/confirm", data);
        await onSuccess();
      } catch (ex) {
        setError(ex.message);
      } finally {
        resetConfirm.disabled = false;
        resetConfirm.textContent = "验证手机并重设密码";
      }
    });
  }

  form.username.focus();
}
