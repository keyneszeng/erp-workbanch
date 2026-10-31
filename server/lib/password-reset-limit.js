"use strict";
/**
 * Persistent public password reset rate limits (Node SQLite and Durable Object SQLite).
 * Hash identifiers before storage: never persist raw client IPs or phone numbers.
 * SMS provider additionally enforces per-user cooldown, daily quota and five OTP attempts.
 */
const crypto = require("node:crypto");
const { db } = require("./db");
const { HttpError } = require("./util");

function consumeResetLimit(kind, identity, limit, windowMs) {
  const key = crypto.createHash("sha256").update(kind + ":" + String(identity || "-")).digest("hex");
  const bucket = Math.floor(Date.now() / windowMs) * windowMs;
  const old = db.prepare("SELECT bucket_ms, hits FROM password_reset_limits WHERE rate_key = ?").get(key);
  if (old && Number(old.bucket_ms) === bucket && Number(old.hits) >= limit) {
    throw new HttpError(429, "RESET_RATE_LIMIT", "操作过于频繁，请稍后重试");
  }
  db.prepare(
    "INSERT INTO password_reset_limits (rate_key,bucket_ms,hits) VALUES (?,?,1) "+
    "ON CONFLICT(rate_key) DO UPDATE SET bucket_ms=excluded.bucket_ms, hits=CASE WHEN password_reset_limits.bucket_ms=excluded.bucket_ms THEN password_reset_limits.hits+1 ELSE 1 END"
  ).run(key, bucket);
}
module.exports = { consumeResetLimit };
