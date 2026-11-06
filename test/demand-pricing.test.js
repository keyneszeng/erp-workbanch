"use strict";
/** 数量×单价自动汇算、默认不需要、跨页金额口径与历史兼容测试。 */
const {test,before,after}=require("node:test");
const assert=require("node:assert/strict");
const path=require("node:path"),fs=require("node:fs");
const {spawn}=require("node:child_process");
const PORT=8973,BASE="http://127.0.0.1:"+PORT;
const DB=path.join(__dirname,"..","data","demand-pricing-test.db");
const PID="MP-2026-002";
let server,admin,finance;
async function healthy(){
  for(let i=0;i<180;i++){
    try{if((await fetch(BASE+"/api/health")).ok)return}catch{}
    await new Promise(r=>setTimeout(r,150));
  }
  throw Error("ERP not ready");
}
async function login(name){
  const r=await fetch(BASE+"/api/auth/login",{method:"POST",
    headers:{"content-type":"application/json"},body:JSON.stringify({username:name,password:"123456"})});
  assert.equal(r.status,200,name+" login");
  return r.headers.get("set-cookie").split(";")[0];
}
function client(cookie){
  return async(method,url,body)=>{
    const r=await fetch(BASE+url,{
      method,headers:{"content-type":"application/json",cookie},
      body:body===undefined?undefined:JSON.stringify(body)
    });
    const raw=await r.text();
    let data;try{data=JSON.parse(raw)}catch{data=raw}
    return {status:r.status,data};
  };
}
before(async()=>{
  for(const suffix of ["","-wal","-shm"])fs.rmSync(DB+suffix,{force:true});
  server=spawn(process.execPath,["--experimental-sqlite","server/index.js"],{
    cwd:path.join(__dirname,".."),env:{...process.env,ERP_DB:DB,ERP_PORT:String(PORT)},
    stdio:["ignore","pipe","pipe"]
  });
  server.stderr.on("data",b=>{const s=String(b);if(!s.includes("ExperimentalWarning"))process.stderr.write(s)});
  await healthy();
  admin=client(await login("admin"));finance=client(await login("finance"));
});
after(()=>server?.kill("SIGTERM"));

test("新需求表四组共23项默认全部不需要，数量与单价及总价均为空",async()=>{
  const r=await admin("GET","/api/demand/"+PID);
  assert.equal(r.status,200);
  assert.equal(r.data.isTemplate,true);
  const items=Object.values(r.data.items).flat();
  assert.equal(items.length,23);
  assert.ok(items.every(i=>i.need==="不需要"));
  assert.ok(items.every(i=>i.quantity===""&&i.unit_price===""&&i.budget===""));
  assert.equal(r.data.needCount,0);
  assert.equal(r.data.budgetTotal,0);
});

test("后端按数量×单价计算总价，拒绝客户端伪造金额，合计仅统计需要项",async()=>{
  const items=[
    {grp:"设计",item:"主背景板",note:"需核对设计稿",need:"需要",spec:"三米宽",owner:"外部负责人甲",due:"2026-12-10",quantity:"3",unit_price:"12.50",budget:"999999"},
    {grp:"制作",item:"小数数量",need:"需要",spec:"克重",owner:"负责人乙",due:"2026-12-11",quantity:"1.25",unit_price:"0.10",budget:"1000"},
    {grp:"其他",item:"不需要但保留询价",need:"不需要",quantity:"999",unit_price:"9",budget:"0"}
  ];
  const r=await admin("PATCH","/api/demand/"+PID,{items});
  assert.equal(r.status,200,JSON.stringify(r.data));
  assert.equal(r.data.sheet.budgetTotal,37.63);
  assert.equal(r.data.sheet.needCount,2);
  const a=r.data.sheet.items["设计"][0],b=r.data.sheet.items["制作"][0],c=r.data.sheet.items["其他"][0];
  assert.equal(a.quantity,"3");
  assert.equal(a.unit_price,"12.50");
  assert.equal(a.budget,"37.50");
  assert.equal(b.budget,"0.13","采用分精度四舍五入 1.25×0.10=0.125 → 0.13");
  assert.equal(c.budget,"8991.00");
  const list=await admin("GET","/api/demand");
  assert.equal(list.data.projects.find(p=>p.id===PID).budgetTotal,37.63);
  const detail=await admin("GET","/api/projects/"+PID);
  assert.equal(detail.data.demand.budgetTotal,37.63);
  assert.deepEqual(detail.data.demand.items.map(x=>x.quantity),["3","1.25"]);
  assert.equal(detail.data.demand.items.length,2,"项目详情的清单只包含标记为需要的条目");
  assert.equal(detail.data.demand.needCount,2);
  assert.equal(detail.data.demand.total,3,"原始需求条目总数不受隐藏规则影响");
  assert.ok(!detail.data.demand.items.some(x=>x.item==="不需要但保留询价"),"不需要项不应出现在详情清单");
  assert.deepEqual(
    ["grp","item","note","spec","quantity","unit_price","budget","owner","due"].map(k=>detail.data.demand.items[0][k]),
    ["设计","主背景板","需核对设计稿","三米宽","3","12.50","37.50","外部负责人甲","2026-12-10"],
    "项目详情应包含全部需要项字段");
  const verify=await admin("GET","/api/projects/"+PID+"/verify");
  assert.equal(verify.status,200);
  assert.deepEqual(verify.data.demand.items,detail.data.demand.items,"核销与项目清单必须共用同一明细数据");
  const original=await admin("GET","/api/demand/"+PID);
  assert.ok(original.data.items["其他"].some(x=>x.item==="不需要但保留询价"),
    "隐藏只是项目详情的展示规则，不能删除原始需求单条目");
  assert.equal((await finance("PATCH","/api/demand/"+PID,{items})).status,403);
});

test("非法数量、单价精度及超额总价全部被拒，不能破坏已保存单据",async()=>{
  for(const item of [
    {quantity:"-1",unit_price:"2"},
    {quantity:"1.00001",unit_price:"2"},
    {quantity:"1000001",unit_price:"2"},
    {quantity:"2",unit_price:"1.234"},
    {quantity:"1000000",unit_price:"1000000"},
    {quantity:"1e2",unit_price:"2"}
  ]){
    const r=await admin("PATCH","/api/demand/"+PID,{items:[
      {grp:"设计",item:"错误数值",need:"需要",...item}
    ]});
    assert.equal(r.status,400,JSON.stringify(item)+" should be rejected: "+JSON.stringify(r.data));
  }
  const current=await admin("GET","/api/demand/"+PID);
  assert.equal(current.data.budgetTotal,37.63);
});

test("需求负责人可自定义填写：不在协会用户目录的姓名也能保存并回显",async()=>{
  const name="外部会务协调员-张三";
  const saved=await admin("PATCH","/api/demand/"+PID,{items:[
    {grp:"设计",item:"临时布置",need:"需要",owner:name,spec:"签到处",due:"2026-12-12",quantity:"2",unit_price:"12.30"}
  ]});
  assert.equal(saved.status,200,JSON.stringify(saved.data));
  const row=saved.data.sheet.items["设计"][0];
  assert.equal(row.owner,name);
  assert.equal(row.owner_id,"");
  assert.equal(row.budget,"24.60");
  const read=await admin("GET","/api/demand/"+PID);
  assert.equal(read.data.items["设计"][0].owner,name);
});

test("原有成员绑定不被自由输入误清除，改为自定义姓名时解绑而不授予账号权限",async()=>{
  const list=await admin("GET","/api/users/assignable?assoc="+encodeURIComponent("护理协会"));
  assert.equal(list.status,200);
  const member=list.data.rows.find(x=>x.name==="周涛");
  assert.ok(member,"测试数据应有护理协会会务执行负责人");
  const item={grp:"设计",item:"本会人员接洽",need:"需要",quantity:"1",unit_price:"12"};
  const linked=await admin("PATCH","/api/demand/"+PID,{items:[{...item,owner_id:member.id}]});
  assert.equal(linked.status,200,JSON.stringify(linked.data));
  assert.equal(Number(linked.data.sheet.items["设计"][0].owner_id),Number(member.id));
  const unchanged=await admin("PATCH","/api/demand/"+PID,{items:[{...item,owner:member.name}]});
  assert.equal(unchanged.status,200);
  assert.equal(Number(unchanged.data.sheet.items["设计"][0].owner_id),Number(member.id));
  const custom=await admin("PATCH","/api/demand/"+PID,{items:[{...item,owner:"外部顾问"}]});
  assert.equal(custom.status,200);
  assert.equal(custom.data.sheet.items["设计"][0].owner,"外部顾问");
  assert.equal(custom.data.sheet.items["设计"][0].owner_id,"");
});

test("字段错误返回精确定位信息：负责人、数量、日期、重复行",async()=>{
  const cases=[
    [{grp:"设计",item:"长度超限",need:"需要",owner:"张".repeat(21)},"owner"],
    [{grp:"设计",item:"数量错误",need:"需要",quantity:"1.12345",unit_price:"8"},"quantity"],
    [{grp:"设计",item:"单价错误",need:"需要",quantity:"2",unit_price:"5.999"},"unit_price"],
    [{grp:"设计",item:"日期错误",need:"需要",due:"2026-02-30"},"due"],
    [{grp:"设计",item:"缺单价",need:"需要",quantity:"2",unit_price:""},"unit_price"]
  ];
  for(const [item,field] of cases) {
    const r=await admin("PATCH","/api/demand/"+PID,{items:[item]});
    assert.equal(r.status,400,JSON.stringify({item,error:r.data}));
    assert.equal(r.data.error.detail?.field,field,JSON.stringify(r.data));
    assert.equal(r.data.error.detail?.index,0);
    assert.equal(r.data.error.detail?.item,item.item);
  }
  const duplicate=await admin("PATCH","/api/demand/"+PID,{items:[
    {grp:"设计",item:"同名条目",need:"不需要"},
    {grp:"设计",item:"同名条目 ",need:"不需要"}
  ]});
  assert.equal(duplicate.status,400);
  assert.equal(duplicate.data.error.detail?.field,"item");
  assert.equal(duplicate.data.error.detail?.index,1);
});

test("空数量/单价无法伪造总价；仍兼容无定价字段的历史数据",async()=>{
  const legacy=await admin("PATCH","/api/demand/"+PID,{items:[
    {grp:"设计",item:"旧需求",need:"需要",budget:"88.50"}
  ]});
  assert.equal(legacy.status,200);
  assert.equal(legacy.data.sheet.items["设计"][0].budget,"88.50");
  const keep=await admin("PATCH","/api/demand/"+PID,{items:[
    {grp:"设计",item:"旧需求",need:"需要",quantity:"",unit_price:"",budget:"88.50"},
    {grp:"设计",item:"新增项目",need:"需要",quantity:"",unit_price:"",budget:"800"}
  ]});
  assert.equal(keep.status,200,JSON.stringify(keep.data));
  const detail=keep.data.sheet;
  assert.equal(detail.items["设计"][0].budget,"88.50","只保留未变更的历史录入金额");
  assert.equal(detail.items["设计"][1].budget,"","新版输入不能写假总价");
  const repriced=await admin("PATCH","/api/demand/"+PID,{items:[
    {grp:"设计",item:"旧需求",need:"需要",quantity:"3",unit_price:"10.10",budget:"88.50"}
  ]});
  assert.equal(repriced.status,200);
  assert.equal(repriced.data.sheet.items["设计"][0].budget,"30.30");
});

test("CSV 含数量、单价、总价及需要项合计",async()=>{
  const r=await fetch(BASE+"/api/demand/"+PID+"/export",{
    headers:{cookie:await login("admin")}
  });
  assert.equal(r.status,200);
  const bytes=Buffer.from(await r.arrayBuffer()),csv=bytes.toString("utf8");
  assert.deepEqual([...bytes.subarray(0,3)],[0xef,0xbb,0xbf]);
  assert.match(csv,/"数量","单价","总价"/);
  assert.match(csv,/30\.30/);
  assert.match(csv,/需要项总价合计/);
});

test("重置恢复默认全不需要；零需求也可明确确认归档",async()=>{
  const reset=await admin("POST","/api/demand/"+PID+"/reset",{});
  assert.equal(reset.status,200);
  assert.equal(reset.data.sheet.isTemplate,true);
  assert.ok(Object.values(reset.data.sheet.items).flat().every(i=>i.need==="不需要"));
  const confirm=await admin("POST","/api/demand/"+PID+"/confirm",{});
  assert.equal(confirm.status,200,JSON.stringify(confirm.data));
  assert.equal(confirm.data.sheet.needCount,0);
  assert.equal(confirm.data.sheet.budgetTotal,0);
  assert.equal(confirm.data.sheet.archived,true);
});
