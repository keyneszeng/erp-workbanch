"use strict";

// Cloudflare Durable Object binds env explicitly; Node uses process.env by default.
let config = {
  demo: process.env.ERP_DEMO_MODE === "1",
  bootstrapPassword: process.env.ERP_BOOTSTRAP_ADMIN_PASSWORD || ""
};
function configureRuntime(env = {}) {
  config = {
    demo: String(env.ERP_DEMO_MODE || "") === "1",
    bootstrapPassword: String(env.ERP_BOOTSTRAP_ADMIN_PASSWORD || "")
  };
}
function isDemoMode() { return config.demo; }
function bootstrapAdminPassword() { return config.bootstrapPassword; }
module.exports = { configureRuntime, isDemoMode, bootstrapAdminPassword };
