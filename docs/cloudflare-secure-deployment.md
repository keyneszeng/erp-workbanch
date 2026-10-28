# Cloudflare Workers 自动部署配置

**请勿在聊天、Issue、PR、代码文件或 Actions 日志中粘贴 API Token。** 如已通过聊天明文发送，建议吊销该 Token，生成范围最小的新 Token。

## GitHub 仓库凭证（必须在 GitHub Secrets 配置）

在仓库 `Settings → Secrets and variables → Actions → New repository secret` 中分别添加：

| Secret 名称 | 值 |
| --- | --- |
| `CLOUDFLARE_API_TOKEN` | Cloudflare 后台创建的 API Token |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare Account ID |

这两个值都通过加密 Secrets 读取；不要提交进 `.github/workflows/*.yml` 或 `wrangler.jsonc`。

Token 应至少覆盖目标账号的 Workers 脚本编辑与目标域名相关的路由/域名发布权限。不要使用全局 API Key。根据 Cloudflare 提示精确收窄作用域。

## 自动部署条件

- `main` 上的 **ERP QA regression** 运行成功后触发 `ERP Cloudflare deployment`；
- 分支或 PR 的测试成功不能触发正式部署；
- 部署前重新运行 `npm test`，任何测试失败都阻止发布；
- 只部署通过测试的精确 Git commit SHA；
- 通过 `cloudflare/wrangler-action@v4` 执行 `wrangler deploy`；
- 部署后验证 `https://erp.aibuild.work/api/health`；
- 两个 Secret 任一个缺失，工作流直接失败，不尝试发布，也不泄露 Secret 值。

可以在 GitHub → Actions → ERP Cloudflare deployment 点击 **Run workflow** 手动重试（仅 main）。

## 边界

- 配置文件：`wrangler.jsonc`，Worker `erp-workbanch`，自定义域名 `erp.aibuild.work`，Durable Object `ERP_DB`。
- R2 上传绑定当前在 `wrangler.jsonc` 中默认注释；如需要云端照片/PDF 上传，应先按隐私和合规要求配置 R2。部署不应假设 R2 已启用。
- 本工作流不重置数据库或执行 `seed --reset`。
- 首次上线前确认 Cloudflare 账户与自定义域名属于该账号，并核对演示数据的备份需求。
