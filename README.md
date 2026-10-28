# 协会会议执行 ERP · 生产版代码 V1.2.20

> 依据《协会会议执行 ERP 交付版整合包 V1.0.2 · 09_可点击演示版》研发的可运行工程。
> 演示版验证的是「流程与交互是否成立」，本工程把它落成**真实后端 + 真实数据库 + 真实权限与门禁**。

---

## 1. 技术栈与设计取舍

| 层 | 选型 | 说明 |
|---|---|---|
| 运行时 | Node.js ≥ 22.5（推荐 24） | 使用内置 `node:sqlite`，**零第三方依赖** |
| 部署 | Vercel（Serverless）/ Cloudflare Workers + Durable Objects | 同一套代码双运行时，数据库层可切换后端 |
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
npm test             # 279 条接口回归测试（每文件自起服务 + 独立库，不影响主库）
npm run test:cf      # 同一批 279 条，跑在「Durable Object SQL」后端语义下
ERP_PORT=9000 npm start
ERP_DB=/path/to/erp.db npm start
```

---

## 2.1 部署到 Cloudflare Workers

同一套业务代码，两套运行时。Cloudflare 没有可写的文件系统，`node:sqlite` 在 Workers 里也只是「可 import、调用即抛」的空壳，
因此数据库换成 **Durable Object 内置 SQLite**——它恰好也是**同步 API**，所以 `db.prepare().all()/get()/run()`
那 141 处调用一行都没改。

```
浏览器 ──► Worker（静态资源走 Assets；/api/* 转发）
              └──► Durable Object「ErpDatabase」（全部业务逻辑 + 私有 SQLite）
                        └──► R2 bucket（照片 / PDF 附件）
```

| 文件 | 作用 |
|---|---|
| `worker/index.mjs` | Worker 入口，`/api/*` 转发给唯一的 DO 实例 |
| `worker/do.mjs` | DO 类：注入 SQL 存储 → migrate → seed → 跑既有 handler |
| `worker/adapter.mjs` | 把 Web `Request` 伪装成 node 风格 `req/res`，业务代码零改动 |
| `wrangler.jsonc` | Assets 绑定、DO 绑定与 migration 声明、R2 绑定 |

```bash
npm run cf:build     # 只打包不发布，检查产物（本机可跑，无需登录）
npm run cf:deploy    # 真正发布（需先 wrangler login 或设 CLOUDFLARE_API_TOKEN）
npm run cf:tail      # 实时日志
```

> ⚠️ **线上 https://erp.aibuild.work 不会自动跟随本地改动。**
> 本地改完代码只是「代码库里有」，浏览器打开线上站点看到的仍是上一次部署的版本 ——
> 2026-10-26 就出现过一次：本地核销 6 步早已有「详情」按钮，线上还停在 v1.0.5，
> 用户看不到还以为功能没做。**改完要 `npm run cf:deploy` 才生效。**
>
> 部署时 DO 会重启，`migrate()` 自动补新列（`owner_id` 等）并回填，数据不会丢；
> 部署完用 `curl https://erp.aibuild.work/api/health` 和登录页版本号确认一下。

### 附件存储：必须先建 R2 桶

照片和 PDF 存 R2，**不存数据库**（DO 单值上限 2 MB，一张手机照片就超了）。

```bash
wrangler r2 bucket create erp-workbanch-files
```

`wrangler.jsonc` 里对应的绑定：

```jsonc
"r2_buckets": [{ "binding": "ERP_FILES", "bucket_name": "erp-workbanch-files" }]
```

**没绑 R2 也能部署**，但上传接口会返回 `503 STORAGE_UNAVAILABLE`，前端上传按钮点了会提示未配置。
其余功能（登记材料元数据、核销、付款、归档）不受影响。

### 本地为什么不能预览

`wrangler dev` 依赖 workerd，要求 **macOS 13.5+**；本机是 12.7.6，起不来。
所以本地用 `npm run test:cf` 把同一批 279 条测试跑在「模拟的 DO SQL 后端」上
（`test/lib/do-sqlite-mock.js`），确认 SQL 语义一致后再部署。

### 已知限制

- **CPU 时间**：登录用 scrypt（N=16384，单次约 78ms）。Workers **免费计划每请求 10ms CPU**，登录会超限（Error 1102）；
  付费计划（$5/月，默认 30s）无此问题。
- **单实例**：所有请求串行进同一个 DO。内部 ERP 的并发量完全够用，但不适合高并发 C 端场景。
- **登出**：因为只有一个实例，登出立即全端生效——Vercel 上「换实例后旧令牌仍可用」的问题在这里天然消失。

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
├── server/                      # 业务后端（Node 与 Worker 共用同一份）
│   ├── index.js                 # 本地 HTTP 入口：静态资源 + 路由 + 鉴权上下文
│   ├── lib/
│   │   ├── app.js               # 请求处理核心（Node / Cloudflare 共用）+ 安全响应头
│   │   ├── db.js                # 连接、PRAGMA、建表 DDL、增量加列、索引
│   │   ├── seed.js              # 种子数据（5 角色 / 19 项目 / 材料 / 付款 / 结算）
│   │   ├── auth.js              # scrypt 口令、会话、Cookie、口令强度校验
│   │   ├── rbac.js              # 角色 / 动作权限 / 数据范围 SQL / 模块白名单
│   │   ├── workflow.js          # 9 状态 8 流转 + 四道门禁 + 可执行动作计算
│   │   ├── constants.js         # 核销 6 步、归档 8 类、枚举值（唯一来源）
│   │   ├── audit.js             # 全量操作留痕（4W）
│   │   ├── storage.js           # 附件存储（本地磁盘 / R2 双实现）
│   │   ├── paginate.js          # 分页参数归一与总数读取
│   │   ├── http.js              # body/cookie/静态资源/极简 Router/405 Allow
│   │   └── util.js              # 单号、时间、金额收敛、CSV、HttpError、银行账号校验
│   ├── api/
│   │   ├── auth.js              # 登录 / 登出 / me / meta / 自助改密
│   │   ├── projects.js          # 项目列表、详情、立项、资料修改、成员、流转
│   │   ├── verify.js            # 6 步判定、例外单、材料、结算查询
│   │   ├── demand.js            # 会务需求单（确认即归档）
│   │   ├── finance.js           # 合同、付款、审批中心、变更双人复核
│   │   ├── files.js             # 附件上传与下载（含数据范围校验）
│   │   └── system.js            # 看板、用户、审计、导出
├── web/                         # 前端（原生 ES Module，无构建步骤）
│   ├── index.html
│   └── assets/
│       ├── app.css              # 复用演示版设计系统
│       ├── app-extra.css        # 登录页 / 状态条 / 核销卡 / 骨架屏
│       └── js/
│           ├── app.js           # 路由、导航裁剪、顶栏、登录态、骨架屏
│           ├── lib/api.js       # fetch 封装 + 权限判断
│           ├── lib/ui.js        # 表格/面板/弹窗/表单/Toast/分页
│           ├── lib/nav.js       # 侧栏结构与可达性（与后端 rbac 同一张表）
│           └── pages/*.js       # 14 个页面模块
├── worker/                      # Cloudflare Workers 适配层
│   ├── index.mjs                # Worker 入口（静态资源走 Assets 绑定）
│   ├── adapter.mjs              # 把 Web Request 伪装成 node 风格 req/res
│   └── do.mjs                   # Durable Object：SQLite 存储 + 单实例串行
├── api/index.js                 # Vercel 入口（在线演示）
├── test/                        # 29 个接口回归 + 28 个 UI 脚本
│   ├── helpers/materials.js     # 材料 8 类补齐（核销前置门，多文件共用）
│   ├── api / edge / matrix / hardening / abuse / workflow-chain / money-precision ...
│   ├── v12xx.test.js            # 每个版本的专项回归（一条缺陷一条断言）
│   └── ui/                      # Playwright：smoke / e2e / 各版本定点 / 线上只读 cf-*
├── scripts/                     # 运维脚本（见 scripts/README.md）
│   ├── shot.js                  # 通用截图（参数化，替代每版一个的临时脚本）
│   └── shot-cdet.js             # 合同详情专用（造 PDF + 上传 + 截弹窗）
├── docs/                        # 交付说明、系统梳理、各版本效果截图、CHANGELOG
└── data/erp.db                  # 运行后生成（不入库）
```

> 目录结构这条最容易腐烂：V1.2.20 梳理时它已经漏了 `api/`、`worker/`、`docs/`、`scripts/`
> 和 3 个 server 模块，test 只列了 5 个文件（实际 29 个）。改结构时顺手改这里。

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
| POST | `/api/auth/password` | 自助修改密码（校验原密码，改后其它设备立即失效） |
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
| GET/POST | `/api/contracts` | 合同台账 / 录入（可选挂合同原件：扫描件 PDF 或拍照件；状态限 `草稿/待签署/已签署`，总额超预算时返回 `warning`） |
| GET/POST | `/api/payments` | 付款列表 / 付款申请（核销门禁 + 预算门禁 + 同项目同收款方同发票号去重） |
| POST | `/api/payments/:id/approve` `/pay` | 付款审批 / 付款 |
| GET | `/api/approvals` | 审批中心（立项 / 例外 / 付款 / 变更） |
| POST | `/api/approvals/:id/decide` | 统一审批入口，按类型分派 |
| POST | `/api/projects/:id/change` | 变更申请 |
| GET/POST/DELETE | `/api/materials` `/api/projects/:id/materials` | 材料登记与删除（可选挂附件） |
| POST | `/api/uploads` | 文件上传（裸二进制，非 multipart；限 8 MB，JPG/PNG/WebP/GIF/PDF） |
| GET | `/api/uploads/:key` | 文件下载（按材料 / 合同所属项目校验数据范围） |
| GET | `/api/uploads/capability` | 上传能力探测（后端类型、大小上限） |
| GET | `/api/demand` | 会务需求确认：按数据范围列出会议 + 需要项数 / 预算合计 / 归档状态 |
| GET | `/api/demand/:id` | 单会议需求单（首次打开按四组模板生成，不落库） |
| PATCH | `/api/demand/:id` | 整单保存（协会管理员 / 会务执行可写；**已归档或已结算即冻结**） |
| POST | `/api/demand/:id/confirm` | 确认需求单 = **归档**，此后不可修改（`DEMAND_ARCHIVED`） |
| POST | `/api/demand/:id/unarchive` | 撤销归档，回到草稿可编辑（写审计） |
| POST | `/api/demand/:id/reset` | 重置回模板（已归档 / 已结算均冻结，会 DELETE 全部条目） |
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
npm test        # 351 条：29 个文件，独立端口 + 独立库 + 自起服务
npm run test:cf # 同一套用例跑 Durable Object 语义（换 SQLite 后端）
```

**接口层（29 个文件，351 条）**

| 文件 | 关注点 |
|---|---|
| `api` | 主链路：登录、数据范围、工作流、核销 6 步、例外闭环、付款门禁、结算冻结、归档、导出、审计 |
| `edge` | 边界与安全：IDOR、通讯录隐私、负数/零值/非法枚举、重复审批、归档后付款、伪造 Cookie |
| `matrix` | 角色 × 接口矩阵（5×11 无 500）、并发建单不重号、导出列完整性 |
| `hardening` | 加固：路径穿越、HEAD/畸形 JSON、413、字段长度、会话生命周期、CSV 公式注入、并发幂等 |
| `abuse` | 滥用与越权：SQL 注入、IDOR、状态机全枚举、封账封存、导出范围一致性 |
| `business-rules` | 47 条业务规则：金额精度、日期、重复条目、长度上限、状态互斥 |
| `workflow-chain` | 9 状态 × 9 动作的全枚举：允许的能过、不允许的必 409 且状态不变 |
| `money-precision` | 金额只落在「分」：预算用尽不误判超支、结算 profit 不出现 15 位小数 |
| `scope-owner` | 数据范围认 user_id 不认姓名：同名账号看不到别人的项目 |
| `stateless` / `password` / `paging` / `upload` / `storage-unavailable` | 会话兜底 / 改密吊销 / 分页越界 / 附件 / 存储未绑定降级 |
| `demand` / `demand-archive` / `material` / `contract-file` / `contract-flow` / `change-execute` / `freeze` / `id-sequence` / `todo-flag` | 各模块专项 |
| `v1213` ~ `v1219` | **每版专项回归**：一条缺陷一条断言，见对应版本的变更记录 |

**浏览器层（28 个脚本，Playwright + 本机 Chrome）**

```bash
ERP_PORT=8787 npm start          # 另开终端
ERP_PORT=8787 npm run test:ui    # smoke → e2e → edge
node test/ui/v1220.js            # 单跑某个定点脚本
```

| 脚本 | 关注点 |
|---|---|
| `smoke` | 14 个页面逐页渲染，控制台 0 报错 |
| `e2e` | 全链路：立项 → 审批 → 推进 → **材料 8 类** → 提交核销 → 判定不通过 → 例外审批 → 核销通过 → 付款 → 结算 → 归档 → 导出 |
| `edge` | UI 边界：XSS、超长名称、404/空态、必填校验、双击幂等、越权直链、登录限流 |
| `v1213` ~ `v1220` | 各版定点：合同类别 / 例外单自定义 / 审批中心 / 会务需求 / 收款账户 / 材料门禁 / 页签顺序 |
| `verify-detail` | 核销 6 步「详情」：逐步核对数据、原件可取、详情→判定串联、顺序限制（52 项） |
| `contract-detail` | 合同详情：PDF 内嵌、图片铺开、无原件如实提示、弹窗内两步签署（39 项） |
| `dashboard` / `demand` / `change-flow` / `paging-edge` / `contract` / `upload` | 工作台 / 需求 / 变更复核 / 分页越界 / 合同 / 附件 |
| `cf-v12xx` | **线上只读验证**（部署后跑）：只发 GET，写请求一律是「预期被拒」的探针 |

> **端口必须全局唯一**（当前占用 8799–8839）。两个测试同端口但各用各的库时，
> `node --test` 并行会随机 EADDRINUSE，或者更糟：打到别人的库上，报错指向完全无关的用例。
> 脚本固定 `--test-concurrency=2`：4 核机器按默认并发跑会同时起十几个服务，
> `migrate + seed` 被拖慢后触发启动超时，表现成「随机几个文件全红」。

---

## 7. 仓库内容

| 目录 | 内容 |
|---|---|
| `server/` `web/` `worker/` `api/` | 生产版代码（第 2~6 节说明）；同一份业务代码跑 Node 与 Cloudflare |
| `test/` | 29 个接口回归 + 28 个浏览器脚本（第 6 节） |
| `scripts/` | 截图等运维脚本（`scripts/README.md`） |
| `prototype/index.html` | V1.0.2 可点击演示版（单文件，双击即可打开，零依赖） |
| `docs/CHANGELOG.md` | **V1.2.0 ~ V1.2.17 的完整变更记录**（从 README 拆出，见第 9 节末尾） |
| `docs/产品设计方案_V1.0.2.md` | 完整产品工作流程图与原型设计方案 |
| `docs/系统梳理_v1.2.11.html` | 代码结构 / 数据模型 / 状态机 / 门禁 / 权限矩阵 / 请求链路一页看懂 |
| `docs/交付说明.md` | 交付包说明与历次迭代记录 |
| `docs/演示版说明.md` | 演示版使用说明与角色动线 |
| `docs/v1.2.14` ~ `v1.2.20/` | 各版本效果截图（老板要看的「长什么样」） |

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

> 这里只放**最近三版**。更早的 V1.2.0 ~ V1.2.17 在 [docs/CHANGELOG.md](docs/CHANGELOG.md)。
> 每一条都写清「为什么这么改」，包括踩过的坑和测试口径的调整 —— 下次改到同一块地方先翻一翻。

### V1.2.20（付款页签挪到核销后面）

老板 2026-10-28：**「修正：付款 在 核销 后面」**

#### 为什么这条顺序不是排版偏好

付款的唯一前置门是核销（`PAYABLE_STATUS = ["已核销"]`）。页签把付款排在核销前面，
人会先点付款、被拦「核销通过后才可付款」、再回头找核销 —— 顺序和流程对着干，
每次都要多绕一步。

#### 改后

| 位置 | 变化 |
|---|---|
| 项目详情页签 | 概览 → 会务需求 → 合同 → **材料 → 核销 → 付款** → 成员与授权 → 操作留痕 |
| 概览 → 流程门禁 | 补一行「付款：N 笔已付 · ¥X（M 笔未完成）」，排在核销之后、结算之前 |

现在「材料 → 核销 → 付款」是一段连续硬顺序，对应三道门：
**材料 8/8 开启核销（V1.2.19）→ 核销通过才可付款 → 付款完成才可结算**。

#### 验证

`test/ui/v1220.js` 12 项：页签顺序（材料 < 核销 < 付款）、待核销时付款按钮禁用、
已核销时可用、概览四行门禁的顺序一致、无 JS 报错。全量 `npm test` 351/351（接口未变）。

### V1.2.19（材料 8 项录入才能开启核销，页签顺序跟着流程走）

老板 2026-10-28：

> 有一个工作流程要规定：必须完成 材料8项录入，才能开启 核销功能。
> 所以项目详情页里 材料 应该在 核销 前面。

#### 改前：材料只是「归档」的门槛

材料 8/8 原本只卡**归档**。核销 6 步可以先判、材料后补 —— 于是判定人手里没有签到表、
没有发票、没有现场照片，只能凭印象点「通过」。核销退化成橡皮图章，材料成了事后凑数。

#### 改后：材料前置到核销入口

| 位置 | 行为 |
|---|---|
| 提交核销（执行中 → 待核销） | 材料不满 8 类 → 409 `MATERIAL_GATE`，并逐类点出缺什么 |
| 单步判定 | 再拦一次 —— 防「门禁上线前已提交」的历史项目，以及提交后材料被删 |
| 核销通过 | 6 步判完但材料被删，仍然不许通过 |
| 项目详情页签 | **材料挪到核销前面**（顺序本身就是提示：先备料，再核销） |
| 核销页签 | 缺料时顶部横幅「核销未开启：材料还缺 N 类」，判定按钮全部隐藏，给「去登记材料 →」 |
| 材料页签 | 标题从「归档材料」改成同时标注「已满足 / 未满足核销前置」 |
| 概览 → 流程门禁 | 多一行「材料（核销前置）」，排在核销之前 |
| 核销看板 | 同样给门禁横幅，材料面板改标「核销前置」 |

归档门禁**没有**被削弱：仍然要求 8/8，只是现在这一关在核销前就过了（`test/v1219.test.js` 有一条专门验它没退化）。

#### 连带的两个决定

1. **种子数据跟着改**：能走到「待核销及以后」的 8 个项目，种子里材料直接给 8/8。
   否则演示时点第 4 步判定会被拦「材料缺 8 类」—— 观众看到的是门禁失效，其实是数据不自洽。
   「筹备中」的项目仍只给 5 类，用来演示「材料还没齐、核销还没开启」的常态。
2. **测试统一走 `test/helpers/materials.js`**：8 类清单只有 `constants` 一份，
   抄散到各测试文件里，以后新增类别必然漏改某几处。

#### 验证

| 层 | 用例 | 结果 |
|---|---|---|
| 接口 | `test/v1219.test.js` 6 项：提交核销被拦（逐类点名）、7 类仍拦/8 类放行、判定兜底、核销通过兜底、归档门禁没退化、两个接口材料状态同源 | 6/6 |
| UI | `test/ui/v1219.js` 13 项：页签顺序、缺料横幅与按钮隐藏、「去登记材料」跳转、补齐后恢复、概览行序 | 13/13 |
| 全量 | `npm test` 351/351、`npm run test:cf` 351/351 | 全绿 |

连带改动：`e2e` 的材料登记从「归档前」整体前移到「提交核销前」；
`api.test.js` 里「归档材料未齐被拦」那条改成「材料已齐 + 结算已生成 → 归档成功」，
负向用例搬进 `v1219`（造一个不补材料的项目直接打归档门禁，语义相同且不干扰主链路）。

### V1.2.18（付款 / 结算单补上「收款方 + 银行账号」）

老板 2026-10-28：**「生成结算单 付款 两个功能板块缺少了 收款方和银行账号 信息」**

#### 改前：单据是「半张凭证」

| 板块 | 原来有什么 | 缺什么 |
|---|---|---|
| 付款 | 收款方名字、金额、发票号 | **开户行、银行账号** —— 财务拿着单子没法打款 |
| 结算单 | 收入 / 支出 / 结余三个数 | **收款方、开户行、银行账号** —— 结余打给谁、打到哪个账户，纸上一个字没有 |

#### 改后

| 位置 | 行为 |
|---|---|
| 付款申请弹窗 | 收款方下面新增「开户行」「银行账号」，**均必填**；账号自动去掉空格再入库 |
| 付款记录列表 | 收款方单元格第二行显示「开户行 · 账号」；老单据显示**未登记收款账户**并给「登记账户」入口 |
| 付款执行 | 没有账户**付不出去**（409 `PAYEE_ACCOUNT_MISSING`）——与其让财务自己发现，不如在门口拦住 |
| 生成结算单 | 从一句「确认继续？」改成弹窗：收款方（默认带出项目负责人）+ 开户行 + 银行账号 |
| 结算单列表 | 新增「收款方 / 收款账户」列 |
| 项目详情 → 概览 | 结算单卡片补一行收款方与账户 |
| 导出 | 付款明细加「开户行 / 银行账号」；结算汇总加「收款方 / 开户行 / 银行账号」 |
| 种子数据 | 14 笔付款按收款方固定映射账户（同一家单位在不同项目上账号一致）；4 张结算单补收款信息 |

#### 三条硬约束（不是「加个字段」那么简单）

1. **新单必须填**：只有收款方名字，财务仍然打不了款；
2. **老单能补录**：账号是这一版才加的字段，线上已有一批没有账户的单子 —— 不给补录入口，
   财务要么打不了款，要么绕线下，这个字段等于白加。补录接口 `PATCH /api/payments/:id/account`，
   限财务与核销（或总管理员）；
3. **已付款不许改**：钱已经出去了，回头改账号等于篡改凭证（409 `PAID_LOCKED`）。

#### 踩到的坑

`/api/projects/:id/transition` 原来只把 `comment` 传给底层：

```js
const { action, comment } = ctx.body || {};
transition(p.id, action, ctx.user, { comment }, ctx.ip);   // 其余字段被解构丢了
```

结算的收款方 / 开户行 / 账号全在这一层被吞掉，表现是「前端明明填了，后端一直报必填」。
改成 `const { action, comment, ...rest } = ctx.body` 并把 `...rest` 透传。
**教训：解构 body 时多写一个 `...rest`，比事后排查「参数去哪了」便宜得多。**

#### 验证

| 层 | 用例 | 结果 |
|---|---|---|
| 接口 | `test/v1218.test.js` 8 项：必填/格式/入库去空格、缺账户付不出去→补录→能付、已付款锁定、补录权限、结算单默认收款方、导出列、种子数据完整性 | 8/8 |
| UI | `test/ui/v1218.js` 17 项：表单字段与拦截、列表显示、老单据补录全流程、概览卡片 | 17/17 |
| 全量 | `npm test` 345/345、`npm run test:cf` 345/345 | 全绿 |

> 更早的版本（V1.2.0 ~ V1.2.17，共 18 个版本）见 [docs/CHANGELOG.md](docs/CHANGELOG.md)。
> 每次改动的「为什么这么改」都写在里面，包括踩过的坑与测试口径的调整。

