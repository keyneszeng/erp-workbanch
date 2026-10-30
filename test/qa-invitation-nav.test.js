"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const { canVisitNav } = require("../server/lib/rbac");
const make = (role, assoc = "") => ({ role, assoc, id: role });
test("invitation navigation uses action permission, not generic prep module", () => {
  for (const role of ["admin", "assoc", "exec"]) {
    assert.equal(canVisitNav(make(role, "华东医学会"), "prep-invitations"), true, role);
  }
  for (const role of ["finance", "user"]) {
    assert.equal(canVisitNav(make(role), "prep-invitations"), false, role);
  }
});
test("finance keeps contract access but not invitation access", () => {
  assert.equal(canVisitNav(make("finance"), "contracts"), true);
  assert.equal(canVisitNav(make("finance"), "prep-invitations"), false);
});
test("browser navigation guard mirrors server invitation action permission", () => {
  const source = readFileSync(join(__dirname, "../web/assets/js/lib/nav.js"), "utf8");
  assert.match(source, /k: "prep-invitations"[^\n]*can\("invite:manage"\)/);
  assert.doesNotMatch(source, /k: "prep-invitations"[^\n]*modules\.includes\("prep"\)/);
});
