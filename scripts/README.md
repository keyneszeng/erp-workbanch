# scripts/

运维脚本。**不是测试**，不进 `npm test`，跑完不改代码。

## shot.js —— 通用截图

给老板看效果的截图工具。参数化，覆盖「登录 → 打开某个页面 → 点几个按钮 → 截整页」这条常见路径。

```bash
# 线上，截项目详情
node scripts/shot.js --path "#/projects/MP-2026-017" --out docs/v1.2.20/01-页签顺序.png

# 点开某个页签再截（--click 可重复，按顺序执行）
node scripts/shot.js --path "#/projects/MP-2026-003" --click '[data-tab="verify"]' \
  --out docs/v1.2.20/02-核销页签.png

# 本地起服务（种子数据，不碰线上）
node scripts/shot.js --local --path "#/projects/MP-2026-017" --out /tmp/a.png

# 换账号 / 多等一会儿 / 只截可视区
node scripts/shot.js --user finance --wait 3000 --viewport --out /tmp/b.png
```

| 参数 | 说明 |
|---|---|
| `--path` | hash 路由，如 `#/projects/MP-2026-017`；不给则截首页 |
| `--out` | 输出 png（相对仓库根目录或绝对路径），**必填** |
| `--user` | 登录账号，默认 `admin`（密码统一 `123456`） |
| `--click` | 点击选择器，可重复；每次点完等 `--step` 毫秒 |
| `--wait` | 打开页面后额外等待，默认 1800 |
| `--step` | 每次点击后的等待，默认 800 |
| `--viewport` | 只截可视区（默认整页） |
| `--local` | 本地起服务（端口 8792 + 种子数据），不访问线上 |
| `--base` | 指定站点，默认 `https://erp.aibuild.work` |

**为什么用 `domcontentloaded` 而不是 `networkidle`**：线上响应 2~3 秒且存在长连接，
`networkidle` 经常等不到。V1.2.20 截图时连挂三次就是这个原因。

## shot-cdet.js —— 合同详情专用

比通用脚本复杂，保留下来是因为它会**本地造一份像样的合同 PDF**（甲方乙方 / 金额 / 条款 / 红章），
上传后挂到合同上，再点「详情」截内嵌效果。通用脚本做不了这段造数据。

```bash
node scripts/shot-cdet.js
```

---

## 一个约定

**不要每做一个版本就复制一份截图脚本。** 原来 V1.2.15 ~ V1.2.20 各有一个 `shot-v12xx.js`，
6 个文件几乎一样，改一次等待策略要改 6 遍。用 `shot.js` 传参数，不够用就给它加参数。
