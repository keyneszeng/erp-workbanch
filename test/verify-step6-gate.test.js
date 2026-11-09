"use strict";
/**
 * 第 6 步「会务合同与发票关联核对」的门禁回归。
 *
 * 口径：只要求 会务需求预算 == 已签会务合同总额，并已关联合同/发票原件；
 * **不校验发票金额**。旧实现强制 OCR 唯一识别发票金额并要求三方一致，
 * 项目里有多张发票或扫描件时永远判不了通过。
 * 这条链路在 !isDemoMode() 分支里，必须用生产模式服务器验证。
 */
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { DatabaseSync } = require("node:sqlite");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "erp-step6-"));
const port = 13400 + (process.pid % 500);
const root = "http://127.0.0.1:" + port;
const phone = "13800138000";
const pid = "MP-2026-901";
let proc, db, cookie;

async function request(method, url, data, ck = "") {
  const res = await fetch(root + url, {
    method,
    headers: { "Content-Type": "application/json", ...(ck ? { Cookie: ck } : {}) },
    body: data === undefined ? undefined : JSON.stringify(data)
  });
  return { status: res.status, body: await res.json().catch(() => null), cookie: (res.headers.get("set-cookie") || "").split(";")[0] };
}

before(async () => {
  proc = spawn(process.execPath, ["--experimental-sqlite", "server/index.js"], {
    cwd: path.resolve(__dirname, ".."), stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env, NODE_ENV: "test", ERP_DEMO_MODE: "0", ERP_DB_BACKEND: "",
      ERP_DB: path.join(dir, "test.db"), ERP_PORT: String(port), ERP_HOST: "127.0.0.1",
      ERP_BOOTSTRAP_ADMIN_PHONE: phone, ERP_SMS_PROVIDER: "test", ERP_SMS_TEST_MODE: "1",
      ERP_SESSION_FALLBACK: "0", ERP_UPLOAD_DIR: path.join(dir, "uploads")
    }
  });
  let err = "";
  proc.stderr.on("data", b => { err += String(b); });
  for (let i = 0; i < 600; i++) {
    if (proc.exitCode !== null) throw Error("server failed: " + err);
    try { if ((await request("GET", "/api/health")).status === 200) break; } catch {}
    await new Promise(r => setTimeout(r, 100));
  }

  // 生产模式首次登录必须改密
  let r = await request("POST", "/api/auth/login", { username: phone, password: "123456" });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  await request("POST", "/api/auth/sms/send", {}, r.cookie);
  r = await request("POST", "/api/auth/password", {
    oldPassword: "123456", newPassword: "Step6Strong2026", smsCode: "654321"
  }, r.cookie);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  cookie = r.cookie;

  db = new DatabaseSync(path.join(dir, "test.db"));
  db.exec("PRAGMA busy_timeout=5000");
  const at = "2026-11-08 23:00";
  db.prepare("INSERT INTO projects (id,name,assoc,form,date,days,budget,tax_fee_rate,people,owner,owner_id,phone,dept,agenda,status,status_at,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
    .run(pid, "第6步门禁测试", "消化病分会", "线下", "2026-12-01", 1, 3175, 0, 50,
      "总管理员", 1, phone, "学术部", "09:00 开场", "待核销", at, 1, at, at);
  db.prepare("INSERT INTO demand_sheets (pid,confirmed,confirmed_by,confirmed_at,created_at,updated_at) VALUES (?,?,?,?,?,?)")
    .run(pid, 1, "总管理员", at, at, at);
  db.prepare("INSERT INTO demand_items (pid,grp,item,need,budget,quantity,unit_price,updated_at) VALUES (?,?,?,?,?,?,?,?)")
    .run(pid, "现场执行", "会务服务", "需要", 3175, "1", "3175", at);
  db.prepare("INSERT INTO contracts (id,pid,name,vendor,amount,sign_date,status,category,created_by,created_at,file_key) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
    .run("HT-TEST-1", pid, "会务服务协议", "某会务公司", 3175, "2026-11-01", "已签署", "会务需求", 1, at, "meet.pdf");
  const ins = db.prepare("INSERT INTO materials (pid,kind,name,version,uploader,created_at,file_key,file_name,file_size,file_mime) VALUES (?,?,?,?,?,?,?,?,?,?)");
  ins.run(pid, "合同", "会务服务协议", "v1", "总管理员", at, "meet.pdf", "meet.pdf", 512, "application/pdf");
  ins.run(pid, "会务发票", "会务发票", "v1", "总管理员", at, "inv.pdf", "inv.pdf", 512, "application/pdf");
});
after(() => { if (proc) proc.kill("SIGTERM"); fs.rmSync(dir, { recursive: true, force: true }); });

const REVIEWED = {
  demandReviewed: true, meetingContractReviewed: true, meetingInvoiceReviewed: true
};
const judge = (extra = {}) => request("POST", `/api/projects/${pid}/verify/steps/6`,
  { result: "通过", evidence: REVIEWED, ...extra }, cookie);

test("不提供发票金额也能判定通过（新口径不校验发票金额）", async () => {
  const r = await judge();
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.match(r.body?.message || "", /判定：通过/);
});

test("OCR/人工填了与预算不同的发票金额也不拦截", async () => {
  const r = await judge({ invoiceAmount: 99999 });
  assert.equal(r.status, 200, JSON.stringify(r.body));
});

test("会务需求预算与已签会务合同总额不一致仍然拦截", async () => {
  db.prepare("UPDATE demand_items SET budget=? WHERE pid=?").run(4000, pid);
  const r = await judge();
  assert.equal(r.status, 409, JSON.stringify(r.body));
  assert.equal(r.body?.error?.code, "MEETING_THREE_WAY_MISMATCH");
  db.prepare("UPDATE demand_items SET budget=? WHERE pid=?").run(3175, pid);
});
