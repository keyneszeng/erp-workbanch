# ERP 演示、云服务器测试与生产代码治理清单

> 审阅基线：2026-11-01；main SHA `16992e037504d4f6cc7d00f9d1a7a20692b2ab33`（v1.2.23）。`云服务器测试版本` 分支额外包含三次部署相关提交；此治理文档与安全整改来自 `chore/staging-prod-separation-20261101`。**未获 PR 合并与部署验收前，不得宣称已上线。**

## 代码如何分层

| 层 | 目录 | 共用/专用 | 管理方式 |
|---|---|---|---|
| 业务 API、权限、状态机、SQLite | `server/` | 三种环境复用核心代码，数据不同 | 统一 main 审查、回归测试 |
| Web 工作台 | `web/` | 复用同一 SPA，环境标识不同 | 登录页生产不暴露演示账号 |
| 微信小程序 | `miniprogram/` | 连接独立生产 HTTPS API；不接演示地址 | 另需微信审核、真机验收 |
| Cloudflare Worker + DO | `worker/`、`wrangler.jsonc` | 仅 Demo | `ERP_DEMO_MODE=1`，永不发布生产 |
| Vercel 入口 | `api/`、`vercel.json` | 仅临时 Demo | 不可承载正式用户和持久业务 |
| ECS 系统服务/Nginx | `deploy/aliyun/` | Staging 与 Production 各自使用模板 | 单独服务、数据库、端口、域名 |
| 生产上线门禁 | `scripts/check-aliyun-production.cjs` | Production | HTTPS 域名、手机号、真实短信、密钥与持久化路径 |
| 测试上线门禁 | `scripts/check-aliyun-test.cjs` | Staging | 独立数据目录、本地端口、console SMS，禁止真实业务 |
| 自动化测试 | `test/`、`.github/workflows/qa.yml` | 开发/CI | 不部署测试工件，不执行生产数据库清理 |

## 部署契约

| 必须隔离 | Demo | Staging | Production |
|---|---|---|---|
| `ERP_DEPLOY_TARGET` | 无 ECS 生产目标 | `aliyun-ecs-test` | `aliyun-ecs` |
| `ERP_DEMO_MODE` | `1` | `0` | `0` |
| 数据库 | Cloudflare DO 演示库 | `/var/lib/erp-test/erp.db` | `/var/lib/erp/erp.db` |
| 附件 | 可选独立 R2 | `/var/lib/erp-test/uploads` | `/var/lib/erp/uploads` |
| Node 端口 | Worker 托管 | `127.0.0.1:8788` | `127.0.0.1:8787` |
| Nginx 入口 | Cloudflare | 仅本机 `127.0.0.1:8080` | 443/TLS、正式域名 |
| 身份 | 8 个演示账号（非真实） | 专用测试白名单 | 正式手机号白名单 + 真实短信 |
| 审计与备份 | 演示数据可重置 | 独立备份、仅合成数据 | 生产备份恢复演练、审计留存 |

## 当前代码已具备的生产能力

- 总管理员手机号首次初始化、白名单管理、角色范围控制、初始短信改密、忘记密码验证码重置和会话失效。
- 会议立项、筹备、邀请函、合同签署审批、核销及票据金额校验、付款审批/执行分离、结算冻结、数字卷宗与归档。
- Node SQLite 与 Cloudflare DO 适配，附件上传校验、审批及审计。
- Web 工作台与微信员工小程序代码；小程序尚需正式 API 域名、真实微信密钥及真机审核。

## 已确认的交付现状

1. GitHub main 最新 QA 运行于 2026-10-31，结果成功；这仅证明 CI 中被执行的检查通过。
2. main 尚未合并 `云服务器测试版本` 的部署脚本、环境模板、阿里云短信支持。后者在测试分支存在，不能将其视为 main 正式能力。
3. Cloudflare 自动部署工作流已改为仅检查演示配置，合并代码不会自动修改 `erp.aibuild.work`。
4. 阿里云生产 ECS、DNS/证书、短信真实发送、DB 备份恢复、完整线上黑盒并无本次可验证的完成记录。
5. 原测试分支监听公网 8080 + 固定/日志验证码，会暴露会话和凭据风险；本整改将 Nginx 默认绑定回环地址，访问必须通过 SSH 隧道。

## 合并与发布顺序

1. 在 PR 中运行 `npm test`、`npm run test:cf`、Cloudflare 兼容性 dry-run、部署门禁测试；审阅工作流，不允许触发部署。
2. 复核 Nginx 和 `deploy.sh` 对现有站点、环境密钥、升级回滚的影响，尤其是生产的证书申请、版本切换、数据库迁移与备份。
3. 安全审查后合并到 main。功能开发只进入 main，测试环境以参数选择交付，不维护长期分叉的业务代码。
4. 在没有客户数据的隔离 ECS 上先执行 staging dry-run，再正式安装；用 SSH 隧道做浏览器真实黑盒，记录失败、回滚与恢复结果。
5. 生产首次上线须单独批准：真实短信与手机号、HTTPS、备份恢复演练、最小权限、业务/安全/财务全链路验收全部完成；不能拿 CI 通过代替。

## 尚需关闭的风险

- `deploy.sh` 属于高权限运维程序，尚未在本次会话使用真实 ECS 完成可重复验收；不得直接用于未备份的生产主机。
- 依赖尚无提交的 `package-lock.json`，`npm install` 虽固定了主依赖版本，但传递依赖仍应通过可复现锁文件固化并进行供应链扫描。
- 测试环境 `console` 短信仅用于合成数据；不要把日志验证码或固定 OTP 传入公网。
- 生产环境需落实独立备份、告警、日志权限控制、数据保留策略、数据库迁移和回滚审批。
- 清理历史测试材料时，仅清理发布制品与独立 QA 报告；`test/` 自动化回归源文件必须保留。

参考：`README.md`、`docs/test-deployment.md`、`docs/production-deployment.md`、`docs/repository-inventory.md`。
