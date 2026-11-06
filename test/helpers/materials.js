"use strict";
/** 老回归用无附件的普通材料登记模拟会议材料清单（仅演示数据）。
 * 终版议程如今必须有真实文件；独立上传测试覆盖终版确认，这里不伪造它。
 * 非演示环境仍须至少上传一份真实附件才能推进业务流程。
 */
const { MATERIAL_KINDS } = require("../../server/lib/constants");

/**
 * @param {(method: string, url: string, body?: object) => Promise<{status:number,data:any}>} client
 * @param {string} pid
 */
async function fillMaterials(client, pid) {
  for (const kind of MATERIAL_KINDS.filter(k=>k!=="终版议程")) {
    const r = await client("POST", `/api/projects/${pid}/materials`, { kind, name: `${kind}-测试件.pdf` });
    if (r.status !== 200) {
      throw new Error(`登记材料「${kind}」失败：${r.status} ${JSON.stringify(r.data)}`);
    }
  }
}

module.exports = { fillMaterials };
