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
test("财务直接付款单页与历史审批付款共存，必须勾选并上传付款凭证",()=>{
  const project="web/assets/js/pages/project.js",finance="web/assets/js/pages/finance.js";
  has(project,"y.period"); // 旧付款期次只读展示；新付款从财务单页直接登记
  has(finance,'期次（分期付款填）');
  for(const p of [project,finance]){
    has(p,'y.status==="已审批"&&can("payment:pay")');
    has(p,'凭证详情');
    no(p,'data-acct');
    no(p,'data-pay-acct');
  }
  has(finance,'paymentOnePageTable');
  has(finance,'data-direct-paid');
  has(finance,'data-direct-voucher');
  has(finance,'/api/payments/direct');
  has("server/api/system.js",'r.period || ""');
  has("web/assets/js/lib/payment-execution.js",'name="payee_account"');
  has("web/assets/js/lib/payment-execution.js",'data-verified');
  has("web/assets/js/lib/payment-execution.js",'data-payment-voucher');
});
test("小程序赞助权益照片上传必须选择合同权益二级类目",()=>{
  const p="miniprogram/pages/materials/index.js";
  has(p,"async loadRights(pid)");
  has(p,"sponsor_right_id:Number(batch.rightId)");
  has(p,"this.data.sponsorRights.some(x=>x.id===this.data.rightId)");
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
  has("server/lib/workflow.js","不接受缺少证据的旧结论或以例外审批代替核销");
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

test("数字卷宗导出按钮与真实CSV输出一致，不把核销明细误写成完整卷宗",()=>{
  const p="web/assets/js/pages/archive.js";
  has(p,"导出核销明细 CSV");
  has(p,'api.download("/api/export/verify")');
  no(p,"导出核销卷宗");
});

test("财务和项目详情不再提供付款申请入口，保留财务直接付款与历史付款记录",()=>{
 for(const path of ["web/assets/js/pages/finance.js","web/assets/js/pages/project.js"]){
  no(path,'id="newPay"');
  no(path,'id="addPay"');
  no(path,"async function openPay(");
  has(path,"已付款");
 }
 has("web/assets/js/pages/finance.js","data-direct-submit");
 has("web/assets/js/pages/project.js","直接登记与上传凭证");
 has("web/assets/js/pages/flow.js","财务直接付款");
});
test("三类合同统一合同上传，材料收集和微信小程序禁止重新登记劳务协议",()=>{
 const constants=require("../server/lib/constants");
 for(const name of ["劳务协议","会务协议","企业赞助合同"]){
  assert.ok(!constants.MATERIAL_KINDS.includes(name),name+" 不可作为普通材料类别");
  assert.ok(constants.RETIRED_MATERIAL_KINDS.includes(name),name+" 写入必须拒绝");
 }
 for(const path of ["web/assets/js/pages/project.js","web/assets/js/pages/contracts.js"]){
  for(const [value,label] of [["会务需求","会务协议"],["劳务专家","劳务协议"],["企业赞助","企业赞助合同"]])
   has(path,'{v:"'+value+'",l:"'+label+'"}');
 }
 for(const path of ["web/assets/js/pages/materials.js","miniprogram/pages/materials/index.js"])
  has(path,"劳务协议");
 has("server/api/verify.js","RETIRED_MATERIAL_KINDS.includes(kind)");
});
test("数字卷宗PDF强制在所有原件之前生成项目台账结算与分类付款对照",()=>{
 has("server/api/archive-pdf.js","const ledgerDetail=buildDetail(project.id,ctx.user)");
 has("server/lib/material-export-pdf.js","ledgerPages(ledgerDetail)");
 has("server/lib/material-export-pdf.js","分类付款对照");
 has("web/assets/js/lib/archive-pdf.js","第2页为项目台账结算单");
});
