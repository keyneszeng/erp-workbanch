# 云服务器测试环境部署（分支：云服务器测试版本）

## 这个分支为什么存在

生产环境的两个前置条件还没就绪：

1. **域名未完成 ICP 备案** —— 阿里云会拦截中国内地 ECS 的 80 / 443 端口，域名访问直接不通；
2. **短信签名与模板未审核通过** —— 生产强制「首次登录必须短信验证码改密」，短信不通就等于进不去系统。

但业务流程需要先在真实服务器、真实数据库上跑一遍。所以这个分支只做两件事：

- 把对外端口换成 **8080 纯 HTTP**，用 IP 直接访问，绕开备案前置条件；
- 把短信换成 **console 通道**，验证码写进服务器日志，不发真实短信。

**除此之外，一切与生产相同**：真实 SQLite、真实 RBAC、真实审批与核销状态机、真实文件上传。
这不是「宽松环境」，只是「缺两个外部依赖的环境」。

## 与生产的差异（全表）

| 项 | 生产（`main`） | 测试（本分支） |
|---|---|---|
| `ERP_DEPLOY_TARGET` | `aliyun-ecs` | `aliyun-ecs-test` |
| 访问方式 | `https://域名`（80/443 + 证书） | `http://IP:8080`（纯 HTTP） |
| 短信 | `aliyun` / `tencent`，真实发送 | `console`，写日志不发送 |
| 应用端口 | 8787 | 8788 |
| 代码目录 | `/opt/erp-workbanch` | `/opt/erp-test` |
| 数据目录 | `/var/lib/erp` | `/var/lib/erp-test` |
| 环境文件 | `/etc/erp-workbanch/production.env` | `/etc/erp-workbanch/test.env` |
| systemd | `erp.service` | `erp-test.service` |
| 门禁 | `check-aliyun-production.cjs` | `check-aliyun-test.cjs` |
| 域名要求 | 必填且不能是演示域名 | 可留空 |

两套环境在同一台机器上**可以并存**，数据库、端口、目录、服务名全部隔离，互不影响。

## 服务器要求

- Ubuntu 22.04 / Debian 12，2 核 2G 起
- 安全组放通 **22**（限可信来源）、**8080**（测试访问）
- 不需要域名，不需要证书，不需要备案

## 部署

在 ECS 上以 root 执行：

```bash
# 1. 拉本分支代码
git clone -b 云服务器测试版本 https://github.com/keyneszeng/erp-workbanch.git
cd erp-workbanch

# 2. 一键部署（手机号填你自己的，用于登录）
sudo ERP_TEST_FIXED_SMS_CODE=654321 \
     bash deploy/aliyun/deploy.sh --test --admin-phone 13800000000
```

脚本会完成：装 Node 22 → 建服务账户 → 拉代码 → 装依赖 → 生成 `test.env`（自动生成 `ERP_SECRET`）→ 跑测试环境门禁 → 装 systemd → 配 Nginx 8080 → 健康检查 → 装每日备份。

失败会直接停在那一步并打印原因，不会带着半成品启动。

### 参数说明

| 参数 | 作用 |
|---|---|
| `--test` | 切到测试模式（不写这个参数就是生产模式） |
| `--admin-phone` | 总管理员手机号，首次登录用，必填 |
| `ERP_TEST_FIXED_SMS_CODE` | 可选，6 位数字。设了之后验证码固定为该值，方便多人同时验收 |

不设固定验证码也可以，验证码会打到日志里：

```bash
journalctl -u erp-test | grep SMS-CONSOLE
```

## 首次登录

1. 浏览器打开 `http://<ECS公网IP>:8080`
2. 页面顶部会有橙色横幅「测试环境 · 仅供功能验证，非正式业务系统」
3. 用 `--admin-phone` 填的手机号登录，初始密码 `123456`
4. 系统强制改密 → 点「发送短信验证码」→ 填固定码 `654321`（或日志里的码）→ 设新密码
5. 改完即可进入业务

## 日常操作

```bash
systemctl status erp-test          # 状态
journalctl -u erp-test -f          # 实时日志（验证码也在这里）
systemctl restart erp-test         # 重启
```

**更新代码**：在 ECS 上重新执行部署命令即可，脚本是幂等的——新版本落到 `releases/` 新目录，`current` 软链切过去，数据库和附件不动。

**回滚**：

```bash
ls /opt/erp-test/releases/
ln -sfn /opt/erp-test/releases/<旧版本> /opt/erp-test/current
systemctl restart erp-test
```

**备份**：每日 03:20 自动执行，SQLite 用 `.backup` 保证一致性，附件同步镜像，保留 30 天，位置 `/var/lib/erp-test/backup`。

## 验证脚本

```bash
npm run test-env:check   # 只检查环境变量是否合规，不启动服务
npm run test-env:login   # 本地跑一遍「登录 → 改密 → 进业务」全链路
```

## 什么时候切到生产

三件事齐了再切，缺一件都不要切：

- [ ] 域名 ICP 备案通过
- [ ] 短信签名与模板审核通过（拿到 AccessKey、签名、模板 Code）
- [ ] 测试环境全流程验收完成：立项 → 报需求 → 合同签署审批 → 六步核销 → 付款 → 结算 → 归档

切换方式：在 ECS 上用 `main` 分支执行生产模式部署（`deploy.sh --domain ... --email ...`），生产环境独立于测试环境，不需要先卸载测试版。

## 硬性约束

- **禁止录入真实业务数据**。这个库随时可能被重置，且跑在纯 HTTP 上，数据不加密传输。
- **不要把 8080 端口长期对公网开放**。验收结束后关掉安全组规则，或直接停掉服务。
- **不要在这个分支上开发新功能**。它只是部署形态的差异，功能改动要回 `main`，否则两边会持续分叉。
