# ERP V1.2.22 QA 自动整改记录（2026-10-28）

基线提交：`e57ffdaca3f79aefe50adf188c69922240dc2a72`

整改分支：`fix/qa-rbac-approval-20261028`

## 已落代码的整改

| QA 问题 | 改动 | 关联文件 |
|---|---|---|
| 嘉宾看到内部财务、合同、审批 | 对 GET /api/projects 列表、详情裁剪信息；工作台隐藏金额/日志；限制核销详情、需求导出与项目日志 | `server/api/{projects,system,verify,demand}.js`, `web/assets/js/pages/{project,projects,dashboard}.js` |
| 跨协会立项与修改归属 | 协会管理员及有协会归属的会务执行人员不可在别的协会创建项目；非总管理员不可通过编辑修改协会 | `server/api/projects.js` |
| 付款/审批空请求默认通过 | 要求 `approve` 为真正的布尔值；缺省或字符串返回 400，且不能修改业务状态 | `server/api/{finance,verify}.js` |
| 未绑定文件仅凭 key 可读取 | 上传绑定 user ID 和项目；未登记 key 返回 404，非所有者返回 403；嘉宾不能读取内部业务附件 | `server/api/files.js`, `server/lib/db.js` |
| 文件 key 可跨用户/跨项目挂单 | 新增挂接校验，阻止其他人或跨会议重复引用文件 | `server/lib/upload-ownership.js`, `server/api/{finance,verify}.js` |
| 重置预览只展示七张表 | 将 `RESET_DATA_TABLES` 作为唯一来源；预览覆盖全部 20 张被删除的业务/辅助表 | `server/lib/seed.js`, `server/api/system.js`, `test/v1221.test.js` |
| 双人复核使用可重复姓名 | 增加 `submitted_by_id / decided_by_id / executed_by_id`；新变更按 user ID 判定，旧数据继续按姓名兼容 | `server/lib/db.js`, `server/api/finance.js`, `server/api/system.js` |

## 测试与验证

新增 `test/qa-rbac-regression.test.js` 并加入 `npm test` / `test:cf`，覆盖嘉宾数据裁剪、直接调用敏感接口、跨协会创建、不可修改归属、空审批防护、文件所有权及跨项目挂接。

- 已执行：使用 V8 对修改后的服务端 JS 文件和回归测试文件进行语法解析，未报语法错误；前端 ES 模块经去除 import/export 语句后也通过语法解析（仅语法检查，不代表页面运行成功）。
- **未执行**：Node API 全量动态回归、真实浏览器多角色全按钮操作。
- GitHub Actions 已提交 `.github/workflows/qa.yml`，但 GitHub 记录的运行均为 `startup_failure`，0 jobs、无测试日志。不能把这种状态当作测试通过。
- GitHub API 创建 Pull Request 被拒绝：`At least one email address must be verified to do that`。需要先验证 GitHub 账号邮箱。
- 当前代码仍在独立分支，尚未合并 `main` 或部署 `erp.aibuild.work`。

## 尚需修复的业务级事项

1. 核销六步的岗位级权限（1–3 会务执行、4–6 财务）。旧版 API 与大量测试用例依赖跨岗位操作，应在完整测试运行能力恢复后一起调整规则及测试，避免造成演示流程不可用。
2. 财务结算收入目前直接取项目预算；若需财务真实账目，必须增加到账记录与应收、实收核算模型，重新定义结算口径。
3. 普通用户/嘉宾邀请、报名、签到的独立写入闭环，以及微信小程序等原规划功能，仍需独立模块建设。
4. 演示数据重置会清空数据库及附件关联记录，但尚未保证物理删除对象存储中的所有文件；避免将“数据库重置”宣称为“对象存储也已彻底清理”。
5. 连接可执行环境后运行 `npm test`、`npm run test:qa`、`npm run test:ui:survey`；通过后再合并和部署。

## 解除自动测试/合并阻塞

- GitHub：检查账号已验证邮箱（Settings → Emails），然后重试创建 PR。
- GitHub Actions：检查仓库 Actions 设置、账号账单/运行额度及上述 `startup_failure` 记录；该状态在任何 Node 任务执行前发生，无法判断代码正确性。
- 线上部署：域名当前使用 Cloudflare Worker + Durable Object，合并 GitHub 不等于已发布。需另行确认 Wrangler 权限并在测试通过后发布。

[整改分支](https://github.com/keyneszeng/erp-workbanch/tree/fix/qa-rbac-approval-20261028)
