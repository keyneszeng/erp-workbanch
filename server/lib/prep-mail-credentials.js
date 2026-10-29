"use strict";
/**
 * Encrypt provider credentials at application level before placing them into
 * Cloudflare Durable Object SQLite. Master key is a Worker secret, not a UI field.
 * Configurations never expose the stored API token back to the browser.
 */
const crypto=require("node:crypto");
const { db }=require("./db");
const { bad, HttpError }=require("./util");
const KEY="prep_resend_cipher_v1";
function masterKey(env){
  const pass=String((env||{}).ERP_MAIL_CONFIG_KEY||"");
  if(pass.length<32)throw new HttpError(503,"MAIL_ENCRYPTION_KEY_REQUIRED",
    "服务端尚未配置 ERP_MAIL_CONFIG_KEY（至少 32 个随机字符），不能保存发件密钥");
  return crypto.createHash("sha256").update(pass).digest();
}
function saveKey(input,env){
  const apiKey=String(input||"").trim();
  if(!/^re_[A-Za-z0-9_-]{12,200}$/.test(apiKey))throw bad("Resend API Key 格式不正确");
  const iv=crypto.randomBytes(12);
  const cipher=crypto.createCipheriv("aes-256-gcm",masterKey(env),iv);
  cipher.setAAD(Buffer.from("erp-prep-mail-v1"));
  const ct=Buffer.concat([cipher.update(apiKey,"utf8"),cipher.final()]);
  const blob={version:1,iv:iv.toString("base64"),ciphertext:ct.toString("base64"),
    tag:cipher.getAuthTag().toString("base64")};
  db.prepare("INSERT OR REPLACE INTO settings(k,v) VALUES (?,?)").run(KEY,JSON.stringify(blob));
  return {configured:true};
}
function stored(){
  return !!db.prepare("SELECT 1 AS yes FROM settings WHERE k=?").get(KEY);
}
function readKey(env){
  const row=db.prepare("SELECT v FROM settings WHERE k=?").get(KEY);
  if(!row)return null;
  const key=masterKey(env);
  try{
    const blob=JSON.parse(row.v);
    if(blob.version!==1)throw Error("unsupported format");
    const cipher=crypto.createDecipheriv("aes-256-gcm",key,Buffer.from(blob.iv,"base64"));
    cipher.setAAD(Buffer.from("erp-prep-mail-v1"));
    cipher.setAuthTag(Buffer.from(blob.tag,"base64"));
    return Buffer.concat([cipher.update(Buffer.from(blob.ciphertext,"base64")),cipher.final()]).toString("utf8");
  }catch{
    throw new HttpError(503,"MAIL_SECRET_DECRYPT_FAILED","邮件密钥无法解密，请核对服务端加密主密钥是否更换");
  }
}
function removeKey(){
  db.prepare("DELETE FROM settings WHERE k=?").run(KEY);
  return {configured:false};
}
module.exports={saveKey,readKey,removeKey,stored};
