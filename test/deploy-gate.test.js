"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const checker = path.join(__dirname, "..", "scripts", "check-production-deploy.cjs");

function run(config, { domain = "erp-prod.example.org", health = "https://erp-prod.example.org/api/health" } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "erp-deploy-check-"));
  try {
    const file = path.join(dir, "wrangler.jsonc");
    fs.writeFileSync(file, config, "utf8");
    return spawnSync(process.execPath, [checker], {
      env: { ...process.env, ERP_WRANGLER_CONFIG: file,
        ERP_PRODUCTION_DOMAIN: domain, ERP_HEALTHCHECK_URL: health },
      encoding: "utf8", timeout: 15000
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const candidate = {
  name: "erp-business-production",
  routes: [{ pattern: "erp-prod.example.org", custom_domain: true }],
  durable_objects: { bindings: [{ name: "ERP_DB", class_name: "ErpDatabase" }] },
  r2_buckets: [{ binding: "ERP_FILES", bucket_name: "erp-prod-attachments" }],
  assets: { run_worker_first: ["/api/*"] }
};

test("prod release gate accepts only isolated persistent resource config", () => {
  const r = run(JSON.stringify(candidate));
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /生产部署预检通过/);
});

test("prod release gate refuses historic demo Worker or domain", () => {
  const r = run(JSON.stringify({ ...candidate, name: "erp-workbanch" }));
  assert.notEqual(r.status, 0);
  const s = run(JSON.stringify(candidate), {
    domain: "erp.aibuild.work",
    health: "https://erp.aibuild.work/api/health"
  });
  assert.notEqual(s.status, 0);
});

test("prod release gate rejects missing R2 and incorrect health target", () => {
  const { r2_buckets, ...noR2 } = candidate;
  const r = run(JSON.stringify(noR2));
  assert.notEqual(r.status, 0);
  const s = run(JSON.stringify(candidate), { health: "https://other.example.org/api/health" });
  assert.notEqual(s.status, 0);
});

test("prod release gate handles JSONC comments without corrupting HTTPS URLs", () => {
  const text = JSON.stringify({ ...candidate, $schema: "https://example.org/schema.json" }, null, 2)
    .replace(/\n\}/, '\n  // allowed deployment config\n}');
  const r = run(text);
  assert.equal(r.status, 0, r.stderr);
});
