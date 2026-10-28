"use strict";
/**
 * 数据范围「本人负责」改为按 user_id 认人（V1.2.6）
 * 运行：node --test test/scope-owner.test.js
 *
 * 原来 exec / finance 的数据范围是 `p.owner = ?`，拿**姓名**比对，两个后果：
 *
 *   1) 重名即越权：管理员新建一个叫「张伟」的账号（不同 username），
 *      它没有任何项目成员关系，却能立刻看到张伟名下的全部项目。
 *   2) 改名即失联：负责人改名后，只靠「负责人」这一条关系可见的项目
 *      会从他的列表里消失 —— 项目还在，但负责人自己再也看不见。
 *
 * 改法：projects 加 owner_id，创建 / 修改负责人时解析成用户 id，
 * 数据范围优先比 id，只有老数据 owner_id 为空时才退回姓名比对。
 */
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const PORT = 8819;
const BASE = `http://127.0.0.1:${PORT}`;
const DB = path.join(__dirname, "..", "data", "test19.db");
const UP = path.join(__dirname, "..", "data", "test19-uploads");
let proc;
let admin, exec;

function clean() {
  for (const f of [DB, DB + "-wal", DB + "-shm"]) if (fs.existsSync(f)) fs.renameSync(f, f + ".old");
  if (fs.existsSync(UP)) fs.rmSync(UP, { recursive: true, force: true });
}
async function waitHealth(t = 40000) {
  const t0 = Date.now();
  while (Date.now() - t0 < t) {
    try { const r = await fetch(`${BASE}/api/health`); if (r.ok) return; } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("测试服务启动超时");
}
async function login(u, p = "123456") {
  const r = await fetch(`${BASE}/api/auth/login`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: u, password: p })
  });
  assert.equal(r.status, 200, `${u} 登录失败`);
  return r.headers.get("set-cookie").split(";")[0];
}
function client(cookie) {
  return async (method, url, body) => {
    const r = await fetch(BASE + url, {
      method, headers: { "Content-Type": "application/json", cookie },
      body: body ? JSON.stringify(body) : undefined
    });
    const text = await r.text();
    let data; try { data = JSON.parse(text); } catch { data = text; }
    return { status: r.status, data, code: data?.error?.code, msg: data?.error?.message || data?.message || "" };
  };
}
const idsOf = (r) => (r.data.rows || r.data).map((x) => x.id);

before(async () => {
  clean();
  proc = spawn(process.execPath, ["--experimental-sqlite", "server/index.js"], {
    cwd: path.join(__dirname, ".."),
    env: { ...process.env, ERP_PORT: String(PORT), ERP_DB: DB, ERP_UPLOAD_DIR: UP },
    stdio: ["ignore", "pipe", "pipe"]
  });
  proc.stdout.on("data", () => {});
  proc.stderr.on("data", () => {});
  await waitHealth();
  admin = client(await login("admin"));
  exec = client(await login("exec")); // 张伟
});

after(() => {
  proc?.kill();
  clean();
});

test("新建同名账号看不到同名负责人名下的项目", async () => {
  const before = idsOf(await exec("GET", "/api/projects"));
  assert.ok(before.length > 0, "前置条件：张伟名下应能看到项目");

  const mk = await admin("POST", "/api/users", {
    username: "zhangwei2", name: "张伟", role: "exec",
    assoc: "华东医学会", dept: "会务部", phone: "13900000009", password: "Init1234"
  });
  assert.equal(mk.status, 200, mk.msg);

  const twin = client(await login("zhangwei2", "Init1234"));
  const seen = idsOf(await twin("GET", "/api/projects"));
  assert.deepEqual(seen, [], `同名账号凭姓名看到了 ${seen.join(", ")}`);

  // 直接点名访问也必须被拒
  const one = await twin("GET", `/api/projects/${before[0]}`);
  assert.equal(one.status, 403, `${one.status} ${one.msg}`);
});

test("重名时新建项目的负责人绑定到操作者本人", async () => {
  // 系统里现在有两个「张伟」：exec（id 3）与 zhangwei2（id 9）
  const mk = await exec("POST", "/api/projects", {
    name: "张伟自己建的会", assoc: "华东医学会", form: "线下", date: "2027-03-03",
    budget: 1000, owner: "张伟", agenda: "探测", people: 10
  });
  assert.equal(mk.status, 200, mk.msg);
  const pid = mk.data.project.id;

  const twin = client(await login("zhangwei2", "Init1234"));
  assert.equal((await twin("GET", `/api/projects/${pid}`)).status, 403,
    "同名账号不应因为项目负责人同名而看到项目");
});

test("负责人填了系统里不存在的名字也不报错，创建人仍可见", async () => {
  const mk = await admin("POST", "/api/projects", {
    name: "负责人待定", assoc: "华东医学会", form: "线下", date: "2027-04-04",
    budget: 1000, owner: "待定", agenda: "探测", people: 10
  });
  assert.equal(mk.status, 200, mk.msg);
  const pid = mk.data.project.id;
  const d = (await admin("GET", `/api/projects/${pid}`)).data;
  assert.equal(d.project.owner, "待定");
  assert.equal(d.project.owner_id, null, "查不到人时 owner_id 应为空，退回姓名比对");
});

test("改负责人会同步改 owner_id：原负责人失去可见、新负责人获得可见", async () => {
  const mk = await admin("POST", "/api/projects", {
    name: "换负责人", assoc: "华东医学会", form: "线下", date: "2027-05-05",
    budget: 1000, owner: "张伟", agenda: "探测", people: 10
  });
  const pid = mk.data.project.id;
  assert.ok(idsOf(await exec("GET", "/api/projects")).includes(pid), "改之前张伟应可见");

  const patch = await admin("PATCH", `/api/projects/${pid}`, { owner: "陈静" });
  assert.equal(patch.status, 200, patch.msg);

  const finance = client(await login("finance")); // 陈静
  assert.ok(idsOf(await finance("GET", "/api/projects")).includes(pid), "新负责人应可见");
  assert.ok(!idsOf(await exec("GET", "/api/projects")).includes(pid), "原负责人不应再可见");
});

test("负责人改名后，仅靠负责人关系可见的项目仍在视野里", async () => {
  // 造一个「只靠负责人可见」的项目：owner=张伟，创建人是 admin，张伟不是成员
  const mk = await admin("POST", "/api/projects", {
    name: "只靠负责人可见", assoc: "华东医学会", form: "线下", date: "2027-02-02",
    budget: 1000, owner: "张伟", agenda: "探测", people: 10
  });
  assert.equal(mk.status, 200, mk.msg);
  const pid = mk.data.project.id;

  assert.ok(idsOf(await exec("GET", "/api/projects")).includes(pid), "改名前后应可见");

  const users = (await admin("GET", "/api/users")).data.rows;
  const zw = users.find((u) => u.username === "exec");
  const ren = await admin("PATCH", `/api/users/${zw.id}`, { name: "张伟（华东）" });
  assert.equal(ren.status, 200, ren.msg);

  const after = client(await login("exec"));
  assert.ok(idsOf(await after("GET", "/api/projects")).includes(pid),
    "负责人改名后，靠 owner_id 关联的项目不应从视野消失");
  assert.equal((await after("GET", `/api/projects/${pid}`)).status, 200);
});
