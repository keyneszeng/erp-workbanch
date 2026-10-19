# 协会会议执行 ERP · 生产版代码 V1.0.5

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
npm test             # 110 条接口回归测试（每文件自起服务 + 独立库，不影响主库）
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
│           └── pages/*.js    # 13 个页面模块（含会务需求）
├── test/
│   ├── api.test.js           # 26 条 主链路
│   ├── edge.test.js          # 26 条 边界与安全
│   ├── matrix.test.js        # 11 条 角色 × 接口矩阵 / 并发
│   ├── hardening.test.js     # 19 条 加固（协议 / 长度 / CSV / 预算 / 并发幂等）
│   ├── abuse.test.js         # 28 条 滥用与越权（注入 / IDOR / 状态机 / 脏数据 / 封账）
│   └── ui/                   # smoke.js / e2e.js / edge.js（Playwright）
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

1. **付款门禁**：项目必须为 `已核销`，否则 `409 VERIFY_GATE`；已结算 `409 SETTLED`（账目已封账）、已归档 `409 ARCHIVED`（卷宗已封存）。
   另叠加**预算门禁**：已占用（待审批 + 已审批 + 已付款）+ 本笔 > 预算 → `409 OVER_BUDGET`，仅总管理员可带 `force` 特批（写审计）。
2. **结算门禁**：6 步核销全部通过、无未审批例外单、且**没有未完成付款**（待审批 / 已审批），否则 `409 GATE_BLOCKED`。
3. **归档门禁**：结算单已生成 + 归档材料 8 类齐备 + 没有未完成付款，否则 `409 GATE_BLOCKED`。

> 「付款没走完不许结算」是 V1.0.1 补的规则：否则先出结算单、后付款，结算支出会少算，
> 账实不符且无法回溯。
> V1.0.2 把门禁补成闭环：结算即封账（不得再新增付款 / 合同 / 例外单），归档即封存（不得再登记材料 / 录合同）。

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
| GET | `/api/demand` | 会务需求确认：按数据范围列出会议 + 各会议需求汇总 |
| GET | `/api/demand/:id` | 单会议需求单（首次打开按四组模板生成） |
| PATCH | `/api/demand/:id` | 整单保存（协会管理员 / 会务执行可写） |
| POST | `/api/demand/:id/confirm` `/reset` | 确认需求单 / 重置回模板 |
| GET | `/api/demand/:id/export` | 需求单 CSV 导出 |
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
npm test        # 130 条：api 26 + edge 26 + matrix 11 + hardening 19 + abuse 28 + stateless 6 + demand 9 + material 5
```

| 文件 | 关注点 |
|---|---|
| `test/api.test.js` | 主链路：登录、数据范围、工作流、核销 6 步、例外闭环、付款门禁、结算冻结、归档、导出、审计 |
| `test/edge.test.js` | 边界与安全：IDOR、通讯录隐私、负数/零值/非法枚举、重复审批、归档后付款、结算前未清付款、自我停用、伪造 Cookie、登录文案一致性 |
| `test/matrix.test.js` | 角色 × 接口矩阵（5×11 无 500）、并发建单不重号、变更审批、非法流转动作、导出列完整性 |
| `test/hardening.test.js` | 加固：路径穿越多形态、HEAD/畸形 JSON、请求体 413、字段长度、会话生命周期、CSV 转义与公式注入、超预算、并发状态机幂等 |
| `test/abuse.test.js` | 滥用与越权：SQL 注入、IDOR、状态机全枚举、审批/付款/结算/归档幂等、金额与日期脏数据、多端会话、封账封存、导出范围一致性 |
| `test/stateless.test.js` | 无状态会话兜底：模拟 Serverless「换实例」（清空 sessions 表），签名令牌仍可放行；伪造签名 / 篡改 uid / 过期 / 改密吊销 / 未知令牌均 401 |
| `test/demand.test.js` | 会务需求模块：列表 / 种子+模板详情 / 整单替换 / 财务越权 403 / 非法枚举 400 / 确认+重置 / CSV 导出 BOM |
| `test/material.test.js` | 材料写入权限：exec 可登记/删除材料但不可归档；assoc/finance 可写；guest 403 |

浏览器层（Playwright + 本机 Chrome，需先起服务）：

```bash
ERP_PORT=8787 npm start          # 另开一个终端
ERP_PORT=8787 npm run test:ui    # 14 页冒烟 → 全链路 E2E → 11 项 UI 边界
```

| 脚本 | 关注点 |
|---|---|
| `test/ui/smoke.js` | 14 个页面逐页渲染，控制台 0 报错 |
| `test/ui/e2e.js` | 全链路：立项 → 提交 → 审批 → 加成员 → 推进 → 付款门禁 → 核销不通过 → 例外审批 → 核销通过 → 付款 → 结算 → 补 8 类材料 → 归档 → 导出 |
| `test/ui/edge.js` | UI 边界：XSS 注入、超长名称布局、404/空态、必填校验、双击提交幂等、越权直链、登录错误与限流 |

端到端（`test/ui/e2e.js`，需本机 Chrome）另跑通：立项 → 提交 → 审批 → 加成员 → 推进 →
付款门禁提示 → 判定不通过 → 例外审批 → 核销通过 → 付款 → 结算 → 补 8 类材料 → 归档 → 导出下载，
全程 0 控制台报错。当前实跑结果：接口 130/130、UI 冒烟 14/14、E2E 0 报错、UI 边界 11/11。

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

## 8. Vercel 部署（在线演示）

线上地址：**https://erp-workbanch.vercel.app**（生产域名，无需 Vercel 登录即可访问）

### 8.1 架构

| 层 | 部署方式 |
|---|---|
| 前端 `web/` | `buildCommand` 原样复制到 `dist/`，作为纯静态资源由 CDN 直接返回 |
| 后端 `server/` | 打包进 `api/index.js` 单个 Node Function，`/api/*` 全部 rewrite 到它 |
| 数据库 | `node:sqlite`，文件落在 `/tmp`（Serverless 唯一可写目录） |

`vercel.json` 三个关键点，任何一个错都会导致部署"构建成功但页面白屏"：

1. **`outputDirectory: "dist"`** —— 前端必须走静态输出。若用 `includeFiles` 把 `web/` 塞进 Function 包，
   Vercel 的 Node builder 会把所有 `.js` 按 CommonJS 重写，远端 `app.js` 变成 `require("./lib/api.js")`，
   浏览器报 `require is not defined`，整站白屏。**这是本项目第一次部署失败的真实原因。**
2. **`includeFiles: "server/**"`** —— 必须是字符串。写成数组会直接报
   `vercel.json schema validation failed: functions.api/index.js.includeFiles should be string`。
3. **只 rewrite `/api/*`** —— 静态资源不经过 Function，省冷启动，也避免被转译。

### 8.2 部署命令

```bash
npm i -g vercel          # 或 npx vercel
vercel --prod            # 首次会绑定项目 erp-workbanch
```

Git 集成已开启：推 `main` 即自动触发生产部署。

### 8.3 ⚠️ 演示部署的数据约束

Serverless 实例的 `/tmp` 是**实例本地**的，所以：

- 实例被回收后，数据回到种子态（18 个项目 / 5 个账号，密码均 `123456`）
- 极端情况下多个并发实例各自持有独立副本

**够演示，不能当生产用。** 要真正持久化有两条路：

| 方案 | 改造量 | 说明 |
|---|---|---|
| Turso / libSQL | 中 | SQLite 语法 100% 兼容，只需替换 driver；但 `DatabaseSync` 是同步 API，要全量改 `await` |
| Vercel Postgres / Neon | 大 | SQL 方言需适配（自增、占位符、时间函数） |

在完成上述改造前，生产环境请用本机/服务器部署（第 2 节），SQLite 落在磁盘上是持久的。

### 8.4 会话如何跨实例（Vercel 上为什么不会一换实例就被踢下线）

Serverless 每个实例的 `/tmp` 独立，会话表只能在本实例查到。若只靠会话表，请求落到新实例
（`/tmp` 是空的全新库）就会全体 `401`。实测：40 个并发请求有 23 个 `401`，之后顺序请求也全部 `401`。

本项目的解法（见 `server/lib/auth.js`）：

- 登录令牌自带 **HMAC-SHA256 签名**：`v1.<uid>.<exp>.<ver>.<sig>`，`sig` 对所有字段签名。
- `ERP_SESSION_FALLBACK=1`（仅 Vercel 环境由 `api/index.js` 自动设置）时，本实例查不到会话表就改走签名校验，
  换实例仍能识别用户。
- 本地 / 测试环境**默认关闭**兜底，严格以 `sessions` 表为准，登出、过期立即失效——所以测试仍能覆盖这些安全用例。
- 令牌里的 `ver` 绑定 `users.token_ver`：改密时 `token_ver += 1`，旧令牌即使换实例也立刻失效（吊销语义跨实例成立）。

安全权衡：开启兜底后，**登出只在签发实例生效**（其它实例的旧令牌在 12 小时有效期内仍可用，
但前端会同步清掉 Cookie）。演示场景可接受；要彻底解决请上共享数据库（第 8.3 节）。

---

## 9. 变更记录

### V1.0.5（修复会务执行人员无材料录入入口）
| # | 问题 | 修复 |
|---|---|---|
| 1 | 会务执行人员进入「材料中心」看不到「+ 登记材料」，项目详情材料页签也没有录入入口，直接调接口返回 403 | 根因：材料增删与「项目归档」共用 `archive:write`，而该权限只给了 assoc / finance。拆出独立权限 `material:write`（assoc / exec / finance），材料增删改用它；`archive:write` 仅保留给归档动作 |
| 2 | 前端入口判断同步 | `materials.js` 与 `project.js` 的材料增删按钮改为 `can("material:write")` |
| 3 | 防回归 | 新增 `test/material.test.js`（5 条）：exec 可写材料、不可归档；assoc/finance 可写；guest 403；全量 125 → 130 条 |

### V1.0.4（新增「会务需求」模块）
| # | 内容 | 说明 |
|---|---|---|
| 1 | 补齐 `rbac.js` 早已占位、但一直未实现的「会务需求」模块 | 按老板提供的《会务需求确认》业务清单落地：四组模板（设计 / 制作 / 现场执行 / 其他，共 23 项），每项带「是否需要 / 规格数量 / 负责人 / 交付时间 / 预算归属 / 附件 / 执行状态」 |
| 2 | 新增 `server/api/demand.js` + DB 表 `demand_sheets` / `demand_items` | 列表（按数据范围）、详情（首次打开自动生成模板）、整单保存（DELETE+INSERT 全量替换）、确认、重置、CSV 导出；权限 `demand:write` 仅限协会管理员 / 会务执行 |
| 3 | 前端新增 `web/assets/js/pages/demand.js` 并接入导航与路由 | 会议列表 + 逐会议需求单编辑页，可保存 / 确认 / 重置 / 导出 |
| 4 | 种子数据 | 旗舰项目 `MP-2026-001` 预置一份已填写的需求单，其余项目首次打开按模板生成 |
| 5 | 测试 | 新增 `test/demand.test.js`（9 条），全量 `npm test` 116 → 125 条全过 |

### V1.0.3（Vercel 部署修复）
| # | 问题 | 修复 |
|---|---|---|
| 1 | Vercel 上首页一片空白，浏览器报 `require is not defined` | `includeFiles: "**"` 把 `web/` 塞进 Function 包，Node builder 把前端 ESM 全部转译成 CommonJS。改为 `outputDirectory: "dist"`，前端由 CDN 直接服务 |
| 2 | 静态资源每个都触发一次 Function 冷启动 | rewrite 收窄为只代理 `/api/*` |
| 3 | `includeFiles` 写成数组导致构建直接失败 | 改回字符串 `"server/**"` |
| 4 | `favicon.ico` 404 | 内联 SVG data URI 图标 |
| 5 | Vercel Serverless 多实例各自 `/tmp`，请求落到新实例后 `sessions` 表查不到，全体 401（实测 40 并发 23 个失败，之后全 401） | 登录令牌改为 HMAC 签名（`v1.<uid>.<exp>.<ver>.<sig>`），仅 Vercel 开 `ERP_SESSION_FALLBACK`；本地/测试仍严格以 `sessions` 表为准 |
| 6 | 仅靠会话表无法在 Serverless 上吊销令牌 | `users.token_ver` 递增并写入签名，改密后旧令牌即使换实例也失效 |

### V1.0.2（深度加固 · 测试 63 → 110 条）
| # | 问题 | 修复 |
|---|---|---|
| 1 | 请求体超过 2 MB 时 `readBody` 抛普通 Error，被兜底成 500 | 改为 `413 PAYLOAD_TOO_LARGE`；溢出后继续排空剩余字节，避免客户端收到 ECONNRESET |
| 2 | 项目名无长度上限，超长文本可撑爆列表与导出 | 名称 ≤ 80 字、议程 ≤ 2000 字、负责人/电话 ≤ 20 字，超限 400 |
| 3 | 重置密码后旧会话仍可用 12 小时 | 改密即吊销该账号其它会话（保留操作者当前会话），审计记录吊销数量 |
| 4 | CSV 导出可被公式注入（`=HYPERLINK(...)` 在 Excel 里会执行） | 以 `=` `+` `-` `@` 制表符 回车开头的字符串统一加 `'` 前缀 |
| 5 | 付款不受预算约束，可无限超支 | 新增 `409 OVER_BUDGET`：已占用（待审批+已审批+已付款）+ 本笔 > 预算即拦截；总管理员可带 `force` 特批并留痕 |
| 6 | 核销备注 / 例外原因无长度上限 | 备注 ≤ 1000 字、例外原因 ≤ 500 字、审批意见 ≤ 500 字 |
| 7 | 已结算项目仍可新增付款，导致结算单支出与账面不符 | 结算即封账：`409 SETTLED`；`PAYABLE_STATUS` 收紧为仅「已核销」 |
| 8 | 已归档项目仍可录合同 | `409 ARCHIVED`，合同台账随卷宗封存 |
| 9 | 已归档项目仍可登记材料（删除已拦、新增没拦） | `409 ARCHIVED` |
| 10 | 已结算 / 已归档项目仍可提交例外单，产生无法闭环的待审批单 | `409 FROZEN` |
| 11 | 金额可填 0.001 元（亚分精度），浮点累积会让结算对不上 | 金额必须精确到分且 ≤ 10 亿；合同金额同样校验 |
| 12 | 日期只校验格式，`2026-02-30`、`2026-13-01` 能入库 | 增加真实日历校验（回读 ISO 日期比对） |
| 13 | 人数、会期可为小数（3.5 人 / 1.5 天） | 必须为整数，人数 ≤ 100000、会期 1~60 天 |
| 14 | 公开的 `/api/health` 返回数据库绝对路径 | 只回 `{ ok, at }`，内部信息不外泄 |
| 15 | 任何登录用户可读 `/api/exports`（含他人导出文件名） | 需 `export:any` 或 `audit:read` 权限 |
| 16 | 材料名称无长度上限 | ≤ 120 字 |
| 17 | 种子数据 MP-2026-017 自身超预算（已付 13.2 万 / 预算 11.2 万），与超预算门禁自相矛盾 | 预算调整为 14 万，全库 18 个项目预算与在途付款重新自洽 |

### V1.0.1（测试加固）
| # | 问题 | 修复 |
|---|---|---|
| 1 | 已归档项目仍可新增付款，卷宗封存形同虚设 | `POST /api/payments` 对已归档返回 `409 ARCHIVED`；前端付款按钮同步置灰 |
| 2 | 有未完成付款时仍可生成结算单，导致结算支出少算 | 结算 / 归档门禁增加「无待审批、已审批付款」校验 |
| 3 | 普通用户能拉到全员手机号 | `/api/users` 按权限分级：仅账号管理与项目成员调整角色可见完整通讯录 |
| 4 | 总管理员可停用自己，直接把系统锁死 | 禁止停用当前登录账号、禁止修改自己的角色 |
| 5 | 负数人数、0 天会期可入库 | 增加数值区间校验（人数 ≥ 0、会期 1~60 天） |
| 6 | 无登录失败限流，可暴力破解 | 同 IP + 账号 5 次失败后 `429`，5 分钟窗口 |
| 7 | 用户姓名进入弹窗标题未转义（存储型 XSS 风险） | 统一 `esc()` 转义 |
| 8 | 嘉宾可通过地址栏直链进入系统配置 / 财务页面 | 路由增加模块与条目级守卫，越权重定向回工作台 |
| 9 | 核销看板「例外单 / 结算单」列恒为 `—` | 列表接口补 `v_passed / ex_open / st_id`，改为真实进度条与单号 |
| 10 | 归档项目仍显示「编辑资料」 | 归档后仅总管理员保留编辑入口 |

---

## 10. 尚未落地（下一阶段）

- 文件真实上传：当前材料为元数据登记，接对象存储（S3/OSS/MinIO）后替换 `materials` 的 `url` 字段。
- 通知：待办目前是查询派生，未做站内信/企微/短信推送。
- 并发与审批流配置：审批链目前按类型固定，后续可做成可配置多级审批。
- 数据库迁移工具：现为幂等 DDL，字段演进需要引入版本化 migration。
- 附件与卷宗打包下载：现为 CSV 明细，后续可出 PDF 卷宗。
