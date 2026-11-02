"use strict";
/**
 * 归档卷宗：收入类（赞助）合同的原件不得出现在核销六步的「关联原件」里。
 * 运行：node --test test/archive-income-filter.test.js
 *
 * 老板 2026-11-02 把德镁那份赞助协议从支出改成了「赞助收入」，
 * 但它当初自动归档的「合同」类原件还在材料中心。
 * 核销第 6 步按类别一过滤就把它带了进来，卷宗看着像这份赞助也被核销了。
 */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { makeLines } = require("../server/lib/archive-pdf");

function records({ contracts, materials }) {
  return {
    project: { id: "MP-T1", name: "测试会议", date: "2026-11-01", assoc: "学会甲", status_at: "2026-11-02" },
    contracts,
    materials,
    verifySteps: []
  };
}

test("赞助合同的原件不出现在任何一步的关联原件里", () => {
  const { lines } = makeLines(records({
    contracts: [
      { id: "HT-001", category: "赞助收入", status: "已签署", amount: 15000 },
      { id: "HT-002", category: "场地餐饮", status: "已签署", amount: 3175 }
    ],
    materials: [
      { id: 1, kind: "合同", name: "HT-001 · 德镁赞助协议", file_name: "德镁.pdf" },
      { id: 2, kind: "合同", name: "HT-002 · 场地租赁合同", file_name: "场地.pdf" },
      { id: 3, kind: "发票", name: "会务发票", file_name: "发票.pdf" }
    ]
  }));
  const text = lines.map((l) => l.text).join("\n");
  assert.match(text, /场地\.pdf/, "支出合同原件应保留");
  assert.doesNotMatch(text, /德镁/, "赞助合同原件不该出现在核销记录里：" + text);
});

test("支出合同的原件照旧保留", () => {
  const { lines } = makeLines(records({
    contracts: [{ id: "HT-009", category: "劳务专家", status: "已签署", amount: 2300 }],
    materials: [{ id: 1, kind: "合同", name: "HT-009 · 专家劳务协议", file_name: "劳务.pdf" }]
  }));
  assert.match(lines.map((l) => l.text).join("\n"), /劳务\.pdf/);
});
