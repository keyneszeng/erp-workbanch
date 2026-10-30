"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const source = fs.readFileSync(path.join(__dirname, "../miniprogram/app.js"), "utf8");

function client(apiBase, responder) {
  let app;
  const storage = new Map();
  const wx = {
    getStorageSync: k => storage.get(k),
    setStorageSync: (k, v) => storage.set(k, v),
    removeStorageSync: k => storage.delete(k),
    request: opts => responder(opts),
    login: opts => opts.success({ code: "test_code" })
  };
  const ctx = { App: x => { app = x; }, require: x => {
    assert.equal(x, "./config");
    return { apiBase };
  }, wx, Promise, Error };
  vm.runInNewContext(source, ctx, { filename: "miniprogram/app.js" });
  app.onLaunch();
  return { app, wx, storage };
}
test("mini production client refuses demo and placeholder origins", async () => {
  for (const url of ["https://erp.aibuild.work/api", "https://production.example.com/api", "http://prod.example.org/api"]) {
    let calls = 0;
    const { app } = client(url, () => { calls++; });
    await assert.rejects(app.api("/projects"), /阿里云 HTTPS 正式 API 域名/);
    assert.equal(calls, 0, "unsafe requests must not be issued");
  }
});
test("mini public invitations never include employee Bearer token", async () => {
  const headers = [];
  const { app } = client("https://erp-prod.example.org/api", opts => {
    headers.push({ path: opts.url, auth: opts.header.Authorization });
    opts.success({ statusCode: 200, data: { ok: true } });
  });
  app.setSession({ accessToken: "secret-token", user: { id: 7 }, perms: [] });
  await app.api("/public/prep-invitation?token=example");
  await app.api("/projects");
  assert.equal(headers[0].auth, undefined);
  assert.equal(headers[1].auth, "Bearer secret-token");
});
test("mini revoked session is cleared on 401, not on other errors", async () => {
  let status = 403;
  const { app, storage } = client("https://erp-prod.example.org/api", opts =>
    opts.success({ statusCode: status, data: { error: { message: "Denied" } } }));
  app.setSession({ accessToken: "secret-token", user: { id: 7 }, perms: [] });
  await assert.rejects(app.api("/projects"), /Denied/);
  assert.equal(app.globalData.token, "secret-token");
  status = 401;
  await assert.rejects(app.api("/projects"), /Denied/);
  assert.equal(app.globalData.token, "");
  assert.equal(storage.has("erp_mini_token"), false);
});
