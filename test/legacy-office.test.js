"use strict";
const {test}=require("node:test"),assert=require("node:assert/strict");
const {detectLegacyOffice,MIME}=require("../server/lib/legacy-office");
const {sniffMime,ALLOWED_MIME}=require("../server/lib/storage");
const {cfbFixture}=require("./lib/legacy-office-fixture");
for(const [name,mime,ext] of [
  ["Workbook",MIME.xls,"xls"],["Book",MIME.xls,"xls"],
  ["WordDocument",MIME.doc,"doc"],
  ["PowerPoint Document",MIME.ppt,"ppt"]
]){
  test("CFB directory "+name+" is recognized as "+ext,()=>{
    const bin=cfbFixture(name);
    assert.equal(detectLegacyOffice(bin),mime);
    assert.equal(sniffMime(bin),mime);
    assert.equal(ALLOWED_MIME[mime],ext);
  });
}
test("reject damaged FAT, unknown OLE stream, fake magic, CFB truncated and mismatched header",()=>{
  const x=cfbFixture("Workbook");
  for(const mutate of [
    b=>b.writeUInt16LE(0,28),
    b=>b.writeUInt16LE(12,30),
    b=>b.writeUInt32LE(10,48),
    b=>b.writeUInt32LE(0,1024),
    b=>b.fill(0,512,1024),
    b=>b.writeUInt32LE(0xffffffff,76)
  ]){
    const c=Buffer.from(x);mutate(c);
    assert.equal(detectLegacyOffice(c),null);
    assert.equal(sniffMime(c),null);
  }
  assert.equal(detectLegacyOffice(Buffer.from(x.subarray(0,512))),null);
  assert.equal(detectLegacyOffice(cfbFixture("RandomOLE")),null);
});
test("CSV/TXT are recognized as text, not arbitrary binary or renamed Office",()=>{
  assert.equal(sniffMime(Buffer.from("姓名,费用\n张三,100\n"),"账目.csv"),"text/csv");
  assert.equal(sniffMime(Buffer.from("这是文字档案\n"),"说明.txt"),"text/plain");
  assert.equal(sniffMime(Buffer.from([0x00,0x02,0x03,0x0a]),"bad.csv"),null);
  assert.equal(sniffMime(Buffer.from("<html>hi</html>\n"),"bad.pdf"),null);
  assert.equal(sniffMime(cfbFixture("Workbook"),"fake.csv"),MIME.xls);
});
