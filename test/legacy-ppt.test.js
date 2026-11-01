"use strict";
const {test}=require("node:test");
const assert=require("node:assert/strict");
const {sniffMime,ALLOWED_MIME}=require("../server/lib/storage");
test("legacy PowerPoint CFB header is recognized as downloadable PPT, damaged headers rejected",()=>{
 const b=Buffer.alloc(512);
 Buffer.from([0xd0,0xcf,0x11,0xe0,0xa1,0xb1,0x1a,0xe1]).copy(b);
 b.writeUInt16LE(3,26);
 b.writeUInt16LE(0xfffe,28);
 b.writeUInt16LE(9,30);
 assert.equal(sniffMime(b),"application/vnd.ms-powerpoint");
 assert.equal(ALLOWED_MIME["application/vnd.ms-powerpoint"],"ppt");
 b.writeUInt16LE(0,28);
 assert.equal(sniffMime(b),null);
});
