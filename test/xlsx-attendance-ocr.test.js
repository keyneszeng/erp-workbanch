"use strict";
/**
 * Real XLSX OOXML coverage: sharedStrings indices, rich text, inline cells,
 * numeric/formula cells, sheet rows and unused string exclusion.
 */
const {test}=require("node:test");
const assert=require("node:assert/strict");
const PizZip=require("pizzip");
const {extract,XLSX_ENGINE}=require("../server/lib/verify-office-text");
function workbook(shared,workbooks){
 const z=new PizZip();
 z.file("[Content_Types].xml",'<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>');
 z.file("_rels/.rels",'<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>');
 z.file("xl/workbook.xml",'<workbook><sheets><sheet name="签到表" sheetId="1"/></sheets></workbook>');
 z.file("xl/sharedStrings.xml",'<sst>'+shared.join("")+'</sst>');
 for(let i=0;i<workbooks.length;i++)z.file("xl/worksheets/sheet"+(i+1)+".xml",workbooks[i]);
 return z.generate({type:"nodebuffer",compression:"DEFLATE"});
}
test("真实签到Excel：按单元格还原共享字符串、富文本、内联姓名、数字并保持行列",()=>{
 const bin=workbook([
  "<si><t>姓名</t></si>",
  "<si><t>签到时间</t></si>",
  "<si><r><t>张</t></r><r><t>三</t></r></si>",
  "<si><t>未使用的王五</t></si>"
 ],[
  '<worksheet><sheetData>'+
   '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>'+
   '<row r="2"><c r="A2" t="s"><v>2</v></c><c r="B2" t="n"><v>46000</v></c></row>'+
   '<row r="3"><c r="A3" t="inlineStr"><is><t>李四</t></is></c>'+
     '<c r="B3" t="str"><f>CONCAT</f><v>签到通过</v></c></row>'+
   '</sheetData></worksheet>',
  '<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><r><t>赵</t></r><r><t>六</t></r></is></c>'+
  '<c r="B1"><v>2026</v></c></row></sheetData></worksheet>'
 ]);
 const result=extract(bin,"xlsx");
 assert.equal(result.engine,XLSX_ENGINE);
 assert.equal(result.mode,"office-text");
 assert.match(result.text,/姓名\t签到时间\n张三\t46000\n李四\t签到通过/);
 assert.match(result.text,/工作表 2\n赵六\t2026/);
 assert.doesNotMatch(result.text,/未使用的王五/,"未被任何单元格引用的共享字符串不能成为签到证据");
});
test("共享字符串索引必须正确映射，避免全部文字被拉平混入姓名核对",()=>{
 const bin=workbook(["<si><t>张三教授</t></si>","<si><t>李四主任</t></si>"],
 ['<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>1</v></c></row></sheetData></worksheet>']);
 const text=extract(bin,"xlsx").text;
 assert.match(text,/李四主任/);
 assert.doesNotMatch(text,/张三教授/);
});
test("处理 XML 转义、列缺口及公式缓存值，而不读取公式本体",()=>{
 const bin=workbook(["<si><t>张&amp;李</t></si>"],[
  '<worksheet><sheetData><row><c r="B1" t="s"><v>0</v></c>'+
  '<c r="F1"><f>2+3</f><v>5</v></c><c r="H1" t="inlineStr"><is><t>李四</t></is></c>'+
  '</row></sheetData></worksheet>'
 ]);
 const text=extract(bin,"xlsx").text;
 assert.match(text,/张&李\t5\t李四/);
 assert.doesNotMatch(text,/2\+3/);
});
test("共享字符串越界与Excel错误值不产生虚假人员",()=>{
 const bin=workbook(["<si><t>姓名</t></si>"],[
  '<worksheet><sheetData><row><c r="A1" t="s"><v>9999</v></c>'+
  '<c r="B1" t="e"><v>#REF!</v></c>'+
  '<c r="C1" t="inlineStr"><is><t>真实姓名</t></is></c></row></sheetData></worksheet>'
 ]);
 const text=extract(bin,"xlsx").text;
 assert.match(text,/真实姓名/);
 assert.doesNotMatch(text,/#REF!|9999/);
});
