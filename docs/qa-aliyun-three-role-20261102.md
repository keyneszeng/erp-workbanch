# 阿里云三角色真实站点 QA 手册（2026-11-02）

## 运行边界

- 适用环境：阿里云 **测试版**，不用于生产库；本指南的脚本**不会重置数据库**。
- 测试角色：总管理员 \`admin\`、会务执行人员 \`exec\`、财务 \`finance\`；输入真实手机号和各自密码。
- 不在脚本、GitHub Issue、Pull Request、CI 公共日志、命令行参数中保存实际密码。测试结果、页面截图及按钮清单只写 \`artifacts/live-regression/\`，仓库已忽略整个 \`artifacts/\` 目录。
- 不要通过公网明文 HTTP 提交账号密码。应在 ECS 本机运行，或通过 SSH 端口转发执行 Playwright。公网 8080 测试入口仅作临时验收。

## 先确定代码与服务一致

在 ECS 上核对实际发布版本，**不能根据 GitHub 分支名称判断当前服务已经部署**：

\`\`\`bash
readlink -f /opt/erp-test/current
git -C /opt/erp-test/current rev-parse HEAD
systemctl status erp-test --no-pager
curl -fsS http://127.0.0.1:8080/api/health
\`\`\`

2026-11-02 核对时，\`main\` 比 \`云服务器测试版本\` 分支领先 53 个提交。使用本文的脚本之前应先确认实际部署的 commit，避免旧前端与新测试脚本产生误报。按照仓库约定，业务修复应先在 \`main\` 评审合并，再由测试版单独发布；不要直接把所有待审更改推到在用测试数据库上。

## 三角色浏览器巡检（无业务数据写入）

安装 Node.js >= 22 和 Playwright Chromium（首次运行需要浏览器二进制）：

\`\`\`bash
npm install --no-save --no-package-lock playwright
npx playwright install chromium
\`\`\`

在能够访问测试站点的终端配置环境变量（仅示例变量名，**实际账号和密码请从私有环境注入**）：

\`\`\`bash
export ERP_QA_TARGET=aliyun-test
export ERP_BASE=http://127.0.0.1:8080
export ERP_QA_ADMIN_USER="<总管理员手机号>"
export ERP_QA_EXEC_USER="<执行人员手机号>"
export ERP_QA_FINANCE_USER="<财务手机号>"
read -r -s -p "管理员密码: " ERP_QA_ADMIN_PASSWORD; echo
read -r -s -p "执行人员密码: " ERP_QA_EXEC_PASSWORD; echo
read -r -s -p "财务密码: " ERP_QA_FINANCE_PASSWORD; echo
export ERP_QA_ADMIN_PASSWORD ERP_QA_EXEC_PASSWORD ERP_QA_FINANCE_PASSWORD

node test/ui/live-role-coverage.js
\`\`\`

从非服务器电脑运行时，先建立 SSH 本地端口转发，随后将 \`ERP_BASE\` 改为 \`http://127.0.0.1:18080\`（SSH 登录信息由运维自行填入）：

\`\`\`bash
ssh -N -L 18080:127.0.0.1:8080 <ECS-SSH-USER>@<ECS-IP>
\`\`\`

**检查内容**：三个账号登录及角色身份、侧栏**实际点击**与 URL 到达、功能按钮枚举、列表查询与标签切换、弹窗打开关闭、业务页签、导出、项目可见性、用户与权限页、无权限路由阻断、退出与未捕获 JS 错误。测试包括用户页面、项目、审批、合同、邀请、需求、核销、财务、材料、归档与审计等角色可见菜单，并保存逐项 PASS/FAIL/SKIP 记录。

**默认不会上传材料或执行任何不可逆审批**。如确需在可清理的测试数据上测上传，可主动设置 \`ERP_QA_ALLOW_UPLOAD=1\`；上传会在服务端留下记录。真正跨角色闭环（立项→执行待办→招商赞助→签合同→回款开票→核销→付款→归档）必须使用专门测试项目，确认不会触及已有业务数据；可先运行隔离数据库自动化测试：

\`\`\`bash
npm test
npm run test-env:login
\`\`\`

当前 \`npm test\` 已覆盖包括项目状态、角色权限、合同、赞助收入、付款/核销、OCR 相关规则等单元及 API 回归。但通过本地回归**不等于现场三个账号的按钮都通过**。

## 结果判定与修复回归

- \`artifacts/live-regression/role-button-coverage.json\`：每一项的角色、功能、PASS/FAIL/SKIP、实际现象。
- \`artifacts/live-regression/<role>-dashboard.png\`：各角色登录后页面截图；失败还会保存 \`<role>-ERROR.png\`。
- \`FAIL\`：必须先确认服务 commit、复现路径、请求状态码与服务日志，再定位代码；修复后在独立测试库回归，并重新运行该真实角色用例。
- \`SKIP\`：仅表示权限或前置状态不足、未开启可写测试，绝不能计入通过。
- 审计日志与附件包含敏感资料，QA 产物只在授权机器本地留存，排查完及时删除。
- 完成验收后轮换本次共享的三个登录口令，收紧公网 \`8080/tcp\` 安全组规则。
