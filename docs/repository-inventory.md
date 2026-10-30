# ERP 仓库架构与交付清单

> 2026-10-30 整改基线：以 `main` 版本 V1.2.23 为起点。生产代码、历史资料和演示账号应分开管理。本清单按**功能和代码职责**整理，而非将历史测试截图带入正式交付。

## 系统定位

本系统是协会会议执行 ERP，提供 Web 主工作台和后端接口，配套微信小程序的嘉宾邀请确认入口。覆盖会议立项、审批、筹备、执行、核销、付款结算、资料归档、审计。**微信小程序目前不是完整 ERP 客户端。**

## 代码结构

| 路径 | 用途 | 生产关注点 |
|---|---|---|
| `server/index.js` | Node 服务入口、迁移、启动和会话清理 | 持久化目录、进程管理、HTTPS 代理 |
| `server/lib/db.js` | Node SQLite / DO SQLite 的同步接口、表结构、迁移 | 备份、Schema 迁移、故障恢复 |
| `server/lib/seed.js` | 正式管理员首次引导和独立演示数据集 | 模式互斥、绝不自动覆盖真实数据 |
| `server/lib/runtime.js` | 生产/演示模式配置 | Secret 注入与环境隔离 |
| `server/lib/auth.js` | scrypt 口令、会话、限流和吊销 | 生产白名单账号初始密码统一 123456，但首次强制短信验证与修改 |
| `server/lib/rbac.js` | 角色、动作权限、数据范围 | API 服务端必须校验，不能只靠菜单 |
| `server/lib/workflow.js` | 会议流转与业务门禁 | 重要审批和结算动作不能绕过 |
| `server/lib/storage.js` / `ooxml.js` | 文件存储、附件类型及 Office 文档校验 | 阿里云生产持久化磁盘、演示 R2（可选）、附件访问控制 |
| `server/lib/prep-*.js` | 邀请函配置、邮件凭据和模板生成 | 发信密钥、正式模板、个人信息 |
| `server/api/` | HTTP 业务接口模块 | 身份、权限、事务、审计、错误处理 |
| `web/index.html` / `web/assets/` | 原生 SPA、页面、组件、样式 | 生产不展示演示登录入口 |
| `worker/` | Cloudflare Worker、DO、Node 请求适配 | 仅演示数据与 ERP_DEMO_MODE=1，禁止生产部署 |
| `api/index.js` / `vercel.json` | Vercel 演示型入口 | 临时数据库不允许正式生产 |
| `miniprogram/` | 微信邀请确认页 | 正式 AppID、审核、真实入口 |
| `.github/workflows/` | CI 回归与 Cloudflare 演示配置检查，不部署 | 校验通过后才允许人工发布 |
| `test/` | API、权限、流程、文件和安全自动回归 | 仅开发/CI 使用，不随前端静态资源发布 |

## API 业务模块

- `auth.js`：登录、退出、当前用户、改密及业务枚举
- `projects.js`：会议项目 CRUD、状态和项目详情
- `verify.js`：六步核销、例外单与条件门禁
- `finance.js`：合同、付款审批、结算及财务流程
- `demand.js`：会务需求确认与表单归档
- `files.js`：上传、下载、材料归属及文件类型
- `system.js`：用户、审计、工作台及系统管理（演示模式专属重置）
- `archive-pdf.js`：归档资料 PDF 输出
- `prep-invitations.js`：企业、嘉宾邀请及公开回复
- `prep-admin.js`：邀请函配置、发布与回退
- `project-ledger.js`：会议统一编号与总管理员财务台账

## 前端业务页面

`web/assets/js/pages/` 含登录、工作台、全流程、会议列表、项目详情、审批、核销、财务、合同、会务需求、材料、数字卷宗、审计、用户权限、邀请函配置、项目财务台账等页面。导航由 `lib/nav.js` 管理，HTTP 交互集中于 `lib/api.js`。

## 数据与账号

- 正式首次空库：只创建手机号 `ERP_BOOTSTRAP_ADMIN_PHONE` 对应的总管理员，初始密码为 `123456`，首次强制短信核验及改密；不生成演示业务数据。
- 演示数据库：显式 `ERP_DEMO_MODE=1`，保留 `admin`、`assoc`、`exec`、`finance`、`guest`、`zhaolei`、`sunqian`、`zhoutao` 八个账号及示例会议、资料、审批、付款数据。
- 正式库使用阿里云 ECS 本地持久化 SQLite + 附件目录；Cloudflare Durable Object 仅存演示数据，禁止复用或直接重置。

## 保留的产品资料

| 文档 | 职责 |
|---|---|
| `docs/产品设计方案_V1.0.2.md` | 原始产品设计与工作流 |
| `docs/ERP_现网审阅与重梳理基线_2026-10-29.md` | 业务基线、功能覆盖、缺口和阶段规划 |
| `docs/会议编号与总管理员项目台账_2026-10-29.md` | 财务会议编号和台账口径 |
| `docs/筹备阶段_企业与嘉宾邀请模板_V1.md` | 邀请函业务模板 |
| `docs/production-deployment.md` | 正式生产部署和验收 |
| `docs/cloudflare-secure-deployment.md` | Cloudflare 发布安全与密钥 |

历史测试报告、QA 截图、一次性验收工作流、单文件原型和截图脚本已从整改分支移除。完整变更记录仍可通过 Git 历史查看；**自动化回归代码仍保留**。

## 尚未完成的生产环境验收

1. 阿里云 ECS 实例、HTTPS/备案、生产独立域名、持久化数据库和附件配置。
2. 真实组织授权、个人信息和会议资料处理的合规核查。
3. 阿里云 ECS SQLite 与附件的定期备份、恢复演练和回滚方案。
4. 真实邮件/微信渠道投递与小程序正式审核、完整业务客户端开发。
5. 性能容量与并发、日志监控、告警、角色权限和全流程人工业务验收。

**本清单记录源码能力及交付边界，不表示未完成的外部配置已经开通或生产业务已经验收。**
