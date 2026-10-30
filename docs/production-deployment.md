# 协会会议执行 ERP · 生产部署与手机号白名单

## 生产系统的认证与白名单规则

- 生产模式默认启用（ERP_DEMO_MODE=0）：以中国大陆 11 位手机号作为唯一登录账号，**无自助注册**。
- 首次生产初始化**必须录入 ERP_BOOTSTRAP_ADMIN_PHONE**，只创建该手机号对应的总管理员。总管理员初始密码固定为 123456，首次登录必须先短信核验并修改密码，才能使用任何业务功能。
- 仅总管理员能够通过「手机号白名单与权限」录入、修改、停用、重置其他业务角色账户；非总管理员无法通过 API 管理白名单。管理界面禁止创建或提升第二个总管理员，也不能改动部署指定的总管理员手机号。
- 新列入白名单的用户初始密码均为 123456。每次自助修改密码要求验证原密码、新强密码以及发送至白名单手机号的短信验证码。修改/重置手机号需要再次完成首次验证与改密。
- 后端禁止未完成初始密码修改的账号调用业务接口。停用、改角色、改手机号、管理员重置密码和用户成功改密都吊销旧会话。
- 手机号采用数据库唯一索引及接口校验。验证码只保存带盐哈希，有效期 5 分钟、间隔 60 秒、当日最多 10 次、单码最多试错 5 次；验证码不应返回 API 客户端。
- 演示模式 ERP_DEMO_MODE=1 保留已有 8 个账号与 18 条项目，不强制短信。生产和演示必须使用相互独立的数据库、存储和域名。
- 旧版生产数据库若管理员并非手机号形式，将**拒绝自动接管**；必须先备份并执行受控身份迁移，不能静默覆盖原账号。

## 接入腾讯云 SMS 验证码服务

1. 在腾讯云开通短信，完成签名及验证码模板审核，获得短信 SDK AppID、签名、模板 ID、具有最小发送权限的 SecretId/SecretKey。模板的两个参数按顺序分别是 6 位验证码与有效期分钟数（5）。
2. 配置正式环境变量 ERP_SMS_PROVIDER=tencent、ERP_TENCENT_SECRET_ID、ERP_TENCENT_SECRET_KEY、ERP_TENCENT_SMS_APP_ID、ERP_TENCENT_SMS_SIGN、ERP_TENCENT_SMS_TEMPLATE_ID；可选 ERP_TENCENT_SMS_REGION=ap-guangzhou。
3. 配置 ERP_BOOTSTRAP_ADMIN_PHONE（首次部署总管理员真实手机）。绝不能在源码、PR、日志或公开的 Wrangler 配置中写入短信密钥。
4. 服务通过 HTTPS 调用 sms.tencentcloudapi.com。生产缺少真实短信配置则拒绝启动，不会静默跳过短信验证。发送实际短信会由供应商计费，须设置短信额度及防刷告警。
5. 自动化测试**仅**允许同时设置 NODE_ENV=test、ERP_SMS_PROVIDER=test、ERP_SMS_TEST_MODE=1。正式环境禁止模拟验证码。
6. 短信只证明验证码接收时对手机号的控制，不等于核验手机号码法定实名身份；如需身份证实名校验，应另外采购合规运营商实名认证/三要素服务。

## Cloudflare Worker 上线

1. 为正式生产准备**独立** Worker、Durable Object SQLite、R2 附件桶和生产域名，不得覆盖 erp.aibuild.work 演示域名。仓库当前默认 wrangler.jsonc 仍是演示资源配置，不可直接覆盖生产环境。
2. Cloudflare Worker Secrets 中预先配置 ERP_BOOTSTRAP_ADMIN_PHONE、ERP_SMS_PROVIDER 及所有 ERP_TENCENT_* 变量，另外设置独立 ERP_SECRET；不能只配置 GitHub Actions 变量，因为 GitHub vars 不会自动传入 Worker。
3. 正式环境必须绑定 ERP_FILES 持久化 R2 桶。缺少桶时 Durable Object 启动会拒绝。
4. GitHub Actions 配置 CLOUDFLARE_API_TOKEN、CLOUDFLARE_ACCOUNT_ID secrets 以及 ERP_PRODUCTION_DOMAIN、ERP_HEALTHCHECK_URL、ERP_BOOTSTRAP_ADMIN_PHONE、ERP_SMS_PROVIDER=tencent vars 供上线预检检查。
5. Cloudflare 发布为仅 main 分支手动触发，先进行回归和部署预检。完成真实短信发送、角色权限、备份/恢复、附件读写、业务流全链测试后才可宣布正式上线。

## Node 与 Vercel

- Node.js >=22.5；ERP_DB、ERP_UPLOAD_DIR 必须使用持久化目录；生产要求 HTTPS 反向代理及定期加密备份。敏感环境变量使用安全配置注入。
- Vercel 现有临时 SQLite 入口是**演示专用**，不能作为生产系统。

## 正式上线验收清单

- [ ] 总管理员真实手机号与手机唯一性、白名单角色管理权限已验证
- [ ] 腾讯云短信签名/模板通过审核，真实验证码收到且有效
- [ ] 首次及后续改密、验证码频控、旧会话失效、停用登录拒绝已实测
- [ ] 生产独立数据库、R2、Worker、HTTPS 域名与回滚、备份已完成
- [ ] 核销、结算、合同、邮件微信邀请、个人信息保护要求已验收

**短信供应商、真实号码、Cloudflare 生产资源尚未配置并验收前，不得宣称已经生产上线。**
