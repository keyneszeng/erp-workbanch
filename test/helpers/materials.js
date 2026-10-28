"use strict";
/**
 * 材料 8 类齐备 —— V1.2.19 起是**核销的前置门**。
 *
 * 老板 2026-10-28：「必须完成 材料 8 项录入，才能开启 核销功能」。
 * 于是所有「造一个项目走到待核销」的测试用例，都必须先补齐这 8 类材料，
 * 否则会在提交核销那一步被 409 MATERIAL_GATE 拦住。
 *
 * 放在这里而不是每个文件抄一遍：8 类清单只有 constants 一份，
 * 抄散了以后新增类别一定会漏改某几个文件。
 */
const { MATERIAL_KINDS } = require("../../server/lib/constants");

/**
 * @param {(method: string, url: string, body?: object) => Promise<{status:number,data:any}>} client
 * @param {string} pid
 */
async function fillMaterials(client, pid) {
  for (const kind of MATERIAL_KINDS) {
    const r = await client("POST", `/api/projects/${pid}/materials`, { kind, name: `${kind}-测试件.pdf` });
    if (r.status !== 200) {
      throw new Error(`登记材料「${kind}」失败：${r.status} ${JSON.stringify(r.data)}`);
    }
  }
}

module.exports = { fillMaterials };
