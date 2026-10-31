# 协会会议执行 ERP · 阿里云 ECS 正式生产部署指南

## 环境定义（2026-10-30 最终决定）

| 用途 | 位置 | 允许的运行模式 |
|---|---|---|
| `erp.aibuild.work` 演示版 | Cloudflare Workers / Durable Object | `ERP_DEMO_MODE=1`，仅演示账号与数据 |
| 正式业务系统 | **阿里云 ECS Linux 服务器** | `ERP_DEPLOY_TARGET=aliyun-ecs`，`ERP_DEMO_MODE=0` |
| Vercel | 临时演示 | 仅 `ERP_DEMO_MODE=1`，不可存真实数据 |

**禁止在 Cloudflare 部署生产代码或生产业务。** GitHub Cloudflare 发布工作流已改成只检查不部署；阿里云上线只能经 ECS 环境预检和后续人工授权发布。当前未准备 ECS 实例、生产域名、密钥，不执行任何在线部署。

## 生产帐号白名单及安全要求

- 正式部署空库时必须配置 `ERP_BOOTSTRAP_ADMIN_PHONE`（真实中国大陆 11 位手机号），只创建该手机号对应的总管理员。
- 只有总管理员有权管理其他角色的白名单。手机号是唯一的正式登录账号，不开放自助注册，禁止创建第二个总管理员。
- 初始密码一律 `123456`，首次登录**只能进入短信验证与改密页面**，改成符合强度要求的密码后才能访问业务 API。
- 日常改密同样要求旧密码、强新密码和发往白名单登记手机号的短信验证码；更换手机号或重置密码重新强制验证。
- 验证码有效期 5 分钟，发送间隔 60 秒、每日最多 10 次、单码至多错误 5 次；数据库仅保存带随机盐的验证码哈希。
- 正式短信验证码默认走**阿里云短信（Dysmsapi）**，与 ECS 同云，链路和计费都在一个账号下：配置 `ERP_SMS_PROVIDER=aliyun`、`ERP_ALIYUN_SMS_ACCESS_KEY_ID`、`ERP_ALIYUN_SMS_ACCESS_KEY_SECRET`、`ERP_ALIYUN_SMS_SIGN_NAME`、`ERP_ALIYUN_SMS_TEMPLATE_CODE`（区域默认 `cn-hangzhou`）。需先在阿里云短信控制台完成签名与模板审核。腾讯云 SMS 适配层保留兼容（`ERP_SMS_PROVIDER=tencent` + `ERP_TENCENT_*`），两者择一即可。
- 短信验证码仅能证明收信时对号码的控制，不等于运营商实名身份认证；如需实名要求，另行对接合规实名核验服务。
- 生产、演示数据库、附件、用户账户和域名完全隔离；旧生产账号数据不能被新规则自动接管，迁移必须事前备份和受控执行。

## 计划部署架构

```text
用户浏览器
    │ HTTPS / TLS
    ▼
阿里云 ECS 公网域名（另行确定，非 erp.aibuild.work）
    │
    ▼
Nginx :443（反向代理 / TLS 终止）
    │ 127.0.0.1:8787
    ▼
Node.js 22+ / systemd erp.service
    ├─ SQLite: /var/lib/erp/erp.db（持久化）
    ├─ 附件: /var/lib/erp/uploads（持久化）
    └─ 阿里云短信 Dysmsapi（验证码发送；腾讯云 SMS 保留兼容）
```

ECS 安全组仅按需对外放通 443、证书验证可能用到的 80；SSH 22 限制可信来源，绝不放通 8787 或 SQLite 数据库端口。Nginx 证书签发后再启用 `deploy/aliyun/nginx-erp.conf.example` 模板，必须替换其中示例域名和证书路径。生产服务器直接使用 Node 本地持久化磁盘存附件，**不需要 Cloudflare R2 / Durable Object**。

**地域与备案：**若 ECS 位于中国内地并对外使用域名提供网站服务，需按相关规定先办理 ICP 备案或相应接入手续；正式选址后再核对阿里云官方要求。若部署在非中国内地地域，备案要求不同，但其他数据安全和合规要求仍适用。

## ECS 交付模板（不会自动创建服务器）

- `deploy/aliyun/production.env.example`：复制到 `/etc/erp-workbanch/production.env`，填入真实服务器/短信/管理员参数。禁止把真实配置提交 Git；文件设为仅受授权用户读取（如 `chmod 600`）。
- `deploy/aliyun/erp.service`：部署到 `/etc/systemd/system/erp.service`。使用非 root 的 `erp` 服务账户，服务启动前执行环境检查，绑定本机 `127.0.0.1:8787`，`systemd` 管理自动重启。
- `deploy/aliyun/nginx-erp.conf.example`：Nginx HTTPS / Web 反向代理参考模板；获得证书后替换示例域名再通过 `nginx -t` 验证。
- `scripts/check-aliyun-production.cjs`：不连接阿里云、不部署，只检查运行目标、手机白名单、真实短信通道（阿里云或腾讯云）、强 Secret、HTTPS 对外域名及持久化路径等参数，**缺少任何一项即拒绝生产启动**。

在 ECS 上准备相应目录、Node 22、Nginx、非 root 用户、独立生产数据库文件及安全凭据，管理员审核后才可启用服务。安装路径及 Node 可执行路径必须与 `erp.service` 保持一致。

检查示例：

```bash
# 在 ECS 上，加载私有生产环境配置后执行；请勿打印环境变量内容。
set -a
. /etc/erp-workbanch/production.env
set +a
node scripts/check-aliyun-production.cjs
# 检查通过后，按发布窗口经人工确认启用：
# sudo systemctl daemon-reload
# sudo systemctl enable --now erp.service
# sudo nginx -t && sudo systemctl reload nginx
```

> 以上仅为上线操作模板。示例命令尚未在实际 ECS 服务器上运行，不代表成功部署。

## 数据备份与回滚要求

- 数据库使用 SQLite WAL 时不能直接在运行中单独复制 `.db` 文件，否则可能遗漏 WAL 中的事务。生产备份应使用 SQLite Online Backup API、`sqlite3 .backup` 或经过验证的一致性快照机制。
- 附件目录与数据库需执行同一备份周期并校验文件引用；备份加密、异地保留、按期恢复演练。
- 升级先进行应用版本留档、数据库结构评审与备份；如迁移已写入数据，回滚代码不一定能回滚数据，需独立恢复预案。
- 首次上线应核验真实短信发收、手机号唯一性、会话吊销、角色授权、财务核销、归档、上传和邀请函外部投递、HTTPS 安全以及日志告警。

## 微信小程序与正式 API

正式阿里云 ECS 可为 Web 和微信小程序提供同一 `/api`，服务层鉴权包括登录态、角色权限、项目数据范围、审批状态机与初始密码强制更改。小程序另提供 `/api/mini/auth/*`：微信临时 code 换 OpenID、手机号白名单 + 密码 + SMS 绑定、Bearer 会话、强制改密、退出失效。绑定手机号发生变更或密码被管理员重置时解除原微信绑定。

ECS 的 `production.env` 默认 `ERP_MINIPROGRAM_ENABLED=0`；上线小程序前填真实 `ERP_WECHAT_APP_ID`、`ERP_WECHAT_APP_SECRET` 并设为 1。小程序 `miniprogram/config.js` 必须配置独立生产 HTTPS API 域名，同时通过微信平台合法域名审核。演示版和生产版严格隔离。详见 `miniprogram/README.md`。

## 当前状态

- [x] Cloudflare 生产发布通道禁用、Worker 演示模式限制
- [x] 阿里云 ECS 生产预检 + systemd / Nginx / 环境变量模板
- [ ] 阿里云 ECS 服务器与地域、生产域名、证书及（适用时）ICP备案
- [ ] 真实总管理员手机号、安全环境变量、短信签名模板审核与送达验证
- [ ] 持久化目录权限、自动备份与灾难恢复演练
- [ ] 生产环境全流程黑盒验收、监控、告警与正式发布

**生产代码准备就绪不等于真实生产服务已上线。**


## 忘记密码：手机短信验证与重置（2026-10-31）

生产用户在登录页选择「忘记密码」后，先向 `POST /api/auth/password/reset/request` 提交白名单手机号。接口无论账号是否存在或被停用都返回相同文案，且不返回验证码；验证码仅发往绑定手机号。短信挑战仍使用现有短信通道（默认阿里云 Dysmsapi）、五分钟有效、六十秒冷却、每号每日十次以及每个验证码最多五次尝试。新增 SQLite 持久化请求频率限制（IP 与手机号双维度），同时适用于 Cloudflare Durable Object 和 Node SQLite。

凭短信验证码、新密码和确认密码调用 `POST /api/auth/password/reset/confirm`。服务端核验短信和新密码策略后原子更新密码哈希、重置初始改密状态、提高 token_ver、吊销所有旧会话，再签发当前新登录会话。用户无需知道旧密码；停用账号不能找回；演示模式不开放这两个公开 API。禁止将短信验证码写入日志、API 返回或浏览器持久存储。

上线前须启用真实短信通道、校验签名模板和手机投递，检查 Cloudflare WAF 与 IP 限流规则，并在浏览器完成忘记密码、旧 Cookie 失效、验证码重放、过期和频率上限的黑盒测试。


## 2026-10-31 业务流程修订（PR #17）

- **立项负责人及会务需求负责人**：生产端仅可通过 `GET /api/users/assignable?assoc=...` 选择同协会在职账号，写入用户 ID。服务端强制验证有效成员及协会归属；旧 `/api/users/pickable` 保留兼容其他项目成员操作。历史姓名数据需要按已在册成员重新确认，不自动猜测重名者。
- **合同签署**：录入「草稿」可提交签署；录入「待签署」或选「已签署」时，在生产端发起「合同审批」，不可直接伪造已签署。协会管理员或总管理员审批后标记「已签署」并记录签署日期；驳回则退回草稿。非总管理员的合同录入人与审核人不得为同一人。
- **核票**：核销第六步必须上传发票原件，输入核对后的发票总金额，且与项目中已签署合同总金额相等才可标记通过。核票通过后冻结合同新增及签署流转，防止账面金额漂移。
- **付款**：只有完成六步核销的项目能发起申请；生产端必须填写发票号，已挂账加本次金额不得超过核票金额。协会管理员或总管理员负责付款审批，财务人员负责登记账户与执行付款，双方复用同一业务账本及审计。
- **结算**：禁止零付款直接结算、禁止尚有待审批/已审批付款、禁止实际支付金额和经核销的发票金额不一致。财务确认完成全部付款后，才可生成结算单并冻结账目。

该版本的 `已付款` 表示系统内财务人员确认付款完成，**不代表已集成银行回执或自动支付**。如要求资金到账证明，需要后续对接银行回单/付款流水对账系统。生产上线前须执行 `npm test`、`npm run test:cf`（仅兼容性测试）、微信端和浏览器业务全流程黑盒验收；不能以 PR 存在代替通过。

