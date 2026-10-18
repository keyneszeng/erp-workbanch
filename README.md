# 协会会议执行 ERP · 生产版代码 V1.0.0

> 依据《协会会议执行 ERP 交付版整合包 V1.0.2 · 09_可点击演示版》研发的可运行工程。
> 演示版验证的是「流程与交互是否成立」，本工程把它落成**真实后端 + 真实数据库 + 真实权限与门禁**。

---

## 1. 技术栈与设计取舍

| 层 | 选型 | 说明 |
|---|---|---|
| 运行时 | Node.js ≥ 22.5（推荐 24） | 使用内置 `node:sqlite`，**零第三方依赖** |
| 数据库 | SQLite（WAL 模式） | 单文件 `data/erp.db`，随工程走，便于交付与备份 |
| 后端 | `node:http` + 自研极简路由 | 无框架依赖，`server/lib/*` 分层清晰 |
| 前端 | 原生 ES Module SPA | 复用演示版设计系统（`app.css`），无构建步骤 |
| 鉴权 | scrypt 口令 + HttpOnly 会话 Cookie | 12 小时会话，登录/登出/失败均写审计 |
| 导出 | 服务端生成 CSV（UTF-8 BOM + CRLF） | Excel 直接打开不乱码 |

> 为什么零依赖：交付环境常常没有网络或不允许装包。当前工程 `npm install` 可完全跳过，
> `node server/index.js` 即可跑；后续接对象存储、短信、银行代付时再加依赖即可。

---

## 2. 启动

```bash
cd erp-app
npm start            # 等价于 node --experimental-sqlite server/index.js
# 打开 http://127.0.0.1:8787
```

首次启动会自动建表并写入种子数据（18 个项目 / 8 个账号 / 合同 / 付款 / 核销 / 结算 / 材料 / 审计）。

```bash
npm run seed         # 重置数据库并重建种子数据
npm test             # 26 条接口回归测试（独立 test.db，不影响主库）
ERP_PORT=9000 npm start
ERP_DB=/path/to/erp.db npm start
```

### 演示账号（密码均为 `123456`）

| 账号 | 姓名 | 角色 | 数据范围 |
|---|---|---|---|
| `admin` | 李静 | 总管理员 | 全平台 · 全部权限（超级角色） |
| `assoc` | 王敏 | 协会管理员 | 华东医学会 |
| `exec` | 张伟 | 会务执行人员 | 被授权会议 |
| `finance` | 陈静 | 财务与核销 | 被授权项目 |
| `guest` | 刘洋 | 普通用户 / 嘉宾 | 本人被授权项目 |
| `zhaolei` / `sunqian` / `zhoutao` | 赵磊 / 孙倩 / 周涛 | 执行 / 协会 / 执行 | 各自范围 |

---

## 3. 目录结构

```
erp-app/
├── server/
│   ├── index.js              # HTTP 入口：静态资源 + 路由 + 鉴权上下文 + 统一错误
│   ├── lib/
│   │   ├── db.js             # 连接、PRAGMA、建表 DDL
│   │   ├── seed.js           # 种子数据
│   │   ├── auth.js           # scrypt 口令、会话、Cookie
│   │   ├── rbac.js           # 角色 / 动作权限 / 数据范围 SQL
│   │   ├── workflow.js       # 9 状态 8 流转 + 3 道门禁 + 可执行动作计算
│   │   ├── constants.js      # 核销 6 步、归档 8 类、枚举值
│   │   ├── audit.js          # 全量操作留痕
│   │   ├── http.js           # body/cookie/静态资源/极简 Router
│   │   └── util.js           # 单号、时间、CSV、HttpError
│   ├── api/
│   │   ├── auth.js           # 登录 / 登出 / me / meta
│   │   ├── projects.js       # 项目列表、详情、立项、资料修改、成员、流转
│   │   ├── verify.js         # 6 步判定、例外单、材料、结算查询
│   │   ├── finance.js        # 合同、付款（含核销门禁）、审批中心、变更
│   │   └── system.js         # 看板、用户、审计、导出
│   └── scripts/seed.js
├── web/
│   ├── index.html
│   └── assets/
│       ├── app.css           # 复用演示版设计系统
│       ├── app-extra.css     # 登录页 / 状态条 / 核销卡等增量样式
│       └── js/
│           ├── app.js        # 路由、导航裁剪、顶栏、登录态
│           ├── lib/api.js    # fetch 封装 + 权限判断
│           ├── lib/ui.js     # 表格/面板/弹窗/表单/Toast
│           └── pages/*.js    # 12 个页面模块
├── test/api.test.js          # 26 条接口回归
└── data/erp.db               # 运行后生成
```

---

## 4. 业务模型（与演示版一致）

### 4.1 9 状态 8 流转

```
草稿 → 待审批 → 已立项 → 筹备中 → 执行中 → 待核销 → 已核销 → 已结算 → 已归档
        └──驳回──→ 草稿
```

| 动作 | 权限 | 前置门禁 |
|---|---|---|
| `submit` 提交立项 | 协会管理员 / 会务执行 | 议程 ≥ 4 字、预算 > 0 |
| `approve` 审批通过 | 协会管理员 | 必须处于待审批 |
| `reject` 驳回 | 协会管理员 | 必须填写理由 |
| `prep` / `exec` / `request_verify` | 协会 / 执行 / 财务 | 状态匹配 |
| `verify_pass` 核销通过 | 财务与核销 | 6 步全判定且全通过、无未决例外 |
| `settle` 生成结算单 | 财务与核销 | 核销通过、未重复生成 |
| `archive` 归档 | 协会 / 财务 | 材料 8/8、结算单已生成 |

非法流转一律 `409 ILLEGAL_TRANSITION`，**绕过前端直接调接口同样被拒**。

### 4.2 三道硬门禁

1. **付款门禁**：项目必须为 `已核销 / 已结算 / 已归档`，否则 `409 VERIFY_GATE`。
2. **结算门禁**：6 步核销全部通过且无未审批例外单，否则 `409 GATE_BLOCKED`。
3. **归档门禁**：结算单已生成 + 归档材料 8 类齐备，否则 `409 GATE_BLOCKED`。

### 4.3 核销 6 步（顺序不可跳过）

1. 议程与课件核对
2. 签到人数与报名核对
3. 现场费用凭证
4. 课件与议程课题一致性
5. 劳务与专家费核对
6. 发票与合同金额核对

任一步判定「不通过」→ 自动生成例外单 + 审批单；财务审批通过后该步记为「已解例外」，可继续后续步骤；
例外单未决时不允许核销通过。

### 4.4 权限模型

- **总管理员**：`super: true`，11 个模块全开、全部动作放行、数据范围不过滤（`1=1`），
  可代任何角色操作，也可修改任意项目资料；所有代操作同样写审计。
- **协会管理员**：本协会项目全流程 + 审计查阅。
- **会务执行**：被授权会议的执行、材料与核销取证。
- **财务与核销**：核销判定、例外审批、付款审批与付款、结算、归档。
- **普通用户 / 嘉宾**：仅本人被授权（成员关系）的项目，不含负责人字段推断。

数据范围在 `rbac.scopeFilter()` 统一生成 SQL 片段，列表、详情、导出、看板共用同一口径，
避免「列表看不到、详情能打开」的越权漏洞。

---

## 5. 接口一览

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/auth/login` `/api/auth/logout` | 登录 / 登出 |
| GET | `/api/auth/me` `/api/meta` | 当前用户与权限、枚举元数据 |
| GET | `/api/dashboard` | 看板：计数、待办、预警、近期会议 |
| GET/POST | `/api/projects` | 列表（scope 过滤）/ 新建立项 |
| GET/PATCH | `/api/projects/:id` | 详情（含核销、材料、结算、可执行动作）/ 资料修改 |
| POST | `/api/projects/:id/transition` | 状态流转（带门禁） |
| POST | `/api/projects/:id/members` | 成员增删 |
| GET | `/api/projects/:id/verify` | 6 步 + 例外 + 材料 + 结算 |
| POST | `/api/projects/:id/verify/steps/:no` | 单步判定 |
| POST | `/api/projects/:id/exceptions` | 提交例外单 |
| POST | `/api/exceptions/:id/decide` | 例外单审批 |
| GET/POST | `/api/contracts` | 合同台账 / 录入 |
| GET/POST | `/api/payments` | 付款列表 / 付款申请（核销门禁） |
| POST | `/api/payments/:id/approve` `/pay` | 付款审批 / 付款 |
| GET | `/api/approvals` | 审批中心（立项 / 例外 / 付款 / 变更） |
| POST | `/api/approvals/:id/decide` | 统一审批入口，按类型分派 |
| POST | `/api/projects/:id/change` | 变更申请 |
| GET/POST/DELETE | `/api/materials` `/api/projects/:id/materials` | 材料登记与删除 |
| GET | `/api/settlements` | 结算单 |
| GET/POST/PATCH | `/api/users` `/api/users/:id` | 账号与角色 |
| GET | `/api/audit` | 审计日志（非审计角色仅本人） |
| GET | `/api/export/:kind` | CSV 导出：projects / payments / contracts / verify / settlements / audit |

错误统一返回：

```json
{ "error": { "code": "VERIFY_GATE", "message": "付款被拦截：…", "detail": { "status": "待核销", "verify": "0/6" } } }
```

---

## 6. 测试

```bash
npm test
```

26 条用例覆盖：登录与未登录拦截、总管理员超级权限、四类数据范围、动作级越权、
工作流正向与非法流转、跳步判定、付款门禁、例外单闭环、核销通过、付款审批与付款、
结算冻结、归档材料门禁、归档后不可删材料、CSV BOM、审计留痕与审计可见范围。

端到端（Playwright，需本机 Chrome）另跑通：立项 → 提交 → 审批 → 加成员 → 推进 →
付款门禁提示 → 判定不通过 → 例外审批 → 核销通过 → 付款 → 结算 → 补 8 类材料 → 归档 → 导出下载，
全程 0 控制台报错。

---

## 7. 仓库内容

| 目录 | 内容 |
|---|---|
| `server/` `web/` `test/` | 生产版代码（本 README 第 2~6 节说明） |
| `prototype/index.html` | V1.0.2 可点击演示版（单文件，双击即可打开，零依赖） |
| `docs/产品设计方案_V1.0.2.md` | 完整产品工作流程图与原型设计方案 |
| `docs/交付说明.md` | 交付包说明与历次迭代记录 |
| `docs/演示版说明.md` | 演示版使用说明与角色动线 |

> 演示版验证「流程与交互是否成立」，生产版验证「权限、门禁与数据是否真的成立」。
> 两者的页面结构、状态机与角色定义保持一致。

---

## 8. 尚未落地（下一阶段）

- 文件真实上传：当前材料为元数据登记，接对象存储（S3/OSS/MinIO）后替换 `materials` 的 `url` 字段。
- 通知：待办目前是查询派生，未做站内信/企微/短信推送。
- 并发与审批流配置：审批链目前按类型固定，后续可做成可配置多级审批。
- 数据库迁移工具：现为幂等 DDL，字段演进需要引入版本化 migration。
- 附件与卷宗打包下载：现为 CSV 明细，后续可出 PDF 卷宗。
