# Cloudflare 部署安全说明

- 生产部署由 GitHub Actions 从 `main` **手动触发**，不再因自动 QA 成功直接推送现有线上环境。
- 必要 GitHub Actions secrets：`CLOUDFLARE_API_TOKEN`、`CLOUDFLARE_ACCOUNT_ID`，均使用最小授权；禁止粘贴到聊天、Issue、PR、代码或日志。
- 生产 Worker Secret：首次空库引导使用 `ERP_BOOTSTRAP_ADMIN_PASSWORD`；邮件配置使用 `ERP_MAIL_CONFIG_KEY`。
- Cloudflare 生产模式需要 `ERP_DB` Durable Object 和 `ERP_FILES` R2 附件存储；后者当前尚未在仓库默认配置中启用。
- 当前默认域名 `erp.aibuild.work` 为历史演示环境，生产必须另建独立资源，不能直接切换旧数据库模式。
- 部署前运行 `npm test`、`npm run cf:build`，部署后确认功能及权限并验证备份和恢复。

详见 [完整生产部署指南](production-deployment.md)。
