# LiteParse PDF 文档解析增强（可选，试验性）
 
## 方案与边界

- 当前核心识别仍是本地 RapidOCR 3.x + ONNX Runtime；PDF 文本层保留 Poppler。
- 新增固定版本 `@llamaindex/liteparse@2.21.4`（Apache-2.0），通过 PDFium 做混合 PDF 解析，选择性调用本机 RapidOCR HTTP 接口，使用空间布局文本对接既有提取器。不会安装 OCRia-nano 模型、不会使用 Tesseract 作为识别后端、不调用云服务。
- 仅当 `ERP_OCR_ENABLED=1` 且 `ERP_LITEPARSE_ENABLED=1` 时，对走 `ocr.recognize` 的普通 PDF 生效。原生 Office/XLSX 提取、图片直接 OCR、`extractPdfText` 原生文本专用入口、强制课件封面视觉识别保持原状。并非所有合同扫描入口都已切换。
- 分页限制、MIME 检查、既有权限、原件和人工核销判断不变。每个 ERP 进程最多一个 LiteParse 任务，单次 120 秒/16 MiB 输出上限；忙、超时、失败、缺页、空页、已知 OCR 部分失败均回退既有流程。原流程自身可能仅取文字层或有限页面，回退不保证扫描内容齐全。
- 只消费经过验证的逐页空间布局文本；JSON 的文字框暂不入库、暂不提供新前端定位界面。复杂表格结构、实际业务字段准确率、性能均须独立验证。旧 RapidOCR/Poppler 缓存仍有效，已有材料须走原有重新识别功能进行对照。关闭开关后 LiteParse 识别缓存不再作为当前引擎结果使用。
- Apache-2.0 核心与独立模型授权不同。上线前复核 npm 包、RapidOCR 模型和依赖授权；不要执行 `lit models pull ocria-nano`。
 
## 阿里云测试环境先行

先备份并部署主分支到测试环境，不影响生产数据库。需要 Node >=22、现有 ERP 服务账号 erp、Poppler、现有 RapidOCR venv。以下命令在测试服务器当前代码目录执行；安装可能需要访问 npm/PyPI，识别服务本身只绑定 127.0.0.1。

```bash
cd /opt/erp-test/current
sudo bash deploy/aliyun/install-rapidocr.sh  # 已安装且预检通过则无需重复
sudo bash deploy/aliyun/install-liteparse.sh
sudo install -m 0644 deploy/aliyun/erp-liteparse.service /etc/systemd/system/erp-liteparse.service
sudo systemctl daemon-reload
sudo systemctl enable --now erp-liteparse.service
curl --fail --max-time 10 http://127.0.0.1:18765/health
```

如模型尚未本地缓存，先用脱敏图片离线预热/配置权重并验证服务账号读取权限；service 禁止外部 IP 通信，不应为解决下载问题开放生产资料上传或外网推理。若 sidecar 无法启动，保持开关关闭并检查 `journalctl -u erp-liteparse`。不要将 18765 暴露到 Nginx 或公网。测试与生产若在同一 ECS，可共用该无状态本地推理进程，但会争用资源；生产启用前必须测量负载，必要时独立 ECS。安装器不启动、不重启 ERP，也不自动改环境变量。

仅修改测试环境 `/etc/erp-workbanch/test.env`：

```dotenv
ERP_OCR_ENABLED=1
ERP_LITEPARSE_ENABLED=1
ERP_LITEPARSE_BIN=/opt/erp-liteparse/node_modules/.bin/lit
```

```bash
sudo systemctl restart erp-test
sudo systemctl status erp-test erp-liteparse
```

测试样本先使用合成或脱敏材料。直接 CLI 检查（在授权目录执行，结果含原件内容，不要写入公开目录/日志）：

```bash
umask 077
/opt/erp-liteparse/node_modules/.bin/lit parse ./sample.pdf --format json \
  --ocr-server-url http://127.0.0.1:18765/ocr --ocr-language zh \
  --target-pages 1-3 --max-pages 3 --num-workers 1 --dpi 250 \
  --keep-headers-footers --preserve-small-text --quiet -o ./result.json
```

## 验收矩阵与回滚

在独立样本副本上比较关闭/开启开关两种结果：
 
| 样本 | 核验重点 |
|---|---|
| 原生 PDF 合同、发票 | 签约方、合同/发票金额、号码，不多识别金额 |
| 混合型 PDF（原生页 + 扫描页） | 页数一致，扫描页内容不漏 |
| 多页终版议程 | 日期、课题、讲者、主持、时间段对齐 |
| 劳务表与在线参会记录 | 金额、姓名、账号、时长对应正确；报告脱敏 |
| 课件封面及原生 Excel | 旧路径结果不变 |
| 空白/加密/损坏/超页数、服务离线 | 不误报通过；回退、超时与人工核对可用 |
 
逐字段统计精确匹配率、漏识别率、错误配对率、延迟 P50/P95、进程 RSS、超时率、人工修正时间；金额、银行账号、项目对应关系为强校验项，任何新增误判不得自动进入付款。核销必须由原有权限和人工确认决定。性能数据以 ECS 实测为准，不直接引用供应商 benchmark 作为上线结论。

```bash
ERP_DEMO_MODE=1 node --experimental-sqlite --test test/liteparse-provider.test.js test/ocr-engine.test.js test/ocr-provider.test.js test/ocr-preflight.test.js
```

单元测试使用注入的命令返回值，不等同实际模型推理或生产测试。满足验收后，再按现行主仓库发布规则部署生产并单独打开开关。回滚：设置对应环境 `ERP_LITEPARSE_ENABLED=0`，重启对应 ERP 服务；确认没有其他启用的环境后可停用 `erp-liteparse.service`。不迁移财务数据、不修改核销结论。

上游：[LiteParse](https://github.com/run-llama/liteparse/tree/node-v2.21.4) · [OCR HTTP API](https://github.com/run-llama/liteparse/blob/node-v2.21.4/OCR_API_SPEC.md) · [Apache-2.0](https://github.com/run-llama/liteparse/blob/node-v2.21.4/LICENSE)。
