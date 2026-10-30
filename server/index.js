"use strict";
const http = require("node:http");

const { migrate, DB_FILE } = require("./lib/db");
const { seed } = require("./lib/seed");
const { isDemoMode } = require("./lib/runtime");
const { pruneSessions } = require("./lib/auth");
const { ROLES } = require("./lib/rbac");
const { handle } = require("./lib/app");

const PORT = Number(process.env.ERP_PORT || 8787);
const HOST = process.env.ERP_HOST || "127.0.0.1";
// 版本号只认 package.json，避免启动横幅和 package.json 各说各话
const VERSION = (() => {
  try { return require("../package.json").version; } catch { return "?"; }
})();

migrate();
const seeded = seed();

// 请求处理逻辑已抽到 lib/app.js，Node 与 Cloudflare Worker 共用同一份
const handler = handle;

const server = http.createServer(handler);

function startLocalServer() {
  server.listen(PORT, HOST, () => {
    const line = [
      "",
      "  协会会议执行 ERP  ·  v" + VERSION,
      `  服务地址   http://${HOST}:${PORT}`,
      `  数据库     ${DB_FILE}`,
      `  种子数据   ${seeded.skipped ? "已存在，跳过" : `已初始化（${seeded.projects} 个项目 / ${seeded.users} 个账号）`}`,
      isDemoMode() ? "  演示账号   admin / assoc / exec / finance / guest，密码均为 123456" : "  运行模式   生产 · 不加载演示账号或演示业务数据",
      ""
    ].join("\n");
    console.log(line);
  });

  pruneSessions();
  setInterval(pruneSessions, 30 * 60 * 1000).unref();

  for (const sig of ["SIGINT", "SIGTERM"]) {
    process.on(sig, () => {
      console.log("\n正在关闭服务…");
      server.close(() => process.exit(0));
    });
  }
}

if (require.main === module) {
  startLocalServer();
} else {
  pruneSessions();
}

module.exports = { server, handler, ROLES };
