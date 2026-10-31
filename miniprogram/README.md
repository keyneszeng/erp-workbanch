# 协会会议执行 ERP · 微信小程序端（生产代码）

一套阿里云 ECS 生产 API 同时服务 Web 与微信小程序。**erp.aibuild.work 仅是 Cloudflare 演示版，正式小程序绝不可连接它。**

## 页面与能力
- `pages/home` 工作台及角色权限导航
- `pages/bind` 微信身份 + 手机白名单账号密码 + 真实短信绑定；初始密码用户必须同时设置新密码
- `pages/projects` 会议列表（复用后端项目范围和参与者脱敏）
- `pages/project` 会议详情（沿用后端角色字段裁剪）
- `pages/approvals` 待审批和审批通过/驳回（复用原有双人复核和状态机）
- `pages/materials` 选择项目、拍照/相册、原始二进制文件上传及材料归档
- `pages/account` 短信改密、失效会话和退出
- `pages/invite` 公众邀请函查看、PDF 和确认/拒绝（token 访问）

## 上线步骤
1. 微信公众平台注册企业小程序，取得真实 AppID/AppSecret；服务器环境配置 `ERP_MINIPROGRAM_ENABLED=1`、`ERP_WECHAT_APP_ID`、`ERP_WECHAT_APP_SECRET`；**AppSecret 只保存在 ECS**。
2. 修改 `miniprogram/config.js` 的 `apiBase` 为实际阿里云 HTTPS 域名 + `/api`。目前的 `production.example.com` 是阻断意外上线的占位符。
3. 修改 `project.config.json` 的 `appid`，在微信后台登记该正式服务器为 `request/downloadFile` 合法域名，校验 TLS 和域名资质。
4. 在 ECS 配置独立持久化库、Nginx 代理、阿里云短信（Dysmsapi）、超级管理员手机号。执行 `npm run prod:check`；完成短信发收、业务授权、真机上传、微信审核的实测后发布。
5. 微信登录 `wx.login` 返回临时 code，ECS 单独调用 `auth.code2Session` 得到 OpenID，不向小程序输出微信 `session_key`。首次绑定额外检查白名单手机号+密码+短信验证码。后续已绑定用户凭新的微信 code 自动登录。Bearer 会话存在同一 SQLite `sessions` 表，后端权限完全一致；退出、停用和改密后原会话失效。

## 生产 API
- `POST /api/mini/auth/login`：`{code}`，仅已绑定用户
- `POST /api/mini/auth/sms/send`：`{phone,password}`，向白名单手机号发送绑定验证码
- `POST /api/mini/auth/bind`：`{code,phone,password,smsCode,newPassword?}`，首次绑定及必须改密时填新密码
- `GET /api/mini/auth/me`：`Authorization: Bearer <accessToken>`
- `POST /api/mini/auth/sms/send-password`、`POST /api/mini/auth/password`：已登录小程序短信改密
- `POST /api/mini/auth/logout`：吊销小程序本次会话
- 其余复用 `/api/dashboard`、`/api/projects`、`/api/projects/:id`、`/api/approvals`、`/api/uploads`、`/api/projects/:id/materials` 等服务器已有业务接口。上传的 `POST /api/uploads?pid=...` 使用原始字节流，不使用 multipart/form-data。

## 安全与限制
- Cloudflare 演示 Worker 永不开放生产小程序身份绑定。
- 小程序存储的是业务会话访问令牌；绝不保存 AppSecret、短信密钥或微信 session_key。
- 更换微信账号绑定需受控解绑流程，目前不在客户端提供自助换绑。不要通过修改数据库绕过短信验证。
- 以上是真实集成代码，不等于已获微信小程序审核、真机测试或阿里云 ECS 上线。
