"use strict";
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "erp-verification-retraction-"));
const port = 16400 + (process.pid % 400);
const root = "http://127.0.0.1:" + port;
const pid = "MP-2026-008";
let proc, db, adminCookie, ownerCookie;

async function request(cookie, method, url, data) {
  const res = await fetch(root + url, {
    method,
    headers: { ...(cookie ? { Cookie: cookie } : {}), ...(data === undefined ? {} : { "Content-Type": "application/json" }) },
    body: data === undefined ? undefined : JSON.stringify(data)
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}
async function login(username) {
  const res = await fetch(root + "/api/auth/login", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password: "123456" })
  });
  assert.equal(res.status, 200, username + " login");
  return (res.headers.get("set-cookie") || "").split(";")[0];
}

before(async () => {
  proc = spawn(process.execPath, ["--experimental-sqlite", "server/index.js"], {
    cwd: path.resolve(__dirname, ".."),
    env: {
      ...process.env, ERP_DEMO_MODE: "1", ERP_DB: path.join(dir, "erp.db"),
      ERP_PORT: String(port), ERP_HOST: "127.0.0.1", ERP_UPLOAD_DIR: path.join(dir, "uploads")
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let errors = "";
  proc.stderr.on("data", chunk => { errors += String(chunk); });
  let ready = false;
  for (let i = 0; i < 300; i++) {
    if (proc.exitCode !== null) throw Error("server failed: " + errors);
    try { if ((await fetch(root + "/api/health")).ok) { ready = true; break; } } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.ok(ready, "ERP demo server unavailable: " + errors);
  adminCookie = await login("admin");
  ownerCookie = await login("zhoutao");

  db = new DatabaseSync(path.join(dir, "erp.db"));
  db.exec("PRAGMA busy_timeout=5000");
  const owner = db.prepare("SELECT id,name FROM users WHERE username='zhoutao'").get();
  assert.ok(owner, "seeded project owner account exists");
  db.prepare("UPDATE projects SET status='已核销',status_at=?,owner_id=?,owner=? WHERE id=?")
    .run("2026-11-28 16:00", owner.id, owner.name, pid);
  db.prepare("DELETE FROM settlements WHERE pid=?").run(pid);
  const step = db.prepare(
    `INSERT INTO verify_steps(pid,step_no,name,result,remark,evidence_json,checked_by,checked_at)
     VALUES(?,?,?,?,?,?,?,?)
     ON CONFLICT(pid,step_no) DO UPDATE SET result=excluded.result,remark=excluded.remark,
       evidence_json=excluded.evidence_json,checked_by=excluded.checked_by,checked_at=excluded.checked_at`
  );
  for (let no = 1; no <= 7; no++) {
    step.run(pid, no, "测试核验步骤" + no, "通过", "原核验记录", JSON.stringify({ origin: "test-before-retraction", step: no }),
      "原核验人", "2026-11-28 15:00");
  }
  db.prepare("INSERT INTO payments(id,pid,type,payee,amount,status,created_at) VALUES(?,?,?,?,?,?,?)")
    .run("PY-RETRACT-PRESERVE", pid, "协会报销", "撤回测试付款记录", 123.45, "已付款", "2026-11-28 15:00");
});

after(() => {
  if (proc) proc.kill("SIGTERM");
  db?.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("只有总管理员可以撤回已核销；撤回后负责人获得受限项目资料修改权，核验与财务历史保留", async () => {
  const owner = db.prepare("SELECT id FROM users WHERE username='zhoutao'").get();
  assert.equal(db.prepare("SELECT 1 FROM user_permission_grants WHERE user_id=? AND permission='project:edit'").get(owner.id), undefined,
    "测试负责人没有通用 project:edit 权限");

  const before = await request(ownerCookie, "GET", "/api/projects/" + pid);
  assert.equal(before.status, 200);
  assert.equal(before.body.project.status, "已核销");
  assert.equal(before.body.ownerReeditEnabled, false);
  const deniedEdit = await request(ownerCookie, "PATCH", "/api/projects/" + pid, { name: "未经撤回不应修改" });
  assert.equal(deniedEdit.status, 403, JSON.stringify(deniedEdit.body));

  const deniedRetract = await request(ownerCookie, "POST", "/api/projects/" + pid + "/retract-verification", { reason: "项目资料需要修正" });
  assert.equal(deniedRetract.status, 403, JSON.stringify(deniedRetract.body));
  const missingReason = await request(adminCookie, "POST", "/api/projects/" + pid + "/retract-verification", {});
  assert.equal(missingReason.status, 400, JSON.stringify(missingReason.body));

  const paymentBefore = db.prepare("SELECT id,amount,status FROM payments WHERE id='PY-RETRACT-PRESERVE'").get();
  const retracted = await request(adminCookie, "POST", "/api/projects/" + pid + "/retract-verification",
    { reason: "会议议程及会期资料需要由负责人复核修正" });
  assert.equal(retracted.status, 200, JSON.stringify(retracted.body));
  assert.equal(retracted.body.project.status, "待核销");

  const steps = db.prepare("SELECT step_no,result,remark,evidence_json,checked_by,checked_at FROM verify_steps WHERE pid=? ORDER BY step_no").all(pid);
  assert.equal(steps.length, 7);
  for (const row of steps) {
    assert.equal(row.result, "待判定", "旧核验结论必须全部重置");
    assert.equal(row.evidence_json, null, "旧证据已快照保存，不再作为当前有效结论");
    assert.equal(row.checked_by, null);
    assert.equal(row.checked_at, null);
  }
  const revision = db.prepare(
    "SELECT reason,before_json,after_json,changed_by FROM admin_content_revisions WHERE pid=? AND entity_type='verification_retraction' ORDER BY id DESC LIMIT 1"
  ).get(pid);
  assert.match(revision.reason, /会议议程及会期/);
  assert.equal(revision.changed_by, "李静");
  const oldSnapshot = JSON.parse(revision.before_json);
  assert.equal(oldSnapshot.steps.length, 7);
  assert.equal(JSON.parse(oldSnapshot.steps[0].evidence_json).origin, "test-before-retraction");
  assert.equal(JSON.parse(revision.after_json).payment_records_preserved, true);

  const ownerDetail = await request(ownerCookie, "GET", "/api/projects/" + pid);
  assert.equal(ownerDetail.status, 200, JSON.stringify(ownerDetail.body));
  assert.equal(ownerDetail.body.project.status, "待核销");
  assert.equal(ownerDetail.body.ownerReeditEnabled, true);
  assert.ok(Number(ownerDetail.body.project.budget) > 0, "负责人编辑时可读取预算字段");

  const edited = await request(ownerCookie, "PATCH", "/api/projects/" + pid, {
    name: "负责人撤回后修正的会议名称", agenda: "负责人重新确认的会议议程"
  });
  assert.equal(edited.status, 200, JSON.stringify(edited.body));
  assert.equal(edited.body.project.name, "负责人撤回后修正的会议名称");
  assert.equal(edited.body.project.agenda, "负责人重新确认的会议议程");

  const changeAssoc = await request(ownerCookie, "PATCH", "/api/projects/" + pid, { assoc: "华东医学会" });
  assert.equal(changeAssoc.status, 403, JSON.stringify(changeAssoc.body));
  const changeOwner = await request(ownerCookie, "PATCH", "/api/projects/" + pid, { owner_id: 1 });
  assert.equal(changeOwner.status, 403, JSON.stringify(changeOwner.body));

  const paymentAfter = db.prepare("SELECT id,amount,status FROM payments WHERE id='PY-RETRACT-PRESERVE'").get();
  assert.equal(paymentAfter.id, paymentBefore.id);
  assert.equal(paymentAfter.amount, paymentBefore.amount);
  assert.equal(paymentAfter.status, paymentBefore.status);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM settlements WHERE pid=?").get(pid).n, 0);
  assert.ok(db.prepare("SELECT 1 FROM audit_logs WHERE target=? AND action='撤回核销'").get(pid),
    "撤回动作必须写入审计日志");

  const repeat = await request(adminCookie, "POST", "/api/projects/" + pid + "/retract-verification", { reason: "重复撤回" });
  assert.equal(repeat.status, 409, JSON.stringify(repeat.body));
});

test("已结算或已归档项目不能通过撤回核销绕过财务封账和卷宗封存", async () => {
  const settled = await request(adminCookie, "POST", "/api/projects/MP-2026-006/retract-verification", { reason: "测试" });
  assert.equal(settled.status, 409, JSON.stringify(settled.body));
  const archived = await request(adminCookie, "POST", "/api/projects/MP-2026-007/retract-verification", { reason: "测试" });
  assert.equal(archived.status, 409, JSON.stringify(archived.body));
});
