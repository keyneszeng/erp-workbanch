"use strict";
/** 合同收款账户抽取：只认真实合同里的写法，抽不到就留空 */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { extractBankInfo } = require("../server/lib/bank-extract");

test("开户行 + 银行账号：常见两种写法都能抽出来", () => {
  const a = extractBankInfo("乙方账号信息如下：\n开户行：中国银行股份有限公司广州中信广场支行\n银行账号：6222 0000 0000 1234");
  assert.equal(a.bank, "中国银行股份有限公司广州中信广场支行");
  assert.equal(a.account, "6222000000001234");

  const b = extractBankInfo("开户信息：       中国工商银行广州员村支行\n\n银行账号：       6222023602078445731");
  assert.equal(b.bank, "中国工商银行广州员村支行");
  assert.equal(b.account, "6222023602078445731");
});

test("没有账号/开户行时留空，不猜", () => {
  const r = extractBankInfo("本合同以银行转账方式支付，账号另行提供。");
  assert.equal(r.bank, "");
  assert.equal(r.account, "");
});

test("「账号信息如下」这类引导语不会被当成开户行", () => {
  const r = extractBankInfo("乙方账号信息如下：\n开户行：见附件");
  assert.equal(r.bank, "", "「见附件」不是银行机构名");
});

test("账号长度不合规时丢弃", () => {
  const r = extractBankInfo("开户行：中国银行广州分行\n银行账号：12345");
  assert.equal(r.bank, "中国银行广州分行");
  assert.equal(r.account, "");
});
