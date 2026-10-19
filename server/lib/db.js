"use strict";
/**
 * 数据库层 —— 使用 Node 内置 node:sqlite（零第三方依赖）
 * 启动参数需带 --experimental-sqlite（Node 22/24 均支持）
 */
const { DatabaseSync } = require("node:sqlite");
const path = require("node:path");
const fs = require("node:fs");

const DATA_DIR = path.join(__dirname, "..", "..", "data");
const DB_FILE = process.env.ERP_DB || path.join(DATA_DIR, "erp.db");

fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });

const db = new DatabaseSync(DB_FILE);
db.exec("PRAGMA journal_mode = WAL");
db.exec("PRAGMA foreign_keys = ON");
db.exec("PRAGMA busy_timeout = 5000");

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  username    TEXT UNIQUE NOT NULL,
  name        TEXT NOT NULL,
  role        TEXT NOT NULL,
  assoc       TEXT,
  dept        TEXT,
  phone       TEXT,
  pass_salt   TEXT NOT NULL,
  pass_hash   TEXT NOT NULL,
  active      INTEGER NOT NULL DEFAULT 1,
  token_ver   INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token       TEXT PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  TEXT NOT NULL,
  expires_at  TEXT NOT NULL,
  ip          TEXT
);

CREATE TABLE IF NOT EXISTS projects (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  assoc       TEXT NOT NULL,
  form        TEXT NOT NULL,
  date        TEXT NOT NULL,
  days        INTEGER NOT NULL DEFAULT 1,
  budget      REAL NOT NULL DEFAULT 0,
  people      INTEGER NOT NULL DEFAULT 0,
  owner       TEXT,
  phone       TEXT,
  dept        TEXT,
  agenda      TEXT,
  status      TEXT NOT NULL DEFAULT '草稿',
  status_at   TEXT,
  created_by  INTEGER REFERENCES users(id),
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_projects_status ON projects(status);
CREATE INDEX IF NOT EXISTS idx_projects_assoc  ON projects(assoc);

CREATE TABLE IF NOT EXISTS project_members (
  project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role        TEXT,
  PRIMARY KEY (project_id, user_id)
);

CREATE TABLE IF NOT EXISTS approvals (
  id          TEXT PRIMARY KEY,
  type        TEXT NOT NULL,
  title       TEXT NOT NULL,
  pid         TEXT,
  ref_id      TEXT,
  amount      REAL NOT NULL DEFAULT 0,
  by_user     TEXT,
  sla         TEXT,
  status      TEXT NOT NULL DEFAULT '待审批',
  decided_by  TEXT,
  decided_at  TEXT,
  comment     TEXT,
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_approvals_status ON approvals(status);

CREATE TABLE IF NOT EXISTS contracts (
  id          TEXT PRIMARY KEY,
  pid         TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  vendor      TEXT NOT NULL,
  amount      REAL NOT NULL DEFAULT 0,
  sign_date   TEXT,
  status      TEXT NOT NULL DEFAULT '草稿',
  remark      TEXT,
  created_by  INTEGER,
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_contracts_pid ON contracts(pid);

CREATE TABLE IF NOT EXISTS payments (
  id          TEXT PRIMARY KEY,
  pid         TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  type        TEXT NOT NULL,
  payee       TEXT NOT NULL,
  amount      REAL NOT NULL DEFAULT 0,
  invoice_no  TEXT,
  req_user    TEXT,
  status      TEXT NOT NULL DEFAULT '待审批',
  paid_at     TEXT,
  remark      TEXT,
  created_by  INTEGER,
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_payments_pid ON payments(pid);

CREATE TABLE IF NOT EXISTS verify_steps (
  pid         TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  step_no     INTEGER NOT NULL,
  name        TEXT NOT NULL,
  result      TEXT NOT NULL DEFAULT '待判定',
  remark      TEXT,
  checked_by  TEXT,
  checked_at  TEXT,
  PRIMARY KEY (pid, step_no)
);

CREATE TABLE IF NOT EXISTS exceptions (
  id          TEXT PRIMARY KEY,
  pid         TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  step_no     INTEGER NOT NULL,
  reason      TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT '待审批',
  created_by  TEXT,
  created_at  TEXT NOT NULL,
  approved_by TEXT,
  approved_at TEXT,
  comment     TEXT
);

CREATE TABLE IF NOT EXISTS settlements (
  id          TEXT PRIMARY KEY,
  pid         TEXT NOT NULL UNIQUE REFERENCES projects(id) ON DELETE CASCADE,
  income      REAL NOT NULL DEFAULT 0,
  expense     REAL NOT NULL DEFAULT 0,
  profit      REAL NOT NULL DEFAULT 0,
  status      TEXT NOT NULL DEFAULT '已生成',
  created_by  TEXT,
  created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS materials (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  pid         TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL,
  name        TEXT NOT NULL,
  version     TEXT,
  uploader    TEXT,
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_materials_pid ON materials(pid);

CREATE TABLE IF NOT EXISTS guests (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  pid         TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  org         TEXT,
  title       TEXT,
  phone       TEXT,
  status      TEXT NOT NULL DEFAULT '待邀请',
  created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tasks (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  pid         TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  owner       TEXT,
  due         TEXT,
  status      TEXT NOT NULL DEFAULT '待开始',
  priority    TEXT DEFAULT '中',
  created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS issues (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  pid         TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title       TEXT NOT NULL,
  level       TEXT NOT NULL DEFAULT '一般',
  owner       TEXT,
  status      TEXT NOT NULL DEFAULT '处理中',
  created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  at          TEXT NOT NULL,
  user_id     INTEGER,
  user_name   TEXT,
  role        TEXT,
  module      TEXT NOT NULL,
  action      TEXT NOT NULL,
  target      TEXT,
  detail      TEXT,
  ip          TEXT
);
CREATE INDEX IF NOT EXISTS idx_audit_at ON audit_logs(at DESC);

CREATE TABLE IF NOT EXISTS demand_sheets (
  pid          TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  confirmed    INTEGER NOT NULL DEFAULT 0,
  confirmed_by TEXT,
  confirmed_at TEXT,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS demand_items (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  pid         TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  grp         TEXT NOT NULL,
  item        TEXT NOT NULL,
  note        TEXT,
  need        TEXT NOT NULL DEFAULT '需要',
  spec        TEXT,
  owner       TEXT,
  due         TEXT,
  budget      TEXT,
  attach      TEXT,
  status      TEXT NOT NULL DEFAULT '未开始',
  ordering    INTEGER NOT NULL DEFAULT 0,
  updated_at  TEXT NOT NULL,
  UNIQUE (pid, grp, item)
);
CREATE INDEX IF NOT EXISTS idx_demand_items_pid ON demand_items(pid);

CREATE TABLE IF NOT EXISTS exports (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  at          TEXT NOT NULL,
  user_name   TEXT,
  module      TEXT,
  filename    TEXT,
  rows        INTEGER
);

CREATE TABLE IF NOT EXISTS settings (
  k TEXT PRIMARY KEY,
  v TEXT
);
`;

function migrate() {
  db.exec(SCHEMA);
  // 兼容旧库：users.token_ver 是 V1.0.3 新增列（用于跨实例吊销签名令牌）
  const cols = db.prepare("PRAGMA table_info(users)").all().map((c) => c.name);
  if (!cols.includes("token_ver")) {
    db.exec("ALTER TABLE users ADD COLUMN token_ver INTEGER NOT NULL DEFAULT 0");
  }
}

module.exports = { db, migrate, DB_FILE, DATA_DIR };
