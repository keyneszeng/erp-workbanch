"use strict";
const {test}=require("node:test");
const assert=require("node:assert/strict");
const {sniffMime,ALLOWED_MIME}=require("../server/lib/storage");
const {cfbFixture}=require("./lib/legacy-office-fixture");
test("旧版 PPT 使用真实 OLE Directory PowerPoint Document 识别，损坏或伪造头拒绝",()=>{
 const ppt=cfbFixture("PowerPoint Document");
 assert.equal(sniffMime(ppt),"application/vnd.ms-powerpoint");
 assert.equal(ALLOWED_MIME["application/vnd.ms-powerpoint"],"ppt");
 const bad=Buffer.from(ppt);bad.writeUInt16LE(0,28);
 assert.equal(sniffMime(bad),null);
 const headerOnly=Buffer.from(ppt);headerOnly.fill(0,512,1024);
 assert.equal(sniffMime(headerOnly),null);
});
