"use strict";
/** XLSX 原表格结构解析：行列、合并单元格、列宽，供前端原样渲染。 */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const PizZip = require("pizzip");
const { parseXlsxTable } = require("../server/lib/xlsx-render");

function makeXlsx({ sheetXml, shared = "", workbook = "", rels = "" }) {
  const z = new PizZip();
  z.file("[Content_Types].xml", '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/></Types>');
  z.file("_rels/.rels", '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>');
  z.file("xl/workbook.xml", workbook || '<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="签到表" sheetId="1" r:id="rId1"/></sheets></workbook>');
  z.file("xl/_rels/workbook.xml.rels", rels || '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>');
  if (shared) z.file("xl/sharedStrings.xml", shared);
  z.file("xl/worksheets/sheet1.xml", sheetXml);
  return z.generate({ type: "nodebuffer" });
}

test("xlsx 解析保留行列、共享字符串、合并单元格与列宽", () => {
  const buf = makeXlsx({
    shared: '<?xml version="1.0"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><si><t>姓名</t></si><si><t>单位</t></si><si><t>张三</t></si></sst>',
    sheetXml: '<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
      '<cols><col min="1" max="1" width="18" customWidth="1"/><col min="2" max="2" width="30" customWidth="1"/></cols>' +
      '<sheetData>' +
      '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>' +
      '<row r="2"><c r="A2" t="s"><v>2</v></c><c r="B2" t="inlineStr"><is><t>测试协会</t></is></c><c r="C2"><v>1200.5</v></c></row>' +
      '<row r="3"><c r="A3" t="s"><v>2</v></c></row>' +
      '</sheetData>' +
      '<mergeCells count="1"><mergeCell ref="A1:B1"/></mergeCells>' +
      '</worksheet>'
  });
  const out = parseXlsxTable(buf);
  assert.equal(out.sheets.length, 1);
  const s = out.sheets[0];
  assert.equal(s.name, "签到表");
  assert.equal(s.rows, 3);
  assert.equal(s.colsCount, 3);
  assert.deepEqual(s.merges, [{ r: 1, c: 1, rs: 1, cs: 2 }]);
  assert.equal(s.widths.find(w => w.col === 1).width, 126);
  const cell = (r, c) => s.cells.find(x => x.r === r && x.c === c);
  assert.equal(cell(1, 1).v, "姓名");
  assert.equal(cell(2, 1).v, "张三");
  assert.equal(cell(2, 2).v, "测试协会");
  assert.equal(cell(2, 3).v, "1200.5");
  assert.equal(cell(2, 3).t, "n");
});

test("非 xlsx / 损坏文件被拒绝", () => {
  assert.throws(() => parseXlsxTable(Buffer.from("not a zip")), /不是有效的 XLSX/);
  assert.throws(() => parseXlsxTable(null), /不是有效的 XLSX/);
});

test("缩放打印注入：只加 fitToPage/fitToWidth，不改单元格内容", () => {
  const { applyFitToWidth } = require("../server/lib/file-preview");
  const xml = '<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
    '<sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>原始内容</t></is></c></row></sheetData></worksheet>';
  const out = applyFitToWidth(xml);
  assert.match(out, /<sheetPr><pageSetUpPr fitToPage="1"\/><\/sheetPr>/);
  assert.match(out, /<pageSetup fitToWidth="1" fitToHeight="0" orientation="landscape"\/>/);
  assert.match(out, /<pageMargins left="0.25"/);
  // 单元格内容原样保留
  assert.match(out, /<c r="A1" t="inlineStr"><is><t>原始内容<\/t><\/is><\/c>/);
  // schema 顺序：pageMargins 必须在 pageSetup 之前
  assert.ok(out.indexOf("<pageMargins") < out.indexOf("<pageSetup"));
});
