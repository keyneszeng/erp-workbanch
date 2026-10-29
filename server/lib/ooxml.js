"use strict";
/**
 * 识别 Office Open XML (DOCX/PPTX/XLSX)。
 * 不信扩展名或 HTTP Content-Type：只读取 ZIP central directory 的文件名，
 * 验证必要的 OOXML 清单与文档入口；不解压、不执行宏或嵌入对象。
 * 支持常见无 ZIP64 的 Office 文件。限制条目数与解压总量，拒绝加密包、宏包与损坏的 ZIP。
 */
const MIME = Object.freeze({
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
});

function detectOoxml(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 22 || buf.readUInt32LE(0) !== 0x04034b50) return null;

  // EOCD 可以带最多 65535 字节注释，必须与真正的文件尾对齐。
  const min = Math.max(0, buf.length - 22 - 65535);
  let eocd = -1;
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50 &&
        i + 22 + buf.readUInt16LE(i + 20) === buf.length) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return null;

  const entries = buf.readUInt16LE(eocd + 10);
  const countOnDisk = buf.readUInt16LE(eocd + 8);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdStart = buf.readUInt32LE(eocd + 16);
  if (buf.readUInt16LE(eocd + 4) !== 0 ||
      buf.readUInt16LE(eocd + 6) !== 0 ||
      entries === 0 || entries > 10000 || countOnDisk !== entries ||
      cdStart === 0xffffffff || cdSize === 0xffffffff ||
      cdStart + cdSize !== eocd) return null;

  const names = new Set();
  let pos = cdStart;
  let unpacked = 0;
  for (let n = 0; n < entries; n++) {
    if (pos + 46 > eocd || buf.readUInt32LE(pos) !== 0x02014b50) return null;
    const flags = buf.readUInt16LE(pos + 8);
    const method = buf.readUInt16LE(pos + 10);
    const uncompressed = buf.readUInt32LE(pos + 24);
    const nameLen = buf.readUInt16LE(pos + 28);
    const extraLen = buf.readUInt16LE(pos + 30);
    const commentLen = buf.readUInt16LE(pos + 32);
    const localOffset = buf.readUInt32LE(pos + 42);
    const end = pos + 46 + nameLen + extraLen + commentLen;
    if (end > eocd || nameLen === 0 || (flags & 1) ||
        (method !== 0 && method !== 8) || localOffset + 30 > cdStart ||
        buf.readUInt32LE(localOffset) !== 0x04034b50) return null;

    const name = buf.toString("utf8", pos + 46, pos + 46 + nameLen);
    if (name.includes("\\") || name.startsWith("/") || name.split("/").includes("..") ||
        names.has(name) || /(^|\/)vbaProject\.bin$/i.test(name)) return null;
    names.add(name);
    unpacked += uncompressed;
    if (unpacked > 256 * 1024 * 1024) return null;
    pos = end;
  }
  if (pos !== eocd || !names.has("[Content_Types].xml") || !names.has("_rels/.rels")) return null;
  const docs = [
    ["word/document.xml", MIME.docx],
    ["ppt/presentation.xml", MIME.pptx],
    ["xl/workbook.xml", MIME.xlsx]
  ].filter(([entry]) => names.has(entry));
  // 互相冲突的类型不能靠任意选一个蒙混过关。
  return docs.length === 1 ? docs[0][1] : null;
}

module.exports = { MIME, detectOoxml };
