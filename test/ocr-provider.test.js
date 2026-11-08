"use strict";
/**
 * OCR 引擎：只用 RapidOCR（PP-OCR 的 ONNXRuntime 版）。
 *
 * 单测不依赖 Python 环境：mock exec 返回 JSON，验证坐标还原与错误语义。
 * 真正的识别质量靠线上样本，不是单测能覆盖的。
 */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { recognize, providerMatches, rapidItemsToText } = require("../server/lib/ocr-engine");

// 1×1 透明 PNG：只要能过 MIME 嗅探即可
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64"
);

function withOcr(fn) {
  return async () => {
    const prev = process.env.ERP_OCR_ENABLED;
    process.env.ERP_OCR_ENABLED = "1";
    try {
      await fn();
    } finally {
      if (prev === undefined) delete process.env.ERP_OCR_ENABLED;
      else process.env.ERP_OCR_ENABLED = prev;
    }
  };
}

test("按坐标还原表格列，中文不拆字", () => {
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

test("provider：调用 Python 脚本并解析 JSON", withOcr(async () => {
  const calls = [];
  const r = await recognize(PNG, "png", {
    exec: async (bin, args) => {
      calls.push({ bin, args });
      return JSON.stringify({ items: [
        { text: "讲者", x: 10, y: 10, w: 40, h: 20, score: 1 },
        { text: "张三", x: 200, y: 10, w: 40, h: 20, score: 1 }
      ] });
    }
  });
  assert.match(r.engine, /RapidOCR/);
  assert.match(r.text, /讲者\t张三/);
  assert.match(calls[0].args[0], /rapid-ocr\.py$/);
}));

test("未安装 RapidOCR：给出可操作的错误，而不是笼统的 500", withOcr(async () => {
  const err = Object.assign(new Error("OCR 依赖尚未安装：/opt/rapidocr-venv/bin/python"), {
    code: "OCR_ENGINE_MISSING"
  });
  await assert.rejects(
    recognize(PNG, "png", { exec: async () => { throw err; } }),
    { code: "OCR_PROVIDER_MISCONFIGURED" }
  );
}));

test("旧识别引擎缓存失效，PDF 文本层仍可复用", () => {
  assert.equal(providerMatches("Tesseract chi_sim+eng（PSM 3）"), false);
  assert.equal(providerMatches("Poppler pdftotext"), true);
  assert.equal(providerMatches("RapidOCR (PP-OCR)"), false);
  assert.equal(providerMatches("RapidOCR (rapidocr/ONNXRuntime)"), true);
  assert.equal(providerMatches(null), false);
});

test("RapidOCR 返回结构化错误时不误报成功", withOcr(async () => {
  await assert.rejects(recognize(PNG, "png", {
    exec: async () => JSON.stringify({ error: "No module named rapidocr" })
  }), { code: "OCR_PROVIDER_FAILED" });
  await assert.rejects(recognize(PNG, "png", {
    exec: async () => JSON.stringify({ unexpected: true })
  }), { code: "OCR_PROVIDER_FAILED" });
}));
