"use strict";
/** 供上传回归使用的最小 CFB V3 容器，包含目录扇区、FAT 扇区和文档流标识。
 * 不是可打开的 Excel 文件，仅用于测试文件头及 OLE 目录结构分类。 */
function cfbFixture(streamName) {
  const END=0xfffffffe,FREE=0xffffffff,FATSECT=0xfffffffd;
  const b=Buffer.alloc(1536);
  Buffer.from([0xd0,0xcf,0x11,0xe0,0xa1,0xb1,0x1a,0xe1]).copy(b);
  b.writeUInt16LE(3,26); // CFB 3.0
  b.writeUInt16LE(0xfffe,28);
  b.writeUInt16LE(9,30); // 512-byte sectors
  b.writeUInt16LE(6,32); // 64-byte minisectors
  b.writeUInt32LE(1,44); // FAT sectors
  b.writeUInt32LE(0,48); // directory at sector 0
  b.writeUInt32LE(END,60); // mini FAT EOC
  b.writeUInt32LE(END,68); // DIFAT EOC
  b.writeUInt32LE(0,72);
  b.writeUInt32LE(1,76); // FAT at sector 1
  for(let i=1;i<109;i++)b.writeUInt32LE(FREE,76+i*4);
  function dir(name,index,type,size){
    const off=512+index*128;
    const utf=Buffer.from(name+"\0","utf16le");
    utf.copy(b,off);
    b.writeUInt16LE(utf.length,off+64);
    b[off+66]=type;
    b[off+67]=1; // black
    b.writeUInt32LE(FREE,off+68);
    b.writeUInt32LE(FREE,off+72);
    b.writeUInt32LE(index===0?1:FREE,off+76);
    b.writeUInt32LE(FREE,off+116);
    b.writeUInt32LE(size,off+120);
  }
  dir("Root Entry",0,5,0);
  dir(streamName,1,2,8);
  b.fill(0xff,1024,1536);
  b.writeUInt32LE(END,1024);
  b.writeUInt32LE(FATSECT,1028);
  return b;
}
module.exports={cfbFixture};
