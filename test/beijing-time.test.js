"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const {
  BUSINESS_TIME_ZONE, formatBeijingDateTime, formatBeijingDate, nowIso
} = require("../server/lib/util");

test("business time formatting is always Beijing time regardless of host timezone", () => {
  const instant = new Date("2026-11-28T16:30:45.000Z");
  assert.equal(BUSINESS_TIME_ZONE, "Asia/Shanghai");
  assert.equal(formatBeijingDateTime(instant), "2026-11-29 00:30");
  assert.equal(formatBeijingDateTime(instant, true), "2026-11-29 00:30:45");
  assert.equal(formatBeijingDate(instant), "2026-11-29");
  assert.equal(nowIso(instant), "2026-11-29T00:30:45+08:00");
});
