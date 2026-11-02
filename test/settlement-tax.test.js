"use strict";
/**
 * 劳务代扣税的结算口径回归。
 * 运行：node --test test/settlement-tax.test.js
 *
 * 老板 2026-11-02：「以劳务表为主，因为有税」。
 * 劳务表记的是含税金额，实付给专家的是税后 —— 刘志华 ¥2,300 含税，
 * 个税 (2300−800)×20% = ¥300 代扣，实付 ¥2,000。
 *
 * 所以「已付款 = 合同总额」这个等式在有代扣税时天然不成立：
 *   · 差额 ≤ 劳务合同额 × 40%  → 认定为代扣税，放行，并记进结算单 tax_withheld
 *   · 差额 > 上限               → 还有款没付，拦住
 *   · 已付款 > 合同总额         → 重复付款或无合同付款，拦住
 */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { settlementLedger } = require("../server/lib/workflow");

/** 按 SQL 特征返回三个数的桩：已付款 / 已签支出合同 / 其中劳务专家 */
function fakeDb({ paid, signedTotal, laborTotal }) {
  return {
    prepare(sql) {
      return {
        get() {
          if (/FROM payments/i.test(sql)) return { total: paid };
          if (/category='劳务专家'/i.test(sql)) return { total: laborTotal };
          return { total: signedTotal };
        }
      };
    }
  };
}

test("没有代扣税：已付款等于合同总额，差额为 0", () => {
  const L = settlementLedger("P1", fakeDb({ paid: 8000, signedTotal: 8000, laborTotal: 2000 }));
  assert.equal(L.paid, 8000);
  assert.equal(L.signedTotal, 8000);
  assert.equal(L.tax, 0);
  assert.equal(L.over, 0);
  assert.equal(L.shortfall, 0);
});

test("刘志华这种：合同 12600、实付 12300，差 300 认定为代扣税", () => {
  const L = settlementLedger("P1", fakeDb({ paid: 12300, signedTotal: 12600, laborTotal: 9425 }));
  assert.equal(L.tax, 300, "差额应认定为代扣税");
  assert.equal(L.over, 0);
  assert.equal(L.shortfall, 0, "300 远低于税上限，不能当成还有款未付");
  assert.equal(L.taxCap, 3770, "劳务 9425 × 40% = 3770");
});

test("差额超过税上限：判定为还有款没付，不能放行", () => {
  // 劳务 1000，税上限 400；合同 5000、实付 3000，差 2000 显然不是税
  const L = settlementLedger("P1", fakeDb({ paid: 3000, signedTotal: 5000, laborTotal: 1000 }));
  assert.equal(L.tax, 0, "超出上限就不能算税");
  assert.equal(L.shortfall, 2000);
});

test("付多了：重复付款或无合同付款，必须拦住", () => {
  const L = settlementLedger("P1", fakeDb({ paid: 13000, signedTotal: 12600, laborTotal: 9425 }));
  assert.equal(L.over, 400);
  assert.equal(L.tax, 0);
  assert.equal(L.shortfall, 0);
});

test("没有劳务合同就不允许有任何差额（税上限为 0）", () => {
  const L = settlementLedger("P1", fakeDb({ paid: 5000, signedTotal: 5300, laborTotal: 0 }));
  assert.equal(L.taxCap, 0);
  assert.equal(L.tax, 0);
  assert.equal(L.shortfall, 300);
});

test("收入类（赞助）合同不进结算口径：支出合同总额已排除", () => {
  // 桩模拟的 SQL 必须带收入类排除条件，否则赞助款会被算成要付的钱
  const seen = [];
  const db = {
    prepare(sql) {
      seen.push(sql);
      return { get: () => ({ total: 100 }) };
    }
  };
  settlementLedger("P1", db);
  const contractSql = seen.filter((s) => /FROM contracts/i.test(s));
  assert.equal(contractSql.length, 2, "合同总额与劳务总额两条查询");
  for (const s of contractSql) {
    assert.match(s, /赞助收入/, "结算口径的合同查询必须排除收入类合同：" + s);
  }
});
