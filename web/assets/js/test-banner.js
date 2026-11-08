/**
 * 测试环境横幅：只有 /api/health 返回 env=test 时才渲染。
 * 生产环境该请求返回 env=production，脚本直接退出，零副作用。
 * 目的：让人一眼看出这不是正式业务系统，避免测试数据被当真。
 */
(function () {
  fetch("/api/health", { headers: { accept: "application/json" } })
    .then(function (res) { return res.ok ? res.json() : null; })
    .then(function (data) {
      if (!data || data.env !== "test") return;
      var style = document.createElement("style");
      style.textContent =
        "#testEnvBanner{position:fixed;top:0;left:0;right:0;height:32px;z-index:9999;" +
        "display:flex;align-items:center;justify-content:center;gap:8px;" +
        "background:#b45309;color:#fff;font:600 13px/1 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;" +
        "letter-spacing:.4px;pointer-events:none}" +
        "body{padding-top:32px}" +
        ".layout{height:calc(100vh - 32px)}";
      document.head.appendChild(style);
      var bar = document.createElement("div");
      bar.id = "testEnvBanner";
      bar.textContent = "测试环境 · 仅供功能验证，非正式业务系统";
      document.body.insertBefore(bar, document.body.firstChild);
    })
    .catch(function () { /* 健康检查失败不影响页面使用 */ });
})();
