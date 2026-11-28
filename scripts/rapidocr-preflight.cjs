"use strict";
/* Shared ECS OCR preflight. Tesseract is deliberately not required. */
const path = require("node:path");
const { spawnSync } = require("node:child_process");

function checkRapidOcr(env = process.env, spawn = spawnSync) {
  const flag = env.ERP_OCR_ENABLED;
  if (flag && !["0", "1"].includes(flag))
    throw new Error("ERP_OCR_ENABLED 必须为 0 或 1");
  const liteFlag=env.ERP_LITEPARSE_ENABLED;
  if(liteFlag&&!["0","1"].includes(liteFlag))throw new Error("ERP_LITEPARSE_ENABLED 必须为 0 或 1");
  if(liteFlag==="1"&&flag!=="1")throw new Error("LiteParse 需要 ERP_OCR_ENABLED=1");
  if (flag !== "1") return;

  const python = String(env.ERP_RAPIDOCR_PYTHON || "/opt/rapidocr-venv/bin/python");
  if (!path.isAbsolute(python))
    throw new Error("ERP_RAPIDOCR_PYTHON 必须是绝对路径");

  for (const cmd of ["pdfinfo", "pdftotext", "pdftoppm"]) {
    const res = spawn(cmd, ["-v"], { encoding: "utf8", timeout: 5000, maxBuffer: 65536 });
    if (res.error || res.status !== 0)
      throw new Error("已启用 OCR 但缺少 Poppler 依赖 " + cmd + "，请安装 poppler-utils");
  }

  const res = spawn(python, ["-c", "from rapidocr import RapidOCR; import onnxruntime"], {
    encoding: "utf8", timeout: 20000, maxBuffer: 65536
  });
  if (res.error || res.status !== 0)
    throw new Error("已启用 OCR 但 RapidOCR 不可用（Python 依赖或解释器错误）；请执行 deploy/aliyun/install-rapidocr.sh");
  if(liteFlag==="1"){
    const {binary}=require("../server/lib/liteparse-provider");
    const probe=spawn(binary(env),["--version"],{encoding:"utf8",timeout:10000,maxBuffer:65536});
    if(probe.error||probe.status!==0||!String(probe.stdout||"").includes("2.21.4"))throw new Error("LiteParse 2.21.4 未正确安装，请执行 deploy/aliyun/install-liteparse.sh");
  }
}
module.exports = { checkRapidOcr };
