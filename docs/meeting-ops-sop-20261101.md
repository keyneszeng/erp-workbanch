# 会议项目会后核销与材料中心改造 · 2026-11-01 图示验收基线

## 一、范围与交付边界

基线为用户提交的《会后核销工作流详细图》和《专题原型与交互规则》两张图片。本轮已把后端状态与前端录入逻辑改造成结构化人工核验版本。**本版本没有接入 OCR、图像内容比对、会议在线时长平台、电子签章验真、银行流水或微信原生自动读取**，所有原件真实性与现场情况仍需要经授权的人员复核。不可把演示环境记录当作实际结算凭证。

## 二、六步核销（MeetingProject）

| 步骤 | 业务核验 | 现有接口/核验依据 |
|---|---|---|
| 1 | 文件盖章且为终版；会议名称、日期、主办方、招商主体匹配 | `POST /api/projects/:id/verify/steps/1`；`evidence.documentKind/meetingName/meetingDate/organizer/sponsor/stamped/final` |
| 2 | 议程、劳务收集表和劳务协议讲者名单三处覆盖，无冒领漏发 | 步骤 2；`agendaSpeakers/collectionSpeakers/agreementSpeakers/noOmissions`；原件为上传材料 |
| 3 | 线上讲者有效在线 >30min；线下有签到表；混合双满足 | 步骤 3；`onlineMinutes/signedAttendance`；需要人工提供可信的平台记录或签到表 |
| 4 | 课件课题与终版议程一致，串场标题与主办方名称/logo 匹配；药企 logo 限定首页/尾页/鸣谢页 | 步骤 4；`agendaTopics/courseTopics/hostTitleMatches/hostNameLogoMatches/sponsorLogoPages` |
| 5 | 劳务五字段（姓名/时间/角色/金额/银行账户）逐人一致 | 步骤 5；`collectionRecords/agreementRecords`；账号仅在进程内比对，返回的 `evidence_json` 不包含账号 |
| 6 | 已签署合同、拟结算单、发票金额/会议名称/会议日期一致 | 步骤 6；`invoiceAmount` 与 `evidence.draftAmount/meetingName/meetingDate`；复用既有合同审批与发票金额硬门禁 |

正式（非 demo）环境只有按顺序完成六步、任何已批准例外均处理且回到原步骤复核通过，才能 `verify_pass`；付款申请/协会审批/财务执行及正式结算仍必须遵循原 ERP 状态机。`已解例外` 历史值不自动计为正式核销通过。

## 三、例外单与整改闭环

1. 核验步骤 `result=不通过` 时填写问题描述，系统生成例外单与审批单；`step_no=0` 可表示整体性例外。
2. 审核人审批后，正式环境进入 `待复核`，审批不会自动改变该核验步骤为「通过」。
3. 有权限的处理人调用 `POST /api/exceptions/:id/resolve`，必须提交 `resolution`（4–500 字）与 `materialId`（同项目已上传原件）。
4. 步骤 1–6 的例外只允许返回对应 `/verify/steps/:no` 重新提交核验并自动闭环。整体性例外（步骤 0）由核销审核人在证据齐全后调用 `POST /api/exceptions/:id/close` 确认。
5. 待审批、待复核或没有符合条件的原件均阻止 `verify_pass`。处理人、处理时间、审核人、审核结论和材料引用留痕；已结算不能补改。

## 四、材料中心、议程待办

- `GET /api/projects/:id/material-workbench` 查询该项目的模块启停和待办。
- `POST .../modules` 启停固定模块：课件、串场、劳务收集表、劳务协议。停用**不会删除历史材料**；归档材料现按自由类别收集，项目至少上传一份附件即可满足材料推进条件，不再要求固定八类齐全。
- 上传「终版议程」原件后，`POST .../agenda` 以人工输入的讲者、课题明细创建每位讲者的课件与串场待办。现阶段**不是 OCR**。
- `POST .../tasks/:taskId/compare` 将同项目已上传材料名称与讲者+课题做保守字符串比对，匹配则「比对通过」，否则「不一致」；`POST .../review` 记录人工复核与补件原因。
- 材料登记保留版本、上传人、原件。删除改为软删，历史数据库行和附件保留；正式结算后禁止继续增删材料。
- 补充图片、劳务表单和历史自定义分类不影响原有归档八类的硬性完整性规则。

## 五、会务需求（4 组、7 项必填）

设计、制作、现场执行、其他四组持续保留。需求条目含：是否需要、规格/数量、负责人、交付时间、预算归属、附件、执行状态。额外保留预算金额供实际财务核对。确认归档后单据锁定，变更必须先撤销确认再更新，`demand_revisions` 记录变更前后值、操作人和时间，`GET /api/demand/:id/revisions` 可查历史，后续再次确认。

**仍需深化**：需求附件字段目前为文件标识/「不适用」的结构化录入，并非完整文件选择控件和自动取证；角色/项目权限必须持续执行接口层校验。

## 六、代码与验证

关键文件：

- `server/lib/meeting-sop.js` — 六步证据校验。
- `server/api/verify.js`、`server/lib/workflow.js` — 判定、例外闭环、核销/结算门禁。
- `server/api/material-workbench.js`、`web/assets/js/lib/material-workbench.js` — 项目材料待办。
- `server/api/demand.js`、`web/assets/js/pages/demand.js` — 七项字段与快照。
- `server/lib/db.js` — 增量迁移（不自动迁移历史核销结论）。
- `test/meeting-sop.test.js`、`test/erp-production-policy.test.js` — 结构化证据与关键流程测试。

在 PR 内运行 `npm test`、`npm run test:cf` 与 Worker 兼容性 dry-run。合并前必须复核真实生产既有核销记录与差异、独立数据库备份和恢复、上传存储、权限及财务全链路浏览器黑盒测试。Cloudflare `erp.aibuild.work` 仍为演示；正式生产继续规划为独立阿里云 ECS，**本 PR 不部署任何服务**。
