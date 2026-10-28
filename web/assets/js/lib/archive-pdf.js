import { api, state } from "./api.js";
import { toast } from "./ui.js";

/** 与服务端服务权限同口径：总管理或该会议所属协会管理员，且只能下载已归档会议。 */
export function canDownloadArchivePdf(p) {
  const me = state.user;
  return !!(p && p.status === "已归档" && me &&
    (me.role === "admin" || (me.role === "assoc" && me.assoc && me.assoc === p.assoc)));
}

export async function downloadArchivePdf(pid, button) {
  if (!pid || (button && button.disabled)) return;
  const original = button?.textContent || "资料下载";
  if (button) { button.disabled = true; button.textContent = "正在整理 PDF…"; }
  try {
    const result = await api.download("/api/projects/" + encodeURIComponent(pid) + "/archive-pdf");
    toast("资料下载成功：" + result.name, "ok");
  } catch (e) {
    toast("资料下载失败：" + (e.message || "请稍后重试"), "warn");
  } finally {
    if (button) { button.disabled = false; button.textContent = original; }
  }
}

/** 项目列表、数字卷宗页共用的动态下载按钮监听。 */
export function bindArchivePdfButtons(root) {
  root.querySelectorAll("[data-archive-pdf]").forEach((button) => {
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      downloadArchivePdf(button.dataset.archivePdf, button);
    });
  });
}
