"use strict";
const test=require("node:test"),assert=require("node:assert/strict");
const fs=require("node:fs"),path=require("node:path");
const get=p=>fs.readFileSync(path.join(__dirname,"..",p),"utf8");
const has=(p,s)=>assert.ok(get(p).includes(s),p+" missing: "+s);
const no=(p,s)=>assert.ok(!get(p).includes(s),p+" still has obsolete: "+s);

test("流程页、登录页和路由不再把核销表述为六步或归档八类",()=>{
  for(const p of ["web/assets/js/pages/flow.js","web/assets/js/pages/login.js","web/assets/js/app.js"]){
    no(p,"6 步核销");no(p,"核销 6 步");no(p,"材料 8/8");
  }
  has("server/lib/rbac.js","七项核销");
});
test("核销 CSV 有七项结果，不让例外单错位",()=>{
  has("server/api/system.js","step_no=7) AS s7");
  has("server/api/system.js",'r.s7 || "待判定/不适用"');
});
test("两个付款入口都支持分期期次，付款执行统一走原件核对",()=>{
  for(const p of ["web/assets/js/pages/project.js","web/assets/js/pages/finance.js"]){
    has(p,'k: "period", l: "期次');
    // PR #78 后：只有「已审批」且具付款权限才出现付款按钮；
    // 账户不在列表里单独登记，改为执行付款时补录。
    has(p,'y.status === "已审批" && can("payment:pay")');
    no(p,'data-acct');
    no(p,'data-pay-acct');
  }
  has("server/api/system.js",'r.period || ""');
  has("web/assets/js/lib/payment-execution.js",'name="payee_account"');
  has("web/assets/js/lib/payment-execution.js",'data-verified');
});
test("小程序赞助权益照片上传必须选择合同权益二级类目",()=>{
  const p="miniprogram/pages/materials/index.js";
  has(p,"async loadRights(pid)");
  has(p,"sponsor_right_id:Number(this.data.rightId)");
  has(p,"指定会议不可访问");
  has("miniprogram/pages/materials/index.wxml",'bindchange="pickRight"');
});
test("小程序身份响应使用实际账号模块授权",()=>{
  const s="server/api/mini.js";
  has(s,"function sessionRole(user)");
  has(s,"MODULES.filter(m=>hasModule(user,m.k))");
  has(s,"role: sessionRole(ctx.user)");
  has("miniprogram/pages/home/index.js",'ps.includes("mini:apply")');
});
test("小程序审批按类型校验权限且要求驳回原因",()=>{
  const p="miniprogram/pages/approvals/index.js";
  for(const s of ["canDecide(type)","合同审批","editable:!approve","if(!approve&&!comment)"])has(p,s);
});
test("被授权模块可按原始数据范围查看必要的会议上下文",()=>{
  has("server/lib/rbac.js","function canReadProjects(user)");
  has("server/api/projects.js","canReadProjects(ctx.user)");
  has("server/lib/rbac.js","function scopeFilter(user)");
  has("web/assets/js/lib/nav.js",'nav==="projects"');
});
test("无财务授权的档案页不请求结算接口也不展示其金额",()=>{
  const p="web/assets/js/pages/archive.js";
  has(p,'financeRead?api.get("/api/settlements")');
  has(p,'...(financeRead ? [');
});
test("搜索框防丢焦点及旧请求覆盖新结果",()=>{
  has("web/assets/js/lib/ui.js","function bindSearchRefresh");
  for(const n of ["archive","contracts","audit"]){
    has("web/assets/js/pages/"+n+".js","bindSearchRefresh");
    has("web/assets/js/pages/"+n+".js","renderSeq");
  }
  has("web/assets/js/pages/projects.js","requestNo!==listSeq");
});
test("财务 KPI 不随状态页签筛选清零且导出账户按权限脱敏",()=>{
  has("web/assets/js/pages/finance.js","const totalsQs = new URLSearchParams");
  has("web/assets/js/pages/finance.js","(allPay || pay).summary");
  has("server/api/system.js",'can(user,"payment:pay")');
  has("server/api/system.js","def.map(row, ctx.user)");
});
test("核销第6项及合同待办审批权限口径统一",()=>{
  has("web/assets/js/pages/demand.js","核销第6项");
  has("web/assets/js/pages/project.js","例外单审批通过不等于核销通过");
  has("server/api/system.js",'a.type === "合同审批" ? can(user, "contract:approve")');
});

test("生成结算单不再要求收款方/开户行/银行账号",()=>{
  // 结算弹窗只发 action，不再带收款信息；也不再有补录账户弹窗
  has("web/assets/js/pages/project.js",'{ action: "settle" }');
  no("web/assets/js/pages/project.js",'action: "settle", ...v');
  no("web/assets/js/pages/project.js","openPayAccount");
  no("web/assets/js/pages/project.js","settle.payee");
  // 结算列表不再有收款方/账户列
  no("web/assets/js/pages/finance.js","收款方 / 收款账户");
  // 后端结算不再校验银行字段
  const flow=get("server/lib/workflow.js");
  const settle=flow.slice(flow.indexOf('case "settle"'),flow.indexOf('case "archive"'));
  assert.ok(!/parseBank/.test(settle),"结算不应再解析银行字段");
  assert.ok(/payee,payee_bank,payee_account,status/.test(settle),"插入语句保留列名但写 NULL");
});
