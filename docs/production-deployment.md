# 协会会议执行 ERP · 生产部署与上线门禁

## 环境边界

- `ERP_DEMO_MODE` 缺省或 `0`：生产模式。空库只引导创建 `admin`，强制 `ERP_BOOTSTRAP_ADMIN_PASSWORD` 至少 12 位且同时含字母和数字。
- `ERP_DEMO_MODE=1`：演示模式。保留完整的 8 个演示账号和示例数据，并允许演示管理员重置。
- 生产与演示使用**独立数据库、独立附件存储、最好独立域名**。历史演示数据库保留 `seeded_at` 标记，不能直接启动为生产模式；已标记为生产的数据库不能被演示模式接管。
- 无自动删除或迁移现有数据。上线前先进行备份并制定受控迁移计划。

## Cloudflare 必须完成的配置

1. 为生产准备独立的 Worker 与 Durable Object SQLite，不复用现有 `erp.aibuild.work` 演示数据库。
2. 启用 R2，创建独立附件桶；在生产环境 `wrangler.jsonc` 配置 `ERP_FILES` 绑定。没有这个绑定，生产 Durable Object 将拒绝启动。
3. 通过 `wrangler secret put ERP_BOOTSTRAP_ADMIN_PASSWORD` 配置初始强密码。不要在源码、PR 或 Actions 日志写明密码。首次初始化后建议管理员立即改密。
4. 有真实邮件业务时设置 `ERP_MAIL_CONFIG_KEY` 及发信渠道；微信邀请仍需正式小程序 AppID、审核和实际投递验证。
5. GitHub Actions 配置 `CLOUDFLARE_API_TOKEN`、`CLOUDFLARE_ACCOUNT_ID`。生产发布工作流仅支持 `main` 手动执行，并会先运行 API 回归。
6. 修改仓库当前指向演示域名的 `wrangler.jsonc`，核对生产域名、R2、密钥后再部署，不能用默认配置覆盖现有演示环境。

## Node 部署

- Node.js >=22.5；`ERP_DB`、`ERP_UPLOAD_DIR` 必须为可靠的持久化路径，不可使用临时文件系统。
- 首次初始化配置 `ERP_BOOTSTRAP_ADMIN_PASSWORD`；登录后更改管理员密码并分配角色账号。
- 前置受信任的 HTTPS 反向代理（如 Nginx），只在可信代理后设置 `ERP_TRUST_PROXY=1`；配置访问日志及敏感字段脱敏。
- 对 SQLite 数据库（含 WAL 一致性）和附件执行同周期备份、加密保存，并验证恢复过程。
- 不要在生产环境执行 `seed:demo`；生产环境的重置 API 已禁用。

## Vercel 边界

现有 `/tmp` SQLite 各实例数据相互独立且不可长期持久化；Vercel 入口仅在明确设置 `ERP_DEMO_MODE=1` 时允许运行，不能用于正式业务。

## 发布前验收清单

- [ ] 独立的生产数据库、R2/附件桶和域名
- [ ] 强管理员初始密码、安全 Secret、HTTPS 与 Cookie Secure
- [ ] 五角色权限矩阵及协会/项目数据范围验证
- [ ] 上传、下载、合同 PDF、归档资料读写
- [ ] 立项审批、核销六步、付款及结算门禁真实流程
- [ ] 邮件、微信邀请的外部渠道配置和实际送达
- [ ] 数据备份恢复演练、回滚预案和错误告警
- [ ] 敏感数据处理和适用隐私/数据存储合规核查
- [ ] 自动化回归与人工业务验收通过

当前项目尚需验证生产 R2 实际开通、容量/性能、完整微信小程序、真实外部投递与备份恢复。以上未完成之前不得声称已经正式上线。
