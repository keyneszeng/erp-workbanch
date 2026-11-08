"use strict";
/**
 * 识别 Office 97–2003 CFB/OLE 容器中的真实文档类型，不通过扩展名猜测。
 *
 * XLS: "Workbook"/"Book"; DOC: "WordDocument"; PPT: "PowerPoint Document"。
 * 只读 header/FAT/Directory，不解压、不执行宏或嵌入对象；保存后只允许下载。
 * 这些旧格式可能含宏，所以切勿在服务器侧执行或自动转换。
 */
const MAGIC=Buffer.from([0xd0,0xcf,0x11,0xe0,0xa1,0xb1,0x1a,0xe1]);
const END=0xfffffffe,FREE=0xffffffff;
const MIME=Object.freeze({
  xls:"application/vnd.ms-excel",
  doc:"application/msword",
  ppt:"application/vnd.ms-powerpoint"
});

function detectLegacyOffice(buf) {
  if(!Buffer.isBuffer(buf) || buf.length<1024 ||
     !buf.subarray(0,8).equals(MAGIC) || buf.readUInt16LE(28)!==0xfffe) return null;
  const major=buf.readUInt16LE(26),shift=buf.readUInt16LE(30);
  if(!((major===3&&shift===9)||(major===4&&shift===12)) ||
    buf.readUInt16LE(32)!==6) return null;
  const sectorSize=2**shift;
  const sectors=Math.floor((buf.length-512)/sectorSize);
  if(sectors<2 || buf.length!==512+sectors*sectorSize)return null;
  const fatCount=buf.readUInt32LE(44),dirStart=buf.readUInt32LE(48);
  const difatStart=buf.readUInt32LE(68),difatCount=buf.readUInt32LE(72);
  if(fatCount<1||fatCount>sectors||difatCount>sectors||dirStart>=sectors)return null;
  const offset=id=>512+id*sectorSize;
  const fatSectors=[],sectorSeen=new Set();
  const append=id=>{
    if(id===FREE)return true;
    if(id>=sectors||sectorSeen.has(id))return false;
    sectorSeen.add(id);fatSectors.push(id);
    return fatSectors.length<=fatCount;
  };
  // Header inline DIFAT (109 FAT sector IDs), plus linked DIFAT sectors when needed.
  for(let i=0;i<109;i++)if(!append(buf.readUInt32LE(76+i*4)))return null;
  let difat=difatStart;
  for(let i=0;i<difatCount;i++){
    if(difat>=sectors||sectorSeen.has(difat))return null;
    sectorSeen.add(difat);
    const at=offset(difat);
    for(let j=0;j<sectorSize/4-1;j++)
      if(!append(buf.readUInt32LE(at+j*4)))return null;
    difat=buf.readUInt32LE(at+sectorSize-4);
  }
  if((difatCount===0 && difatStart!==END) ||
      (difatCount>0 && difat!==END) || fatSectors.length!==fatCount)return null;
  const fat=[];
  for(const id of fatSectors){
    const at=offset(id);
    for(let j=0;j<sectorSize;j+=4)fat.push(buf.readUInt32LE(at+j));
  }
  const seen=new Set(),streamNames=new Set();
  let current=dirStart,root=false,steps=0;
  while(current!==END){
    if(current>=sectors||seen.has(current)||++steps>Math.min(sectors,4096))return null;
    seen.add(current);
    const at=offset(current);
    for(let j=0;j<sectorSize;j+=128){
      const pos=at+j;
      const nameLen=buf.readUInt16LE(pos+64),type=buf[pos+66];
      if(type===0)continue;
      if(![1,2,5].includes(type)||nameLen<2||nameLen>64||nameLen%2!==0)return null;
      const name=buf.toString("utf16le",pos,pos+nameLen-2).toLowerCase();
      if(type===5&&name==="root entry")root=true;
      if(type===2&&buf.readUInt32LE(pos+120)>0)streamNames.add(name);
    }
    current=fat[current];
    if(current===undefined)return null;
  }
  if(!root)return null;
  const types=[
    (streamNames.has("workbook")||streamNames.has("book"))&&MIME.xls,
    streamNames.has("worddocument")&&MIME.doc,
    streamNames.has("powerpoint document")&&MIME.ppt
  ].filter(Boolean);
  return types.length===1?types[0]:null;
}

module.exports={MIME,detectLegacyOffice};
