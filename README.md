# 会规智云

**会规智云**是本系统统一对外品牌名称，适用于 Web 工作台、微信小程序、电子邀请函与会务材料导出。`erp-workbanch`、`assoc-meeting-erp` 等仓库与程序标识仅用于代码和部署兼容，不作为对外品牌；修改品牌不改变业务流程、接口和历史数据。

会规智云的 Web 工作台、API 和微信嘉宾邀请确认入口。核心后端为 Node.js 22+ / SQLite，前端为原生 ES Module SPA，覆盖会议立项审批、筹备执行、合同和材料、核销、结算归档及审计。

## 环境边界（必须遵守）

| 环境 | 用途 | 部署位置 | 数据 |
|---|---|---|---|
| **演示版** | 界面体验与测试数据 | **Cloudflare：`erp.aibuild.work`** | 专用演示账号与演示项目 |
| **生产版** | 真实用户和真实业务 | **阿里云 ECS Linux 服务器（未来上线）** | 独立持久化 SQLite、附件目录、真实短信 |
| Vercel | 临时演示 | Vercel Serverless | 临时实例数据库，不承担生产 |

**生产代码不得部署在 Cloudflare。** 仓库的 Cloudflare 工作流已移除部署步骤；Worker / Durable Object 遇到非 `ERP_DEMO_MODE=1` 会拒绝服务，旧的 `npm run cf:deploy` 入口永久拒绝执行。现有 `erp.aibuild.work` 演示站不会因代码合并自动更新。未来如果更新演示站，也应使用独立且经过审查的演示交付流程，禁止上传真实客户数据、生产配置和密钥。

## 生产账号和短信登录

- 首次初始化必须提供总管理员手机号码 `ERP_BOOTSTRAP_ADMIN_PHONE`，只能创建该管理员。
- 仅总管理员可录入其他角色的手机号白名单、停用或重置账号；手机号是正式登录账号，不开放注册。
- 白名单账号统一初始密码为 `123456`；首次登录被强制要求短信验证并改密后才允许访问业务接口。后续改密同样需要原密码和短信验证码。
- 正式短信接口支持**阿里云短信（Dysmsapi，默认）**与**腾讯云 SMS**（兼容保留）。两家签名算法都已实现，切换只需改 `ERP_SMS_PROVIDER` 和对应凭据，无需改业务代码。
- 演示模式保留原有 `admin`、`assoc`、`exec`、`finance`、`guest`、`zhaolei`、`sunqian`、`zhoutao` 8 个账号及 18 个演示项目，密码均为 `123456`。演示账号不能访问真实生产库。

## 微信小程序生产端（本轮新增）

`miniprogram/` 已增加员工白名单 + 微信 `code2Session` 登录绑定、独立 Bearer 会话、项目列表/详情、审批、图片材料上传、短信改密和邀请函页面。后端在 `server/api/mini.js` 新增首次绑定、登录与改密接口，业务操作直接复用原 `/api/*` 项目权限及状态机，不复制一套无权限保护的服务。

**必须有真实微信 AppID/AppSecret、已审核的正式 API 域名、真实短信账号和 ECS 服务器才能部署；代码合并不会自动上线。** `ERP_MINIPROGRAM_ENABLED=0` 默认关闭，开启后生产预检要求微信密钥；旧 Cloudflare 演示域名不作为正式小程序接口。参见 [小程序接入说明](miniprogram/README.md)。

## 阿里云 ECS 生产部署准备（未正式上线）

部署环境需 Node.js >=22.5、持久化 `/var/lib/erp`、本机 Nginx HTTPS 反向代理、独立生产域名与证书，并在服务启动前安全配置：

```bash
# 仅在已配置服务器的 /etc/erp-workbanch/production.env 后运行。
# 此命令只检查，不创建实例、不发送短信、不发布服务。
set -a
. /etc/erp-workbanch/production.env
set +a
npm run prod:check
```

`deploy/aliyun/` 包含 `systemd` 服务、Nginx HTTPS 和环境配置模板，`deploy/aliyun/deploy.sh` 是一键部署脚本，`scripts/check-aliyun-production.cjs` 是生产上线门禁。强制独立持久化文件目录、安全 Secret、合法总管理员手机号、真实短信通道配置，禁止演示域名和 Cloudflare 生产模式。

**当前尚未实际提供阿里云 ECS 实例、生产域名、生产凭据、短信签名/模板或真实业务环境验收。因此仓库只完成生产部署准备，尚未上线。** 生产环境不直接使用演示数据库；上线前须完成备份恢复、真实短信、财务权限和个人信息合规核查。

详见 [阿里云生产部署指南](docs/production-deployment.md) 和 [Cloudflare 演示环境约束](docs/cloudflare-secure-deployment.md)。

## 唯一正式代码源：main（测试、生产、Web 与小程序共用）

自 2026-11-24 起，**GitHub `main` 是 Web 工作台、API、微信小程序和部署脚本的唯一业务代码基线**。ECS 测试、ECS 生产都从 `main` 构建，历史 `云服务器测试版本` 和 `production-ready-20261030` 分支只作为旧版本记录，不再作为部署来源。

测试与生产**代码一致、环境严格隔离**：测试使用独立数据库、附件、后台服务、HTTP 8080 及 console 短信；生产使用独立持久数据、真实短信和 HTTPS。Cloudflare 仅运行隔离演示数据，仍从审核后的 `main` 单独发布。

部署程序将完整 Git 提交 SHA 写入各自的 `.revision`。生产发布前必须先在测试环境验收**相同的 SHA**；同机优先读取 `/opt/erp-test/current/.revision`，如果测试在其他 ECS，则由发布者设置 `ERP_APPROVED_SHA`，提交不匹配或无验收依据会拒绝生产部署。历史分支未合并代码不得直接部署。

测试环境允许纯 HTTP + IP 用于验收，**禁止录入真实业务数据**。已完成的历史修复和新增功能均以 `main` 中的版本为准。参见 [统一发布规范](docs/unified-source-release.md)。
```bash
sudo ERP_TEST_FIXED_SMS_CODE=654321 bash deploy/aliyun/deploy.sh --test --admin-phone 13800000000
```

**该环境禁止录入真实业务数据**，验收完成后应关闭 8080 端口。详见 [云服务器测试环境部署](docs/test-deployment.md)。

## 开发与质量验证

```bash
npm install
npm test
npm run test:cf
npm run cf:build     # 仅检查 Worker 兼容性，不部署 Cloudflare
```

## 目录

| 路径 | 用途 |
|---|---|
| `server/` | Node 业务 API、SQLite、短信登录、权限与文件 |
| `web/` | 前端 Web 工作台 |
| `worker/` | 仅供 Cloudflare 演示版使用的适配层 |
| `deploy/aliyun/` | ECS systemd / Nginx / 环境变量模板 |
| `scripts/` | 阿里云上线校验、Cloudflare 生产发布拦截 |
| `miniprogram/` | 微信嘉宾邀请确认页，非完整 ERP 小程序 |
| `api/` | Vercel 临时演示入口 |
| `test/` | 隔离数据库下的回归测试 |
