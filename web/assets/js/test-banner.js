/**
 * 环境提示横幅：系统已正式上线，正式版默认不显示。
 * 仅当内部调试需要时，在控制台执行 localStorage.setItem('showEnvBanner','1')
 * 才会渲染；正常情况下脚本零副作用。
 */
(function () {
  try { if (localStorage.getItem("showEnvBanner") !== "1") return; } catch (e) { return; }
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
      bar.textContent = "接口环境提示：当前连接测试标识（env=test）";
      document.body.insertBefore(bar, document.body.firstChild);
    })
    .catch(function () { /* 健康检查失败不影响页面使用 */ });
})();
