# 协会会议执行 ERP

协会会议执行 ERP 的 Web 工作台及 API 服务。基于 Node.js 22+、SQLite 和原生 ES Module 前端，云端运行时使用 Cloudflare Workers + Durable Objects。覆盖会议立项审批、筹备执行、材料收集、合同与嘉宾邀请、六步核销、付款结算、数字归档和审计。

## 业务模块

- 会议项目与九状态流转、审批中心、任务和会务需求
- 合同台账、企业邀请和嘉宾邀请、PDF 预览、邮件及微信配置
- 六步核销门禁、付款结算与总管理员项目财务台账
- 五类角色的权限与数据范围：总管理员、协会管理员、会务执行、财务核销、普通用户/嘉宾
- 文件上传及下载、归档、审计日志、CSV/PDF 导出

## 环境隔离

**生产模式为默认值**（不设置 `ERP_DEMO_MODE` 或设为 `0`）。空数据库首次启动只创建一个 `admin` 管理员账号，需要提供至少 12 位、同时包含字母和数字的 `ERP_BOOTSTRAP_ADMIN_PASSWORD`。不加载任何演示项目或弱口令账号，管理端也不会提供整库重置功能。

**演示模式须显式开启 `ERP_DEMO_MODE=1`**。保留原始演示账号、角色、示例项目和演示业务数据，包括 `admin`、`assoc`、`exec`、`finance`、`guest`、`zhaolei`、`sunqian`、`zhoutao`，演示账号初始密码均为 `123456`。这些凭据只能访问完全隔离的演示库。

**生产数据库不得复用演示数据库。** 系统会拦截历史演示数据与生产模式混用，禁止用演示重置操作初始化生产环境。数据库迁移须先备份并按独立流程处理。

## Node 持久化部署

Node.js >=22.5，持久化数据目录，以及受信任的 HTTPS 反向代理。

```bash
npm install
export ERP_BOOTSTRAP_ADMIN_PASSWORD='从密钥管理器注入强密码'
export ERP_DB='/var/lib/erp/erp.db'
export ERP_UPLOAD_DIR='/var/lib/erp/uploads'
npm start
```

默认监听 `127.0.0.1:8787`；如位于受信任 HTTPS 反向代理后，配置 `ERP_TRUST_PROXY=1`。生产环境须单独配置备份、恢复、日志和监控。

## Cloudflare 生产部署

Cloudflare 由 `ERP_DB` Durable Object SQLite 提供持久化业务存储，生产模式**强制要求**存在 `ERP_FILES` R2 附件绑定及首次引导管理员密码。当前 `wrangler.jsonc` 仍指向现有演示域名 `erp.aibuild.work`，R2 绑定也尚未启用：在准备独立生产资源前**不得直接发布本分支**。

Vercel `/tmp` SQLite 不具备生产持久化条件，`api/index.js` 仅允许显式演示模式。

具体环境配置、上线门禁、备份与现有演示环境迁移注意事项参见 [生产部署指南](docs/production-deployment.md)。

## 目录

| 目录 | 职责 |
|---|---|
| `server/` | API、业务逻辑、数据库、权限、附件服务 |
| `web/` | Web SPA 与五角色工作台 |
| `worker/` | Cloudflare Worker 与 Durable Object 适配 |
| `miniprogram/` | 微信邀请确认入口，非完整 ERP 小程序 |
| `docs/` | 产品设计、业务基线和部署文档 |
| `test/` | 自动化回归与安全校验（只在开发/CI 中执行） |
| `api/` | 仅演示用途的 Vercel 入口 |

## 质量与发布

```bash
npm test
npm run test:cf
npm run cf:build
```

回归测试会在独立数据库下显式开启演示模式，不应指向真实业务库。Cloudflare 发布工作流仅支持从 `main` 手动触发。**生产型源码不等同于已通过生产验收**：附件存储、备份恢复、真实邮件/微信邀请、所有权限与财务动作仍须在正式环境逐项验证。
