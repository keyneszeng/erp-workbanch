"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { mkdtempSync, writeFileSync, rmSync } = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const python = process.env.PYTHON || "python3";
const present = spawnSync(python, ["--version"], { encoding: "utf8", timeout: 5000 }).status === 0;
const script = path.join(__dirname, "../server/lib/rapid-ocr.py");

test("RapidOCR Python bridge reads modern RapidOCROutput (not legacy tuples)", { skip: !present }, () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "rapidocr-bridge-test-"));
  try {
    writeFileSync(path.join(dir, "rapidocr.py"), [
      "print('module import diagnostic')",
      "from types import SimpleNamespace",
      "class RapidOCR:",
      "  def __call__(self, path):",
      "    if path == 'blank': return SimpleNamespace(boxes=None, txts=None, scores=None)",
      "    if path == 'broken': raise ValueError('invalid image')",
      "    return SimpleNamespace(boxes=[[[10,20],[50,20],[50,40],[10,40]]], txts=['中文测试'], scores=[0.98])",
      ""
    ].join("\n"));
    for (const [input, expected] of [
      ["sample", { text: "中文测试", x: 10, y: 20, w: 40, h: 20 }],
      ["blank", null],
      ["broken", "error"]
    ]) {
      const r = spawnSync(python, [script, input], {
        encoding: "utf8", timeout: 10000, env: { ...process.env, PYTHONPATH: dir }
      });
      assert.equal(r.status, 0, r.stderr);
      const output = JSON.parse(r.stdout);
      if (expected === "error") assert.match(output.error, /invalid image/);
      else if (expected === null) assert.deepEqual(output.items, []);
      else assert.deepEqual(
        Object.fromEntries(Object.entries(output.items[0]).filter(([k]) => k in expected)),
        expected
      );
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
