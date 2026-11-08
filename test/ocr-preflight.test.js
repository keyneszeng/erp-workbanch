"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { checkRapidOcr } = require("../scripts/rapidocr-preflight.cjs");

test("RapidOCR is optional when disabled, and invalid flags fail closed", () => {
  assert.doesNotThrow(() => checkRapidOcr({ ERP_OCR_ENABLED: "0" }, () => { throw new Error("spawn not expected"); }));
  assert.throws(() => checkRapidOcr({ ERP_OCR_ENABLED: "true" }), /ERP_OCR_ENABLED/);
  assert.throws(() => checkRapidOcr({ ERP_OCR_ENABLED: "1", ERP_RAPIDOCR_PYTHON: "./python" }), /绝对路径/);
});

test("preflight validates Poppler and unified RapidOCR, never Tesseract", () => {
  const called = [];
  checkRapidOcr({ ERP_OCR_ENABLED: "1", ERP_RAPIDOCR_PYTHON: "/opt/ocr/bin/python" }, (program, args) => {
    called.push([program, args]);
    return { status: 0 };
  });
  assert.deepEqual(called.map(row => row[0]), ["pdfinfo", "pdftotext", "pdftoppm", "/opt/ocr/bin/python"]);
  assert.match(called.at(-1)[1][1], /from rapidocr import RapidOCR/);
  assert.ok(!called.some(row => row[0] === "tesseract"));
});

test("preflight reports missing Poppler and Python without leaking credentials", () => {
  assert.throws(() => checkRapidOcr({ ERP_OCR_ENABLED: "1" }, cmd =>
    cmd === "pdftotext" ? { status: 1 } : { status: 0 }), /pdftotext/);
  assert.throws(() => checkRapidOcr({ ERP_OCR_ENABLED: "1" }, cmd =>
    cmd.includes("python") ? { status: 1 } : { status: 0 }), /RapidOCR 不可用/);
});
