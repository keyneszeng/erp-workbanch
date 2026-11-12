# Cloudflare：仅演示环境（不得部署生产系统）

**唯一用途：`erp.aibuild.work` 的演示版。**

- 本项目正式业务服务器指定为**阿里云 ECS**，不再创建 Cloudflare 生产 Worker / Durable Object / R2。
- `wrangler.jsonc` 固定 Worker 名为 `erp-workbanch`、域名为 `erp.aibuild.work`，并显式设置 `ERP_DEMO_MODE=1`。
- `worker/index.mjs` 与 `worker/do.mjs` 都加了运行时门禁：缺少演示标记或配置为生产模式时直接拒绝。
- 历史 `.github/workflows/cloudflare-deploy.yml` 已改为只做演示配置检查，**无上传、无部署步骤**。
- 历史 `npm run cf:deploy` 与 `scripts/check-production-deploy.cjs` 永久拒绝 Cloudflare 生产发布。
- `npm run cf:build` 仅是本地/CI dry-run 打包兼容性检查，不会更新在线演示站。
- 不得向演示 Worker 配置真实管理员手机号、生产短信凭据、真实会议/财务/嘉宾资料。
- 保留现有在线演示站及其历史数据；本次更改只影响后续源码，不触发实际演示站部署。

正式生产上线配置见 [阿里云 ECS 生产指南](production-deployment.md)。
