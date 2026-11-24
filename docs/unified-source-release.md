# 会规智云 · 统一代码源与环境发布规范

**生效日期：2026-11-24。唯一正式业务代码分支：`main`。**

## 统一范围

Web 工作台（`web/`）、Node API / SQLite（`server/`）、微信小程序（`miniprogram/`）、
Cloudflare 演示适配器（`worker/`）、环境部署脚本（`deploy/`）和回归测试（`test/`）
全部来自同一个受测 Git 提交。**不是将不同部署环境的数据库或账号合并到一起**。

| 环境 | 代码来源 | 独立运行配置 |
| --- | --- | --- |
| ECS 测试 | `main` | `/opt/erp-test`；`/var/lib/erp-test`；`test.env`；`erp-test.service`；端口 8788 / Nginx 8080；测试 SMS |
| ECS 生产 | 经过测试批准的同一个 `main` SHA | `/opt/erp-workbanch`；`/var/lib/erp`；`production.env`；`erp.service`；端口 8787 / HTTPS；真实 SMS |
| Cloudflare 演示 | 仅审核后按需从 `main` 构建 | `ERP_DEMO_MODE=1`；专用演示数据、账号和资源 |
| 微信小程序 | 同一 `main` 中的 `miniprogram/` | AppID/合法 HTTPS 域名需单独审核并发布；API 指向 ECS 生产，绝不指向演示站 |

## 研发合并

1. 功能研发和 BUG 修复以 `main` 为起点创建短期工作分支。
2. PR 必须通过 Node 全量回归、Cloudflare DO-SQLite 兼容和浏览器黑盒测试。
3. 审查业务状态机、权限、合同、核销、财务证据与数据迁移风险后合并到 `main`。
4. `云服务器测试版本`、`production-ready-20261030` 等旧名称仅作历史追溯，**禁止作为新的部署代码源**；已有历史差异要独立审查，绝不直接把旧分支合并到当前业务逻辑。
5. 不自动改写线上服务器文件或生产数据。代码合并、云服务器部署、微信小程序发布是三个独立动作。

## ECS 发布顺序与同源校验

先在 ECS 测试环境从 `main` 部署，执行测试并验收：

```bash
sudo ERP_TEST_FIXED_SMS_CODE=654321 bash deploy/aliyun/deploy.sh --test --admin-phone 13800000000
cat /opt/erp-test/current/.revision  # 完整 40 位 SHA
```

如果测试与生产同处一台 ECS，生产部署会自动以测试版 `.revision` 的完整 SHA 作为批准值。
如果分处不同 ECS，需要发布人核对并显式传入测试已验收的相同 SHA：

```bash
export ERP_APPROVED_SHA=<通过验收的40位main提交SHA>
sudo --preserve-env=ERP_APPROVED_SHA bash deploy/aliyun/deploy.sh --domain prod.example.com --admin-phone 13800000000
```

正式环境实际还必须具备ICP备案/HTTPS/短信签名与密钥等条件；任何条件不满足均禁止发布。
若 `main` 在测试后继续变化，必须重新在测试环境部署与验收该提交。脚本只允许从 `main` 拉代码，
拒绝直接指定旧测试分支。两环境的业务代码 SHA 相同，数据库、文件、凭据绝不可共享。

## 数据与回滚保护

- 上线前对 SQLite 做一致性备份，并备份附件目录，验证备份可恢复。
- `.revision` 只标记**代码来源**，不证明 API、数据迁移、OCR 和微信端在真实环境已经验收通过。
- 回滚应用版本不能自动撤销已经执行的数据库迁移，需独立审查兼容性与恢复方案。
- 不删除历史分支、不覆盖生产数据库或生产密钥；历史分叉功能需审查后另开 PR。
- Cloudflare 演示 Worker **不得**发布生产数据或启用生产模式。

## 版本对齐检查

```bash
# 查看当前统一代码版本
git rev-parse HEAD
# 查看测试环境实际部署版本（在测试 ECS）
cat /opt/erp-test/current/.revision
# 查看生产环境实际部署版本（在生产 ECS）
cat /opt/erp-workbanch/current/.revision

# 两份 revision 内容必须完全一致，才可称为“代码已在两台服务器统一”。
# 生产升级仍必须经过环境预检和人工业务验收。
```
