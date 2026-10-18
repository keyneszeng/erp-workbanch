"use strict";
const { migrate, DB_FILE } = require("../lib/db");
const { seed } = require("../lib/seed");

migrate();
const reset = process.argv.includes("--reset");
const r = seed({ reset });
console.log(reset ? `已重置并重建种子数据：${DB_FILE}` : `种子数据：${r.skipped ? "已存在，跳过" : "已初始化"}`);
console.log(r);
