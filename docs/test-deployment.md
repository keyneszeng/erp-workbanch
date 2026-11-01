# 云服务器测试部署（Staging）— 仅通过 SSH 加密隧道访问

> **用途**：在独立 ECS 或测试机器上验证 Web、API、RBAC、合同、核销、文件上传与短信改密流程。只允许合成数据，禁止真实客户信息、真实付款账户与正式业务资料。**这不是正式生产系统或公网演示站。**

## 三种环境的边界

| 环境 | 入口 | 数据与账号 | 短信 | 代码 |
|---|---|---|---|---|
| Cloudflare 演示 | `erp.aibuild.work` | 独立的 8 个演示账号、18 个演示会议 | 不需要短信 | `worker/`，仅 `ERP_DEMO_MODE=1` |
| 阿里云测试 | 本机 `127.0.0.1:8080`，通过 SSH 隧道转发 | 独立 `/var/lib/erp-test`，合成数据 | `console`，在服务器日志中读取一次性验证码 | `ERP_DEPLOY_TARGET=aliyun-ecs-test` |
| 阿里云生产 | 独立的正式 HTTPS 域名 | 独立 `/var/lib/erp`，真实白名单和真实业务数据 | 正式阿里云或腾讯云短信 | `ERP_DEPLOY_TARGET=aliyun-ecs` |

测试和生产可以在同一 ECS 并存，但对正式业务，推荐使用独立实例、独立权限、独立备份与网络策略。**绝不共用数据库、附件、日志、环境文件、ERP_SECRET、短信账号和微信凭据。**

## 前置安全要求

- Ubuntu 22.04 / Debian 12；SSH 22 端口仅允许受信任运维来源访问。
- **不要在 ECS 安全组放通 8080；不要将测试 Nginx 绑定到 `0.0.0.0` 或 `[::]`。** 仓库模板固定监听 `127.0.0.1:8080`。
- 测试短信 `console` 会把验证码记录在 `journalctl` 中。只有受信任管理员可读取日志，不得将输出粘贴到工单、GitHub 或聊天记录。
- 仅使用合成的测试手机号和数据；避免在共享测试环境开启 `ERP_TEST_FIXED_SMS_CODE`。确需进行自动化演练时，用隔离的临时实例，结束后移除该变量并重启。
- 不得把使用端口 8080 视为备案、网络审查或合规要求的替代方案。需要公网访问时，应使用经合规审查的 HTTPS 测试域名与适用的接入手续。

## 安装与初次部署

> 目前安全整理在 PR 分支 `chore/staging-prod-separation-20261101`。合并到 main 之后使用 `--ref main` 即可；合并之前必须显式使用该分支，否则部署脚本默认克隆 main（尚无测试部署文件）。

```bash
git clone --branch chore/staging-prod-separation-20261101 https://github.com/keyneszeng/erp-workbanch.git
cd erp-workbanch

# 仅查看将执行的步骤
sudo bash deploy/aliyun/deploy.sh --test --admin-phone <专用测试手机号> \
  --ref chore/staging-prod-separation-20261101 --dry-run

# 准备好合成数据、SSH 和测试机器之后，才执行实际安装
sudo bash deploy/aliyun/deploy.sh --test --admin-phone <专用测试手机号> \
  --ref chore/staging-prod-separation-20261101
```

脚本创建 `erp-test.service`、`/etc/erp-workbanch/test.env`、`/var/lib/erp-test/erp.db`、`/var/lib/erp-test/uploads`，生成独立随机 `ERP_SECRET`，配置本地 8080 Nginx，完成服务健康检查并安装每日备份。代码默认安装于 `/opt/erp-test`，Node API 仅监听 `127.0.0.1:8788`。脚本可能安装系统软件和重启 Nginx，执行前应先检查现有站点与备份。

## 从个人电脑通过 SSH 访问

在**自己的电脑**终端中执行（将占位符替换为实际可访问的 ECS 用户和 IP）：

```bash
ssh -N -L 8080:127.0.0.1:8080 <ecs-user>@<ecs-public-ip>
```

保持该 SSH 会话运行，然后在**本地浏览器**打开：`http://127.0.0.1:8080`。

浏览器到本机转发端口为 loopback，跨网络的传输由 SSH 加密；不能直接使用 `http://<ECS公网IP>:8080`。如果 SSH 会话断开，页面将无法继续访问。

## 登录与功能验收

用测试专用管理员手机号和初始密码 `123456` 登录，服务会要求发送验证码并设置新密码。测试环境默认短信提供商为 `console`，验证码不会发送到手机；在 ECS 上由有权限的管理员读取：

```bash
sudo journalctl -u erp-test -n 100 --no-pager | grep SMS-CONSOLE
```

验收范围：首次改密与旧会话失效、白名单、五角色和跨协会隔离、会议立项及审批、合同签署审批、六步核销及发票金额、付款审批和执行、结算冻结、材料上传、归档、备份与恢复。浏览器顶部应出现“测试环境”横幅。

## 运维与回滚

```bash
sudo systemctl status erp-test
sudo systemctl restart erp-test
sudo systemctl status erp-test-backup.timer
```

新版本使用独立 release 目录，`/opt/erp-test/current` 指向当前版本；更新前先做一致性数据库与附件备份。回滚代码不一定能回滚数据库结构，存在数据迁移时必须按恢复演练结果操作。**不要把生产数据复制进测试库。**

## 切换生产环境的门禁

真正的生产发布不是把测试数据库搬到生产目录：必须从经审批的 main 代码部署到独立 ECS / 数据目录，配置正式 HTTPS 域名、证书、适用备案、真实短信、生产总管理员手机号与高熵密钥，并执行 `npm run prod:check`、完整 CI、备份恢复及黑盒验收。正式流程参见 [生产部署](production-deployment.md)。

**现状**：代码与部署模板仅为准备状态。没有证据证明本次已经在用户的 ECS 上执行部署或通过真实短信、真实浏览器、生产恢复演练。
