"use strict";

// Vercel functions run on a read-only bundle. The demo SQLite database must
// live under /tmp, which is the only writable serverless filesystem location.
if (process.env.VERCEL && !process.env.ERP_DB) {
  process.env.ERP_DB = "/tmp/association-meeting-erp.db";
}

module.exports = require("../server/index").handler;
