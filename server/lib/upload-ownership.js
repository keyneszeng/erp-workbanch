"use strict";
const { db } = require("./db");
const { bad, forbidden, conflict } = require("./util");
const { isSuper } = require("./rbac");

/**
 * An uploaded file is an untrusted pending object until a material or contract
 * record refers to it. An opaque random key is not an authorization token.
 */
function assertUploadAttachable(key, projectId, user) {
  const file = db.prepare(
    "SELECT file_key, user_id, pid FROM uploaded_files WHERE file_key = ?"
  ).get(key);
  if (!file) throw bad("附件未通过本系统上传，或文件记录不存在");
  if (!isSuper(user) && Number(file.user_id) !== Number(user.id)) {
    throw forbidden("只能挂接本人上传的附件");
  }
  if (file.pid && file.pid !== projectId) {
    throw forbidden("附件所属项目与当前项目不一致");
  }
  const linked = db.prepare(
    "SELECT 1 FROM materials WHERE file_key = ? UNION SELECT 1 FROM contracts WHERE file_key = ?"
  ).get(key, key);
  if (linked) throw conflict("附件已绑定其他业务单据，请重新上传", "FILE_ALREADY_LINKED");
  return file;
}

module.exports = { assertUploadAttachable };
