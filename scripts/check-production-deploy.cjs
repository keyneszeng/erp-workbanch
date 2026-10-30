"use strict";
// 永久关闭旧有的 Cloudflare 生产发布检查/发布入口。
// 不依赖可覆盖的环境变量，防止任何人沿用历史 CI 或 npm 命令误发布。
console.error("禁止：正式生产型代码不能部署到 Cloudflare。erp.aibuild.work 仅保留演示版。");
console.error("生产部署目标为阿里云 ECS，请在生产服务器执行 npm run prod:check。");
process.exitCode = 1;
