import { state } from "./api.js";
import { esc, modal, toast } from "./ui.js";

/** 与服务端服务权限同口径：总管理或该会议所属协会管理员，且只能下载已归档会议。 */
export function canDownloadArchivePdf(p) {
  const me = state.user;
  return !!(p && p.status === "已归档" && me &&
    (me.role === "admin" || (me.role === "assoc" && me.assoc && me.assoc === p.assoc)));
}

/**
 * 先预览、再下载。
 *
 * 归档资料是最终交付物，直接点下载等于闭着眼睛拿文件 —— 生成出来是什么样、
 * 六步核销的内容齐不齐，用户在下载前根本看不到。这里先拉一份 inline 的 PDF
 * 在弹窗里渲染，确认无误后再另存。
 *
 * 一次请求两用：预览用 Blob URL，下载复用同一个 Blob，不重复生成。
 */
export async function openArchivePdfPreview(pid, button) {
  if (!pid || (button && button.disabled)) return;
  const original = button?.textContent || "资料下载";
  if (button) { button.disabled = true; button.textContent = "正在生成 PDF…"; }
  let url = "";
  try {
    const res = await fetch(
      `/api/projects/${encodeURIComponent(pid)}/archive-pdf?preview=1`,
      { credentials: "same-origin" }
    );
    if (!res.ok) {
      const body = await res.json().catch(() => null);
      throw new Error(body?.error?.message || `生成失败（HTTP ${res.status}）`);
    }
    const blob = await res.blob();
    url = URL.createObjectURL(blob);
    const name = `核销六步记录_${pid}.pdf`;

    const m = modal({
      title: `核销资料预览 · ${esc(pid)}`,
      width: "960px",
      body: `<div class="hint" style="margin-bottom:8px">
          下面是最终 PDF 的实际内容（含核销六步的全部核验结果）。确认无误后再下载。
        </div>
        <iframe src="${url}" title="核销资料预览"
          style="width:100%;height:68vh;border:1px solid var(--line);border-radius:8px;background:#f2f4f7"></iframe>`,
      footer: `<a class="btn btn-p" href="${url}" download="${esc(name)}">下载 PDF</a>
               <button class="btn btn-o" data-close="1">关闭</button>`
    });
    // 关闭弹窗时释放 Blob，避免连续预览多个项目把内存堆住
    m.querySelectorAll("[data-close]").forEach((el) =>
      el.addEventListener("click", () => setTimeout(() => URL.revokeObjectURL(url), 500))
    );
  } catch (e) {
    if (url) URL.revokeObjectURL(url);
    toast("资料预览失败：" + (e.message || "请稍后重试"), "warn");
  } finally {
    if (button) { button.disabled = false; button.textContent = original; }
  }
}

/** 兼容旧调用点：按钮点击后进入「预览 → 下载」流程 */
export const downloadArchivePdf = openArchivePdfPreview;

/** 项目列表、数字卷宗页共用的动态下载按钮监听。 */
export function bindArchivePdfButtons(root) {
  root.querySelectorAll("[data-archive-pdf]").forEach((button) => {
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      openArchivePdfPreview(button.dataset.archivePdf, button);
    });
  });
}
