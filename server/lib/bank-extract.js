"use strict";
/**
 * 从合同原件里抽取收款账户。
 *
 * 合同正文通常写着「开户行：中国银行…支行」「银行账号：6222…」，
 * 但录合同的人不会顺手再抄一遍到台账 —— 结果财务付款时还得回头翻 PDF。
 * 这里按真实合同里最常见的几种写法抽取，抽不到就留空，绝不猜。
 */
const { execFile } = require("node:child_process");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

// 合同里同一个词常有不同排法：「帐 号」「开 户 行」都出现过，标签里允许空格
const BANK_LABEL = "(?:开\\s*户\\s*行|开户银行|开户信息|收款银行|收款开户行|开户机构|乙方开户行)";
const ACCT_LABEL = "(?:银行\\s*账\\s*号|银行\\s*帐\\s*号|收款\\s*账\\s*号|收款\\s*帐\\s*号|银行\\s*账户|账\\s*号|帐\\s*号|账户)";

/** 去掉「如下」「：」之类的残渣，只留机构名 */
function cleanBank(s) {
  return String(s || "")
    .replace(/^[\s:：，,。；;、]+/, "")
    .replace(/[\s:：，,。；;、]+$/, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function extractBankInfo(raw) {
  const text = String(raw || "").replace(/\r/g, "");
  let bank = "", account = "";

  const bm = text.match(new RegExp(BANK_LABEL + "\\s*[:：]?\\s*([^\\n]{4,50})"));
  if (bm) {
    const v = cleanBank(bm[1]);
    // 必须像个银行机构名，避免把「如下」「见附件」当成开户行
    if (/银行|信用社|支行|分行|营业部/.test(v)) bank = v.slice(0, 40);
  }

  const am = text.match(new RegExp(ACCT_LABEL + "\\s*[:：]?\\s*([\\d][\\d\\s-]{9,29})"));
  if (am) {
    const digits = am[1].replace(/[\s-]/g, "");
    if (/^\d{10,25}$/.test(digits)) account = digits;
  }

  return { bank, account };
}

/** 读 PDF 文本层；读不到（扫描件）返回空串，由调用方决定要不要 OCR */
async function pdfTextLayer(buffer) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "erp-bank-"));
  try {
    const file = path.join(dir, "in.pdf");
    await fs.writeFile(file, buffer, { mode: 0o600 });
    return await new Promise((resolve) => {
      execFile("pdftotext", ["-layout", file, "-"], { timeout: 20000, maxBuffer: 8 * 1024 * 1024 },
        (e, stdout) => resolve(e ? "" : String(stdout || "")));
    });
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

module.exports = { extractBankInfo, pdfTextLayer };
