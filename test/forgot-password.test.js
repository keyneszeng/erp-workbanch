"use strict";
/** Forgot-password: production SMS recovery without an existing login session. */
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "erp-forgot-password-"));
const PORT = 10900 + (process.pid % 500);
const BASE = "http://127.0.0.1:" + PORT;
const ROOT = "13800138000";
const STAFF = "13900139000";
let child;
async function req(method, endpoint, data, cookie="") {
  const r = await fetch(BASE + endpoint, {
    method, headers: { "Content-Type": "application/json", ...(cookie?{Cookie:cookie}:{}) },
    body: data === undefined ? undefined : JSON.stringify(data)
  });
  return { status:r.status, data:await r.json(), cookie:(r.headers.get("set-cookie")||"").split(";")[0] };
}
const send = (phone)=>req("POST","/api/auth/password/reset/request",{phone});
const confirm = (phone, smsCode, newPassword, confirmPassword)=>req("POST","/api/auth/password/reset/confirm",
  {phone,smsCode,newPassword,confirmPassword});
const login = (phone,password)=>req("POST","/api/auth/login",{username:phone,password});
before(async()=>{
  child = spawn(process.execPath, ["--experimental-sqlite","server/index.js"], {
    cwd:path.resolve(__dirname,".."),stdio:["ignore","pipe","pipe"],
    env:{ ...process.env, NODE_ENV:"test", ERP_DEMO_MODE:"0", ERP_DB_BACKEND:"",
      ERP_DB:path.join(dir,"auth.db"),ERP_PORT:String(PORT),ERP_HOST:"127.0.0.1",
      ERP_BOOTSTRAP_ADMIN_PHONE:ROOT, ERP_SMS_PROVIDER:"test",ERP_SMS_TEST_MODE:"1",
      ERP_SESSION_FALLBACK:"0" }
  });
  let errors="";
  child.stderr.on("data",d=>{errors+=String(d)});
  for(let i=0;i<180;i++){
    if(child.exitCode!==null)throw Error("Test server exited: "+errors);
    try{if((await req("GET","/api/health")).status===200)return;}catch{}
    await new Promise(resolve=>setTimeout(resolve,85));
  }
  throw Error("Test server did not start: "+errors);
});
after(()=>{if(child)child.kill("SIGTERM");fs.rmSync(dir,{recursive:true,force:true});});

test("未登录状态：忘记密码接口开放；手机号枚举保护、验证码不外泄、强度校验",async()=>{
  const previous=await login(ROOT,"123456");
  assert.equal(previous.status,200,JSON.stringify(previous.data));
  const oldCookie=previous.cookie;
  const unknown=await send("13700137000");
  assert.equal(unknown.status,200,JSON.stringify(unknown.data));
  const known=await send(ROOT);
  assert.equal(known.status,200,JSON.stringify(known.data));
  assert.deepEqual(known.data,unknown.data,"白名单与非白名单返回内容须相同");
  assert.ok(!JSON.stringify(known.data).includes("654321"),"HTTP 不可回显验证码");
  assert.equal((await send("foo")).status,400,"手机号格式错误必须拒绝");
  assert.equal((await send(ROOT)).status,200,"短信发送冷却也不允许透露是否在白名单");
  const wrong=await confirm(ROOT,"111111","AnotherStrong8765","AnotherStrong8765");
  assert.equal(wrong.status,400);
  assert.equal(wrong.data.error.code,"RESET_CODE_INVALID");
  const ghost=await confirm("13700137000","111111","AnotherStrong8765","AnotherStrong8765");
  assert.equal(ghost.status,400);
  assert.equal(ghost.data.error.code,wrong.data.error.code,"验证码失败不得泄露账号存在性");
  assert.equal(ghost.data.error.message,wrong.data.error.message);
  const weak=await confirm(ROOT,"654321","abc123","abc123");
  assert.equal(weak.status,400,"弱密码不得通过");
  const mismatch=await confirm(ROOT,"654321","NewStrong2026","OtherStrong2026");
  assert.equal(mismatch.status,400,"两次密码不一致不得通过");
  const recovered=await confirm(ROOT,"654321","NewStrong2026","NewStrong2026");
  assert.equal(recovered.status,200,JSON.stringify(recovered.data));
  assert.ok(recovered.cookie.startsWith("erp_sid="),"短信+新密码通过后自动登录");
  assert.ok(!JSON.stringify(recovered.data).includes("654321"));
  assert.equal((await req("GET","/api/dashboard",undefined,oldCookie)).status,401,"旧会话立即失效");
  assert.equal((await req("GET","/api/auth/me",undefined,recovered.cookie)).data.user.mustChangePassword,false);
  assert.equal((await login(ROOT,"123456")).status,401,"旧密码不可登录");
  assert.equal((await login(ROOT,"NewStrong2026")).status,200,"重置的新密码可登录");
  const replay=await confirm(ROOT,"654321","FreshStrong2027","FreshStrong2027");
  assert.equal(replay.status,400,"验证码不可重复消费");

  const created=await req("POST","/api/users",{phone:STAFF,name:"新员工",role:"user"},recovered.cookie);
  assert.equal(created.status,200,JSON.stringify(created.data));
  const staffLogin=await login(STAFF,"123456");
  assert.equal(staffLogin.status,200);
  assert.equal(staffLogin.data.user.mustChangePassword,true);
  const sentStaff=await send(STAFF);
  assert.equal(sentStaff.status,200);
  const same=await confirm(STAFF,"654321","123456","123456");
  assert.equal(same.status,400,"不可使用旧的初始弱口令");
  const staffReset=await confirm(STAFF,"654321","StaffNew2026","StaffNew2026");
  assert.equal(staffReset.status,200,JSON.stringify(staffReset.data));
  assert.equal((await req("GET","/api/dashboard",undefined,staffLogin.cookie)).status,401);
  assert.equal((await req("GET","/api/auth/me",undefined,staffReset.cookie)).data.user.mustChangePassword,false);
  const disabled=await req("PATCH","/api/users/"+created.data.user.id,{active:0},recovered.cookie);
  assert.equal(disabled.status,200,JSON.stringify(disabled.data));
  const absent=await send(STAFF);
  assert.deepEqual(absent.data,known.data,"停用账号与在册账号必须返回同样发送说明");
  assert.equal((await confirm(STAFF,"654321","MoreStrong2026","MoreStrong2026")).data.error.code,"RESET_CODE_INVALID");

  const LOCKED = "13600136001";
  const lockUser = await req("POST","/api/users",{phone:LOCKED,name:"安全测试账号",role:"user"},recovered.cookie);
  assert.equal(lockUser.status,200,JSON.stringify(lockUser.data));
  assert.equal((await send(LOCKED)).status,200);
  for (let i=0;i<5;i++) {
    const badCode=await confirm(LOCKED,"000000","LockedNew2026","LockedNew2026");
    assert.equal(badCode.status,400,"错误验证码第 "+(i+1)+" 次");
  }
  const refused=await confirm(LOCKED,"654321","LockedNew2026","LockedNew2026");
  assert.equal(refused.status,400,"五次失败后正确验证码也必须被锁定（错误次数不能被事务回滚）");
  assert.equal(refused.data.error.code,"RESET_CODE_INVALID");
});

test("公开请求频控：无效号码同样计数，持久化 IP/手机号上限",async()=>{
  // Restrict to a separate unknown phone to avoid affecting previous test's accounts.
  const p="13600136000";
  for(let i=0;i<12;i++){
    const x=await send(p);
    assert.equal(x.status,200,"request "+i+": "+JSON.stringify(x.data));
  }
  const limited=await send(p);
  assert.equal(limited.status,429,"per-phone hourly rate enforced even for unknown accounts");
  assert.equal(limited.data.error.code,"RESET_RATE_LIMIT");
});

test("验证码不能直接换取会话：必须同时提交合规新密码",async()=>{
  assert.equal((await req("GET","/api/auth/password/reset/request")).status,405);
  assert.equal((await req("POST","/api/auth/password/reset/confirm",{phone:ROOT,smsCode:"654321"})).status,400);
});
