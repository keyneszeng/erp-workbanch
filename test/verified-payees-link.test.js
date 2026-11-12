"use strict";
/**
 * 劳务专家合同 ↔ 核销劳务账号的自动关联。
 * 场景：财务在付款申请里选「张伟明（劳务专家合同）」，也应当带出
 * 第5步核销劳务表里的开户行与加密账号，而不是让财务再手输一遍。
 * 重名（同名多条不同账号）不得自动关联，避免打错款。
 */
const {test,before,after}=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs"),os=require("node:os"),path=require("node:path");

const dir=fs.mkdtempSync(path.join(os.tmpdir(),"erp-payee-link-"));
const pid="MP-2026-903";
const A1="6222020200099998888",A2="6217000010001234567";
let db,vp,laborSheetInfo,contractPool;

before(()=>{
 process.env.ERP_DEMO_MODE="0";
 process.env.ERP_DB=path.join(dir,"t.db");
 process.env.ERP_FINANCIAL_DATA_KEY="a".repeat(64);
 db=require("../server/lib/db").db;
 require("../server/lib/db").migrate();
 vp=require("../server/lib/verified-payees");
 laborSheetInfo=require("../server/lib/labor-sop").laborSheetInfo;
 contractPool=require("../server/lib/labor-contracts").contractPool;
 const at="2026-11-09 10:00";
 db.prepare("INSERT INTO users (id,username,name,role,phone,pass_salt,pass_hash,created_at) VALUES (?,?,?,?,?,?,?,?)")
  .run(1,"13800138000","总管理员","admin","13800138000","s","h",at);
 db.prepare("INSERT INTO projects (id,name,assoc,form,date,days,budget,tax_fee_rate,people,owner,owner_id,phone,dept,agenda,status,status_at,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
  .run(pid,"收款方关联测试","消化病分会","线下","2026-12-01",1,5000,0,10,"总管理员",1,"13800138000","学术部","",  "已核销",at,1,at,at);
 db.prepare("INSERT INTO materials (pid,kind,name,version,uploader,created_at,file_key,file_name,file_size,file_mime) VALUES (?,?,?,?,?,?,?,?,?,?)")
  .run(pid,"劳务表","劳务表","v1","总管理员",at,"labor.txt","劳务表.txt",512,"text/plain");
 const ins=db.prepare("INSERT INTO contracts (id,pid,name,vendor,amount,sign_date,status,category,created_by,created_at,file_key) VALUES (?,?,?,?,?,?,?,?,?,?,?)");
 ins.run("HT-LABOR-1",pid,"张伟明专家劳务合同","张伟明",1000,"2026-11-01","已签署","劳务专家",1,at,"lc1.pdf");
 ins.run("HT-LABOR-2",pid,"王重复专家劳务合同","王重复",800,"2026-11-01","已签署","劳务专家",1,at,"lc2.pdf");
 ins.run("HT-COMPANY",pid,"会务服务合同","某会务公司",3000,"2026-11-01","已签署","会务需求",1,at,"cc.pdf");
 vp.saveLabor(pid,[
  {name:"张伟明",time:"2026-11-01",role:"讲者",amount:1000,bankAccount:A1,bankName:"中国工商银行广州分行"},
  {name:"王重复",time:"2026-11-01",role:"讲者",amount:800,bankAccount:A1,bankName:"中国银行"},
  {name:"王重复",time:"2026-11-01",role:"讲者",amount:800,bankAccount:A2,bankName:"建设银行"},
  {name:"李建国",time:"2026-11-01",role:"主持",amount:900,bankAccount:A2,bankName:"中国建设银行"}
 ]);
 // 第5步证据签名必须与当前劳务表/合同池一致，options 才会暴露劳务来源。
 db.prepare("INSERT OR REPLACE INTO verify_steps (pid,step_no,name,result,remark,invoice_amount,checked_by,checked_at,evidence_json) VALUES (?,?,?,?,?,?,?,?,?)")
  .run(pid,5,"劳务表五字段核验","通过","",null,"总管理员",at,
   JSON.stringify({laborSourceSignature:laborSheetInfo(db,pid).signature,
    contractPoolSignature:contractPool(db,pid).signature}));
});
after(()=>{try{db?.close();}catch{} fs.rmSync(dir,{recursive:true,force:true});});

test("劳务专家合同自动带出同名劳务账号，且不重复列出",()=>{
 const rows=vp.options(pid);
 const zhang=rows.filter(x=>x.payee==="张伟明");
 assert.equal(zhang.length,1,"合同与劳务不应出现两条同名选项");
 assert.equal(zhang[0].id,"contract:HT-LABOR-1");
 assert.equal(zhang[0].source,"labor");
 assert.equal(zhang[0].linkedContract,true);
 assert.equal(zhang[0].bank,"中国工商银行广州分行");
 assert.equal(zhang[0].maskedAccount,"尾号 "+A1.slice(-4));
 assert.ok(!JSON.stringify(rows).includes(A1),"下拉不得含完整账号");
});

test("重名不自动关联，劳务行各自独立列出",()=>{
 const rows=vp.options(pid);
 const wang=rows.filter(x=>x.payee==="王重复");
 assert.equal(wang.length,3,"1 条合同 + 2 条同名劳务，不自动合并");
 const contract=wang.find(x=>x.id==="contract:HT-LABOR-2");
 assert.equal(contract.source,"contract");
 assert.equal(contract.bank,"");
 assert.equal(wang.filter(x=>x.source==="labor").length,2);
});

test("普通会务合同不关联劳务账号",()=>{
 const rows=vp.options(pid);
 const c=rows.find(x=>x.id==="contract:HT-COMPANY");
 assert.equal(c.source,"contract");
 assert.equal(c.maskedAccount,"");
});

test("resolve 劳务专家合同返回解密后的完整账号，普通合同仍为空",()=>{
 const labor=vp.resolve(pid,"contract:HT-LABOR-1");
 assert.equal(labor.name,"张伟明");
 assert.equal(labor.bank,"中国工商银行广州分行");
 assert.equal(labor.account,A1);
 assert.equal(labor.source,"labor");
 const company=vp.resolve(pid,"contract:HT-COMPANY");
 assert.equal(company.account,"");
 assert.equal(company.source,"contract");
});
