"use strict";
/**
 * 归档材料柔性流程回归。直接在独立数据库上检验生产模式的材料门禁：
 * 无原件阻止进入核销；任意类别含一个文件即放行；不需要旧八类齐全。
 * HTTP 上传的字节与权限完整性由 test/office-material.test.js 等独立回归验证。
 */
const {test}=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs"),os=require("node:os"),path=require("node:path");

const dir=fs.mkdtempSync(path.join(os.tmpdir(),"erp-flexible-material-"));
process.env.ERP_DB=path.join(dir,"flexible.db");
process.env.ERP_DEMO_MODE="0";
const {db,migrate}=require("../server/lib/db");
const {materialsStatus,GUARDS}=require("../server/lib/workflow");
const {MATERIAL_KINDS}=require("../server/lib/constants");
migrate();
const pid="MP-TEST-FLEXIBLE-MATERIALS";
db.prepare("INSERT INTO projects(id,name,assoc,form,date,created_at,updated_at,status) VALUES(?,?,?,?,?,?,?,?)")
  .run(pid,"自由材料测试会议","华东医学会","线下","2027-12-12","2026-11-06","2026-11-06","执行中");
const project={id:pid,status:"执行中"};

test("生产模式：归档材料无需八类固定清单，权益照片为可选类别",()=>{
  assert.ok(MATERIAL_KINDS.includes("权益照片"));
  const st=materialsStatus(pid);
  assert.deepEqual(st.required,[]);
  assert.deepEqual(st.have,[]);
  assert.deepEqual(st.missing,["至少上传1份材料附件"]);
  assert.equal(st.uploadedCount,0);
  assert.equal(st.ok,false);
  assert.match(GUARDS.request_verify(project),/至少.*一份/);
  assert.match(GUARDS.archive(project),/至少保留一份/);
});

test("只登记文字、不上传文件，无法推进（不是随意填名称就通过）",()=>{
  db.prepare("INSERT INTO materials(pid,kind,name,created_at) VALUES (?,?,?,?)")
    .run(pid,"会务说明","只有材料登记文字","2026-11-06");
  const st=materialsStatus(pid);
  assert.equal(st.count,1);
  assert.equal(st.uploadedCount,0);
  assert.equal(st.ok,false);
  assert.match(GUARDS.request_verify(project),/上传至少一份/);
});

test("上传任意一种权益照片附件即可进入下一阶段，原先其余类别全部缺席也不会挡",()=>{
  db.prepare("INSERT INTO materials(pid,kind,name,created_at,file_key,file_name,file_mime) VALUES (?,?,?,?,?,?,?)")
    .run(pid,"权益照片","权益交付记录","2026-11-06",
      "11111111111111111111111111111111.jpg","权益照片.jpg","image/jpeg");
  const st=materialsStatus(pid);
  assert.equal(st.count,2);
  assert.equal(st.uploadedCount,1);
  assert.equal(st.ok,true);
  assert.deepEqual(st.required,[]);
  assert.deepEqual(st.missing,[]);
  assert.ok(st.have.includes("权益照片"));
  assert.equal(GUARDS.request_verify(project),null);
  assert.match(GUARDS.verify_pass(project),/项必核步骤未判定/,"无劳务表和会务需求时仅四项必核");
  assert.match(GUARDS.archive(project),/结算单未生成/,"仍必须完成结算");
});

test("唯一一份上传原件被删除时，继续推进再次被拦；再传任意自定义类即可恢复",()=>{
  db.prepare("UPDATE materials SET deleted_at=? WHERE pid=? AND kind='权益照片'")
    .run("2026-11-06",pid);
  assert.equal(materialsStatus(pid).uploadedCount,0);
  assert.equal(materialsStatus(pid).ok,false);
  assert.match(GUARDS.verify_pass(project),/至少保留一份/);
  db.prepare("INSERT INTO materials(pid,kind,name,created_at,file_key) VALUES (?,?,?,?,?)")
    .run(pid,"自选会场资料","任意自定义文件","2026-11-06",
      "22222222222222222222222222222222.pdf");
  assert.equal(materialsStatus(pid).uploadedCount,1);
  assert.equal(materialsStatus(pid).ok,true);
  assert.equal(GUARDS.request_verify(project),null);
});

test("第5项随劳务表真实附件出现和移除，换表后旧证据失效",()=>{
  const {verification}=require("../server/lib/workflow");
  const {laborSheetInfo}=require("../server/lib/labor-sop");
  assert.equal(verification(pid).total,4);
  assert.equal(verification(pid).steps[5].result,"不适用");
  assert.equal(verification(pid).steps[4].result,"不适用");
  db.prepare("INSERT INTO materials(pid,kind,name,created_at) VALUES (?,?,?,?)")
    .run(pid,"劳务表","未上传仅登记","2026-11-06");
  assert.equal(verification(pid).total,4);
  db.prepare("INSERT INTO materials(pid,kind,name,file_key,created_at) VALUES (?,?,?,?,?)")
    .run(pid,"劳务表","新劳务表","labor-proof-v1.pdf","2026-11-06");
  assert.equal(verification(pid).total,4);
  assert.equal(verification(pid).steps[4].result,"待判定");
  db.prepare("INSERT INTO verify_steps(pid,step_no,name,result,evidence_json) VALUES (?,?,?,?,?)")
    .run(pid,5,"劳务表五字段核验","通过",JSON.stringify({laborSourceSignature:laborSheetInfo(db,pid).signature}));
  assert.equal(verification(pid).steps[4].result,"通过");
  db.prepare("INSERT INTO materials(pid,kind,name,file_key,created_at) VALUES (?,?,?,?,?)")
    .run(pid,"劳务表","替换的新劳务表","labor-proof-v2.pdf","2026-11-06");
  assert.equal(verification(pid).steps[4].result,"待判定","换表后旧通过结果必须失效");
  db.prepare("UPDATE materials SET deleted_at=? WHERE pid=? AND kind='劳务表' AND file_key IS NOT NULL")
    .run("2026-11-06",pid);
  assert.equal(verification(pid).total,5);
  assert.equal(verification(pid).steps[4].result,"不适用");
});
test("自定义材料分类没有数量上限，仍保留归档后冻结及财务审批等独立门禁",()=>{
  const st=materialsStatus(pid);
  assert.ok(st.have.includes("自选会场资料"));
  assert.deepEqual(st.required,[]);
  const reason=GUARDS.archive(project);
  assert.match(reason,/结算单未生成/);
  fs.rmSync(dir,{recursive:true,force:true});
});
