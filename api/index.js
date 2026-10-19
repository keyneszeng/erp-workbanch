"use strict";

// Vercel functions run on a read-only bundle. The demo SQLite database must
// live under /tmp, which is the only writable serverless filesystem location.
if (process.env.VERCEL && !process.env.ERP_DB) {
  process.env.ERP_DB = "/tmp/association-meeting-erp.db";
}

// Serverless 每个实例的 /tmp 独立，会话表无法跨实例共享。
// 开启签名令牌兜底，避免请求落到新实例后全体 401。
if (process.env.VERCEL) {
  process.env.ERP_SESSION_FALLBACK = "1";
}

module.exports = require("../server/index").handler;
