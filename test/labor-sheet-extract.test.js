"use strict";
/** 劳务表收款记录提取：宁缺勿错，缺姓名/账号/金额任一项都不入库。 */
const {test}=require("node:test");
const assert=require("node:assert/strict");
const {extractLaborRecords,mask,clean}=require("../server/lib/labor-sheet-extract");

const A1="6222020200099998888",A2="6217000010001234567";

test("竖线分隔的劳务表逐行提取",()=>{
 const r=extractLaborRecords(
  "姓名|时间|角色|金额|银行账号|开户行\n"+
  "张伟明|2026-11-01|讲者|1000|"+A1+"|中国工商银行广州分行\n"+
  "李建国|2026-11-01|主持|800|"+A2+"|中国建设银行");
 assert.equal(r.records.length,2);
 assert.equal(r.skipped,0);
 assert.deepEqual(r.records[0],{
  name:"张伟明",time:"2026-11-01",role:"讲者",amount:1000,
  bankAccount:A1,bankName:"中国工商银行广州分行"});
 assert.equal(r.records[1].name,"李建国");
 assert.equal(r.records[1].amount,800);
});

test("制表符 + 卡号内空格：账号归一，金额不被误吞",()=>{
 const r=extractLaborRecords(
  "姓名\t时间\t角色\t金额\t银行账号\t开户行\n"+
  "何志威\t2026-11-01\t讲者\t1200\t6222 0202 0009 9998 888\t招商银行\n"+
  "徐一劲\t2026-11-01\t讲者\t900\t6214 8301 2345 6789\t中国银行");
 assert.equal(r.records.length,2);
 assert.equal(r.records[0].bankAccount,A1);
 assert.equal(r.records[0].amount,1200);
 assert.equal(r.records[1].bankAccount,"6214830123456789");
 assert.equal(r.records[1].amount,900);
});

test("扫描件 OCR 逐字空格仍能识别姓名与账号",()=>{
 const r=extractLaborRecords(
  "姓 名  时 间  角 色  金 额  银 行 账 号  开 户 行\n"+
  "张 伟 明  2026-11-01  讲 者  1000  "+A1+"  中 国 工 商 银 行\n"+
  "李 建 国  2026-11-01  主 持  800  "+A2+"  中 国 建 设 银 行");
 assert.deepEqual(r.records.map(x=>x.name),["张伟明","李建国"]);
 assert.equal(r.records[0].bankAccount,A1);
 assert.equal(r.records[0].amount,1000);
});

test("单空格分列的 OCR 行也能提取",()=>{
 const r=extractLaborRecords("张伟明 2026-11-01 讲者 1000 "+A1+" 中国工商银行");
 assert.equal(r.records.length,1);
 assert.equal(r.records[0].bankAccount,A1);
 assert.equal(r.records[0].amount,1000);
});

test("缺金额、缺账号、表头行一律跳过，不产生半条记录",()=>{
 const r=extractLaborRecords(
  "劳务费明细表\n姓名|时间|角色|金额|银行账号|开户行\n"+
  "缺金额|2026-11-01|讲者||"+A1+"|中国工商银行\n"+
  "缺账号|2026-11-01|讲者|800||中国建设银行\n"+
  "合计|||1800||");
 assert.equal(r.records.length,0);
 // 表头定位不到有效记录时会退化到逐行模式；含长账号却缺金额的那行必须被标为待补录。
 assert.ok(r.skipped>=1);
});

test("重复姓名+账号去重",()=>{
 const line="张伟明|2026-11-01|讲者|1000|"+A1+"|中国工商银行";
 const r=extractLaborRecords(line+"\n"+line);
 assert.equal(r.records.length,1);
 assert.equal(r.skipped,1);
});

test("mask 只给尾号四位，clean 不吃掉英文/数字之间的空格",()=>{
 assert.equal(mask(A1),"尾号 " + A1.slice(-4));
 assert.equal(clean("CNY 300000"),"CNY 300000");
 assert.equal(clean("张 伟 明"),"张伟明");
});

test("真实 XLSX 劳务表：按表头定位银行卡号，绝不能误取身份证/手机号，金额取实发数",()=>{
 // 真实模板含 身份证号码(18) / 手机号码(11) / 银行卡号(19) / 应税金额 / 个税 / 实发数
 const text=[
  "工作表 1",
  "广州市先进医疗健康慈善基金会  内痔规范诊疗交流会  劳务费发放汇总表",
  "填表时间： 2026 年 10 月 14 日",
  "序号\t姓名\t身份证号码\t手机号码\t银行卡号\t开户行名称 （XX银行全称XX省XX市XX支行）\t应税金额\t个税\t实发数\t增值税+附加税\t增值税\t附加税\t备注",
  "1\t刘志华\t440101199001011234\t13800138000\t6222020200099998888\t中国工商银行广州员村支行\t2300\t300\t2000\t24.24\t22.00\t1.24\t",
  "2\t卢效荣\t44010119900202235X\t13900139000\t6217000010001234567\t中国建设银行东莞茶山支行\t1675\t175\t1500\t17.00\t16.00\t0.50\t",
  "合计\t\t\t\t\t\t3975\t475\t3500\t\t\t\t"
 ].join("\n");
 const r=extractLaborRecords(text);
 assert.equal(r.mode,"header");
 assert.equal(r.records.length,2);
 assert.equal(r.records[0].name,"刘志华");
 assert.equal(r.records[0].bankAccount,A1,"必须取银行卡号列，不是身份证/手机号");
 assert.equal(r.records[0].amount,2000,"必须取实发数，不是应税金额");
 assert.equal(r.records[0].bankName,"中国工商银行广州员村支行");
 assert.equal(r.records[1].bankAccount,A2);
 assert.equal(r.records[1].amount,1500);
});
