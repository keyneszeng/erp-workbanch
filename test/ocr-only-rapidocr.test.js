"use strict";
const { test }=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs");
const path=require("node:path");
const root=path.resolve(__dirname,"..");
const read=p=>fs.readFileSync(path.join(root,p),"utf8");

test("material and verification OCR share the RapidOCR bridge; no Tesseract fallback",()=>{
  const ocr=read("server/lib/ocr-engine.js");
  const compare=read("server/lib/verify-ocr-compare.js");
  const material=read("server/api/material-workbench.js");
  assert.match(ocr,/rapid-ocr\.py/);
  assert.match(ocr,/RapidOCR \(rapidocr\/ONNXRuntime\)/);
  assert.doesNotMatch(ocr,/exec\(["']tesseract["']/);
  assert.match(compare,/require\(["']\.\/ocr-engine["']\)/);
  assert.match(compare,/ocr\.providerMatches\(row\.engine\)/);
  assert.match(material,/ocr\.providerMatches\(existing\.engine\)/);
  assert.match(read("server/lib/rapid-ocr.py"),/from rapidocr import RapidOCR/);
});

test("ECS environment install, preflight and CI require RapidOCR, not Tesseract",()=>{
  const installer=read("deploy/aliyun/install-rapidocr.sh");
  assert.match(installer,/rapidocr>=3\.10,<4/);
  assert.match(installer,/onnxruntime/);
  assert.doesNotMatch(read("deploy/aliyun/deploy.sh"),/apt-get install[^\n]*tesseract-ocr/);
  assert.doesNotMatch(read(".github/workflows/qa.yml"),/apt-get install[^\n]*tesseract-ocr/);
  const preflight=read("scripts/rapidocr-preflight.cjs");
  assert.match(preflight,/from rapidocr import RapidOCR/);
});
