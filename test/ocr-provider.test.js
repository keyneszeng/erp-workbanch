"use strict";
/**
 * OCR 引擎可插拔：tesseract / 自建 Unlimited-OCR / 百度云 Unlimited-OCR。
 *
 * 这里不依赖 GPU、不联网、不装 tesseract：用本地 mock HTTP 服务模拟
 * vLLM/SGLang 与百度云，验证「请求格式、响应解析、失败语义」三件事。
 * 真正的识别质量要靠线上样本对比，不是单测能覆盖的。
 */
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { recognize, stripDet, providerMatches, psmFor, rapidItemsToText, _resetBaiduToken } = require("../server/lib/ocr-engine");

// 1×1 透明 PNG：只要能过 MIME 嗅探即可
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64"
);
const ENV_KEYS = [
  "ERP_OCR_ENABLED", "ERP_OCR_PROVIDER", "ERP_OCR_FALLBACK",
  "ERP_OCR_HTTP_URL", "ERP_OCR_HTTP_KEY", "ERP_OCR_HTTP_MODEL",
  "ERP_BAIDU_OCR_BASE", "ERP_BAIDU_OCR_API_KEY", "ERP_BAIDU_OCR_SECRET_KEY",
  "ERP_BAIDU_OCR_TIMEOUT_MS"
];

let server, base, seen = [], saved = {};

before(async () => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      seen.push({ url: req.url, method: req.method, body });
      const send = (code, payload, type = "application/json") => {
        res.writeHead(code, { "content-type": type });
        res.end(type === "application/json" ? JSON.stringify(payload) : payload);
      };
      if (req.url.startsWith("/v1/chat/completions"))
        return send(200, { choices: [{ message: { content:
          "<|det|>title [0,0,200,30]<|/det|>2026 年学术会议\n" +
          "<|det|>text [0,40,200,60]<|/det|>09:00-09:30 讲者：张三 课题：胃肠病诊疗新进展\n" +
          "<|det|>image [0,70,200,120]<|/det|>" } }] });
      if (req.url.startsWith("/oauth/2.0/token"))
        return send(200, { access_token: "tk-1", expires_in: 2592000 });
      if (req.url.startsWith("/rest/2.0/brain/online/v2/unlimited-ocr-parser/task?"))
        return send(200, { error_code: 0, result: { task_id: "task-1" } });
      if (req.url.startsWith("/rest/2.0/brain/online/v2/unlimited-ocr-parser/task/query"))
        return send(200, { error_code: 0, result: {
          task_id: "task-1", status: "success", cost_page_num: 1,
          markdown_url: base + "/result.md" } });
      if (req.url === "/result.md")
        return send(200, "# 会议议程\n\n09:00 开场\n\n讲者：李四 课题：临床研究", "text/markdown");
      send(404, { error: "not found" });
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server.close();
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

function resetEnv() {
  for (const k of ENV_KEYS) delete process.env[k];
  process.env.ERP_OCR_ENABLED = "1";
  seen = [];
  _resetBaiduToken();
}

test("stripDet：去掉版面标记、丢弃 image 块、保留正文分块", () => {
  const raw = [
    "<|det|>title [0,0,200,30]<|/det|>2026 年学术会议 终版议程",
    "<|det|>text [0,40,200,60]<|/det|>19:35-20:05  内痔的规范化治疗  徐一劲   东莞市人民医院",
    "<|det|>image [0,70,200,120]<|/det|>",
    "<|det|>table [0,130,200,200]<|/det|>讲者：张三 课题：胃肠病诊疗新进展",
    "<|end▁of▁sentence|>"
  ].join("\n");
  const text = stripDet(raw);
  assert.match(text, /2026 年学术会议 终版议程/);
  assert.match(text, /徐一劲/);
  assert.match(text, /讲者：张三/);
  assert.ok(!text.includes("<|det|>"), "版面标记必须清掉");
  assert.ok(!text.includes("<|end▁of▁sentence|>"), "特殊 token 必须清掉");
  assert.ok(!/^image$/m.test(text), "image 块不是文字，不应留下");
});

test("自建 Unlimited-OCR：请求走 OpenAI 兼容格式，响应还原成纯文本", async () => {
  resetEnv();
  process.env.ERP_OCR_PROVIDER = "unlimited";
  process.env.ERP_OCR_HTTP_URL = base;
  process.env.ERP_OCR_HTTP_KEY = "secret-key";

  const r = await recognize(PNG, "png");
  assert.equal(r.mode, "ocr");
  assert.match(r.engine, /Unlimited-OCR/);
  assert.match(r.text, /2026 年学术会议/);
  assert.match(r.text, /09:00-09:30 讲者：张三/);
  assert.ok(!r.text.includes("<|det|>"));
  assert.equal(r.degraded, undefined, "成功时不应标记降级");

  const call = seen.find((x) => x.url.startsWith("/v1/chat/completions"));
  assert.ok(call, "必须真的请求了推理服务");
  const payload = JSON.parse(call.body);
  assert.equal(payload.model, "Unlimited-OCR");
  assert.equal(payload.temperature, 0);
  assert.equal(payload.messages[0].content[0].type, "text");
  assert.match(payload.messages[0].content[1].image_url.url, /^data:image\/png;base64,/);
  assert.equal(payload.images_config.image_mode, "gundam", "单图用 gundam 档");
});

test("自建服务未配置地址：明确报配置错误，不回退到别的引擎", async () => {
  resetEnv();
  process.env.ERP_OCR_PROVIDER = "unlimited";
  process.env.ERP_OCR_FALLBACK = "0";
  await assert.rejects(recognize(PNG, "png"), { code: "OCR_PROVIDER_MISCONFIGURED" });
});

test("未知引擎名：直接拒绝，不猜也不静默降级", async () => {
  resetEnv();
  process.env.ERP_OCR_PROVIDER = "paddle";
  process.env.ERP_OCR_FALLBACK = "0";
  await assert.rejects(recognize(PNG, "png"), { code: "OCR_PROVIDER_UNKNOWN" });
});

test("百度云 Unlimited-OCR：鉴权 → 提交 → 轮询 → 下载 markdown", async () => {
  resetEnv();
  process.env.ERP_OCR_PROVIDER = "baidu";
  process.env.ERP_BAIDU_OCR_BASE = base;
  process.env.ERP_BAIDU_OCR_API_KEY = "ak-test";
  process.env.ERP_BAIDU_OCR_SECRET_KEY = "sk-test";

  const r = await recognize(PNG, "png");
  assert.equal(r.mode, "ocr");
  assert.match(r.engine, /百度云 Unlimited-OCR/);
  assert.match(r.text, /09:00 开场/);
  assert.match(r.text, /讲者：李四/);

  const order = seen.map((x) => x.url.split("?")[0]);
  assert.ok(order.some((u) => u === "/oauth/2.0/token"), "应先换 access_token");
  assert.ok(order.some((u) => u.endsWith("/unlimited-ocr-parser/task")), "应提交解析任务");
  assert.ok(order.some((u) => u.endsWith("/unlimited-ocr-parser/task/query")), "应轮询结果");
  assert.ok(order.some((u) => u === "/result.md"), "应下载 markdown");

  const submit = seen.find((x) => x.url.includes("/unlimited-ocr-parser/task?"));
  assert.match(submit.body, /file_data=/, "原件以 base64 表单提交");
  assert.match(submit.body, /file_name=original\.png/);
});

test("PSM 按材料类型选择：劳务/名单用 6，议程/合同用 3", () => {
  for (const kind of ["劳务表", "劳务收集表", "签到表", "参会数据", "专家名单", "发放明细"])
    assert.equal(psmFor(kind), "6", kind + " 应走 PSM 6");
  for (const kind of ["议程", "终版议程", "合同", "发票", "课件", "串场", ""])
    assert.equal(psmFor(kind), "3", kind + " 应走 PSM 3");
});

test("RapidOCR：按坐标还原表格列，中文不拆字", () => {
  const items = [
    { text: "时间", x: 55, y: 224, w: 60, h: 30, score: 1 },
    { text: "课题", x: 253, y: 222, w: 60, h: 30, score: 1 },
    { text: "讲者", x: 974, y: 222, w: 60, h: 30, score: 1 },
    { text: "单位", x: 1175, y: 222, w: 60, h: 30, score: 1 },
    { text: "19:00-19:10", x: 58, y: 304, w: 150, h: 30, score: 1 },
    { text: "开场致辞", x: 257, y: 303, w: 120, h: 30, score: 1 },
    { text: "李建国", x: 976, y: 304, w: 90, h: 30, score: 1 },
    { text: "南方医科大学南方医院", x: 1179, y: 304, w: 300, h: 30, score: 1 }
  ];
  const text = rapidItemsToText(items);
  assert.match(text, /时间\t课题\t讲者\t单位/);
  assert.match(text, /19:00-19:10\t开场致辞\t李建国\t南方医科大学南方医院/);
  assert.ok(!/时 间/.test(text), "同一格内的中文不能被空格拆开");
});

test("RapidOCR provider：调用 Python 脚本并解析 JSON", async () => {
  resetEnv();
  process.env.ERP_OCR_PROVIDER = "rapidocr";
  process.env.ERP_RAPIDOCR_PYTHON = "/fake/python";
  const calls = [];
  const fakeExec = async (bin, args) => {
    calls.push({ bin, args });
    return JSON.stringify({ items: [
      { text: "讲者", x: 10, y: 10, w: 40, h: 20, score: 1 },
      { text: "张三", x: 200, y: 10, w: 40, h: 20, score: 1 }
    ], ms: 10 });
  };
  const r = await recognize(PNG, "png", { exec: fakeExec });
  assert.match(r.engine, /RapidOCR/);
  assert.match(r.text, /讲者\t张三/);
  assert.equal(calls[0].bin, "/fake/python");
  assert.match(calls[0].args[0], /rapid-ocr\.py$/);
});

test("引擎切换后旧缓存不再命中，避免「换了引擎却没生效」", () => {
  assert.equal(providerMatches("Tesseract chi_sim+eng", "tesseract"), true);
  assert.equal(providerMatches("Poppler pdftotext", "tesseract"), true);
  assert.equal(providerMatches("Tesseract chi_sim+eng", "unlimited"), false);
  assert.equal(providerMatches("Unlimited-OCR（自建）", "unlimited"), true);
  assert.equal(providerMatches("Tesseract chi_sim+eng（unlimited 失败已降级）", "unlimited"), false,
    "降级结果下次应重试远端，不能永久固化成本地结果");
  assert.equal(providerMatches("百度云 Unlimited-OCR", "baidu"), true);
  assert.equal(providerMatches("百度云 Unlimited-OCR", "tesseract"), false);
});

test("百度云缺密钥：报配置错误，而不是发出无效请求", async () => {
  resetEnv();
  process.env.ERP_OCR_PROVIDER = "baidu";
  process.env.ERP_OCR_FALLBACK = "0";
  await assert.rejects(recognize(PNG, "png"), { code: "OCR_PROVIDER_MISCONFIGURED" });
  assert.equal(seen.length, 0, "配置不全时不应发出任何网络请求");
});
