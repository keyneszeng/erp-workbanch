"use strict";
/**
 * 数据库层 —— 双后端（对外接口完全一致，上层 141 处调用零改动）
 *
 * 1) Node / Vercel：node:sqlite（DatabaseSync），同步 API
 * 2) Cloudflare Workers：Durable Object 的 ctx.storage.sql，同样是同步 API
 *
 * 之所以能做零改动适配，是因为 DO 的 SQL 存储也是同步的：
 *   sql.exec(query, ...bindings) -> SqlStorageCursor { toArray(), rowsWritten }
 * 而 node:sqlite 是：
 *   stmt.all()/get()/run()
 * 两者在 prepare/exec 语义上可以一一映射。
 *
 * ⚠️ Cloudflare Workers 里的 node:sqlite 是「非功能性空壳」（可 import，调用即抛），
 *    因此 node:sqlite 必须延迟 require —— 只有真正走 Node 后端时才加载。
 */
const path = require("node:path");
const { now } = require("./util");

// __dirname 在 Cloudflare Worker 的 ESM 产物里不存在（静态资源由 Assets 托管，用不到）
const HERE = typeof __dirname === "string" ? __dirname : "";
const DATA_DIR = path.join(HERE, "..", "..", "data");
const DEFAULT_DB_FILE = path.join(DATA_DIR, "erp.db");
const DB_FILE =
  (typeof process !== "undefined" && process.env && process.env.ERP_DB) || DEFAULT_DB_FILE;

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
  -- 变更单专用：审批通过 ≠ 生效。落账必须由「审批人以外的另一人」手工执行（双人复核），
  -- 所以要多记一组执行人 / 执行时间；status 走到「已执行」才算真正改到项目上。
  executed_by TEXT,
  executed_at TEXT,
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
  category    TEXT,
  remark      TEXT,
  created_by  INTEGER,
  created_at  TEXT NOT NULL,
  file_key    TEXT,
  file_name   TEXT,
  file_size   INTEGER,
  file_mime   TEXT
);
CREATE INDEX IF NOT EXISTS idx_contracts_pid ON contracts(pid);

CREATE TABLE IF NOT EXISTS payments (
  id          TEXT PRIMARY KEY,
  pid         TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  type        TEXT NOT NULL,
  payee       TEXT NOT NULL,
  payee_bank  TEXT,
  payee_account TEXT,
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
  step_label  TEXT,
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
  payee       TEXT,
  payee_bank  TEXT,
  payee_account TEXT,
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
  created_at  TEXT NOT NULL,
  file_key    TEXT,
  file_name   TEXT,
  file_size   INTEGER,
  file_mime   TEXT
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

-- Before attachment registration, files must be scoped to their uploader.
CREATE TABLE IF NOT EXISTS uploaded_files (
  file_key    TEXT PRIMARY KEY,
  user_id     INTEGER NOT NULL,
  pid         TEXT,
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_uploaded_files_user ON uploaded_files(user_id);
`;

/* ---------------------------------------------------------------- 后端实现 */

/** Node / Vercel：node:sqlite */
function nodeBackend() {
  // 用 process.getBuiltinModule 动态取，而不是 require("node:sqlite")：
  // 打包器会把 require 提升成顶层 import，而 Workers 里的 node:sqlite 只是空壳，
  // 顶层 import 会让整个 Worker 启动失败。动态调用则完全不进产物。
  const { DatabaseSync } = process.getBuiltinModule("node:sqlite");
  const fs = process.getBuiltinModule("node:fs");
  const file = DB_FILE;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const raw = new DatabaseSync(file);
  raw.exec("PRAGMA journal_mode = WAL");
  raw.exec("PRAGMA foreign_keys = ON");
  raw.exec("PRAGMA busy_timeout = 5000");
  return {
    name: "node:sqlite",
    file,
    exec(sql) {
      raw.exec(sql);
    },
    prepare(sql) {
      const stmt = raw.prepare(sql);
      return {
        all: (...p) => stmt.all(...p),
        get: (...p) => stmt.get(...p),
        run: (...p) => stmt.run(...p)
      };
    }
  };
}

/**
 * Cloudflare：Durable Object 内置 SQLite
 * ctx.storage.sql.exec() 是同步的，且支持一次执行多条以分号分隔的语句。
 * 事务必须走 ctx.storage.transactionSync()（exec 里禁止 BEGIN/COMMIT）。
 */
function durableBackend(ctx) {
  const sql = ctx.storage.sql;
  const one = (q, p) => sql.exec(q, ...p);
  return {
    name: "do-sqlite",
    file: "(Durable Object SQLite)",
    exec(q) {
      sql.exec(q);
    },
    prepare(q) {
      return {
        // 游标必须在 await 之前同步消费完毕，这里统一 toArray()
        all: (...p) => one(q, p).toArray(),
        get: (...p) => one(q, p).toArray()[0],
        run: (...p) => ({ changes: one(q, p).rowsWritten })
      };
    },
    transaction(fn) {
      return ctx.storage.transactionSync(fn);
    }
  };
}

/* ---------------------------------------------------------------- 对外接口 */

let backend = null;

function useBackend(b) {
  backend = b;
  return b;
}

function ensure() {
  if (!backend) {
    // 仅测试用：本机跑不了 workerd，用 node:sqlite 模拟 DO 的 SQL 接口，
    // 让同一套测试可以在 Cloudflare 后端语义下重跑一遍。
    const mockDo =
      typeof process !== "undefined" && process.env && process.env.ERP_DB_BACKEND === "do-sqlite";
    if (mockDo) {
      const { createStorage } = require("../../test/lib/do-sqlite-mock");
      backend = durableBackend({ storage: createStorage(DB_FILE) });
    } else {
      backend = nodeBackend();
    }
  }
  return backend;
}

/** 由 Cloudflare Worker 在 DO 构造时调用，把 DO 的 SQL 存储挂进来 */
function attachDurableObject(ctx) {
  return useBackend(durableBackend(ctx));
}

/** 测试用：注入自定义后端（如用 node:sqlite 模拟 DO 游标） */
function attachBackend(b) {
  return useBackend(b);
}

const db = {
  prepare(sql) {
    return ensure().prepare(sql);
  },
  exec(sql) {
    ensure().exec(sql);
  }
};

/** 统一事务入口：Node 走 BEGIN/COMMIT，Cloudflare 走 transactionSync */
function transaction(fn) {
  const b = ensure();
  if (b.transaction) return b.transaction(fn);
  b.exec("BEGIN");
  try {
    const r = fn();
    b.exec("COMMIT");
    return r;
  } catch (e) {
    try {
      b.exec("ROLLBACK");
    } catch {
      /* 回滚失败不掩盖原始异常 */
    }
    throw e;
  }
}

function migrate() {
  const b = ensure();
  b.exec(SCHEMA);

  // 兼容旧库：后加的列用 ALTER 补。CREATE TABLE IF NOT EXISTS 不会给已存在的表加列。
  const addColumn = (table, col, ddl) => {
    let cols = [];
    try {
      cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
    } catch {
      return;
    }
    if (cols.length && !cols.includes(col)) {
      try {
        db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
      } catch {
        /* 列已存在或后端不支持 ALTER，忽略 */
      }
    }
  };

  // V1.0.3：跨实例吊销签名令牌
  addColumn("users", "token_ver", "token_ver INTEGER NOT NULL DEFAULT 0");
  // V1.2.0：材料附件
  addColumn("materials", "file_key", "file_key TEXT");
  addColumn("materials", "file_name", "file_name TEXT");
  addColumn("materials", "file_size", "file_size INTEGER");
  addColumn("materials", "file_mime", "file_mime TEXT");
  // V1.2.1：合同原件附件（扫描件 PDF / 拍照件）
  addColumn("contracts", "file_key", "file_key TEXT");
  addColumn("contracts", "file_name", "file_name TEXT");
  addColumn("contracts", "file_size", "file_size INTEGER");
  addColumn("contracts", "file_mime", "file_mime TEXT");
  // V1.2.12：变更单的「落账人」。审批通过只是批准，真正改预算要另一个人执行（双人复核）
  addColumn("approvals", "executed_by", "executed_by TEXT");
  addColumn("approvals", "executed_at", "executed_at TEXT");
  // V1.2.23: person identity must be the stable user ID, not display name.
  addColumn("approvals", "submitted_by_id", "submitted_by_id INTEGER");
  addColumn("approvals", "decided_by_id", "decided_by_id INTEGER");
  addColumn("approvals", "executed_by_id", "executed_by_id INTEGER");
  // V1.2.13：合同类别 —— 核销第 5 步「劳务与专家费核对」只该看劳务专家类合同，
  // 以前没有这个字段，只能把项目下所有合同都列出来，场地餐饮合同会混进劳务核对里。
  addColumn("contracts", "category", "category TEXT");
  // V1.2.13：例外单自定义步骤名 —— 不属于 6 步中任何一步的问题也能登记（step_no = 0）
  addColumn("exceptions", "step_label", "step_label TEXT");
  /**
   * V1.2.18：收款方银行信息。
   *
   * 老板 2026-10-28：「生成结算单 / 付款两个功能板块缺少了收款方和银行账号信息」。
   * 付款只有收款方名字、没有账号，财务拿着单子没法打款；结算单更是只有三个金额，
   * 结余打给谁、打到哪个账户，纸上一个字都没有。
   *
   * 开户行与账号一起加：只写账号，柜面转账时还得反查是哪家行；只写行名，又没法自动转账。
   */
  addColumn("payments", "payee_bank", "payee_bank TEXT");
  addColumn("payments", "payee_account", "payee_account TEXT");
  addColumn("settlements", "payee", "payee TEXT");
  addColumn("settlements", "payee_bank", "payee_bank TEXT");
  addColumn("settlements", "payee_account", "payee_account TEXT");

  // 老库升级：历史合同按名称补一个初始类别，不然第 5 步会一份都筛不出来，
  // 看上去像「这个项目没签劳务合同」—— 这比原来的「全都列出来」更容易误导人。
  // 只补空的，不覆盖人工改过的值。
  try {
    const { guessContractCategory } = require("./constants");
    const need = db.prepare("SELECT id, name FROM contracts WHERE category IS NULL OR category = ''").all();
    if (need.length) {
      const upd = db.prepare("UPDATE contracts SET category = ? WHERE id = ?");
      for (const c of need) upd.run(guessContractCategory(c.name), c.id);
    }
  } catch {
    /* 旧库没有 contracts 表，忽略 */
  }

  // 附件查询走 file_key，补索引（旧库没有）
  try {
    db.exec("CREATE INDEX IF NOT EXISTS idx_materials_file ON materials(file_key)");
  } catch {
    /* 索引已存在 */
  }
  try {
    db.exec("CREATE INDEX IF NOT EXISTS idx_contracts_file ON contracts(file_key)");
  } catch {
    /* 索引已存在 */
  }

  /**
   * V1.2.17 PERF-01：列表页要用的索引。
   *
   * 测试报告实测接口 2.5~3.9 秒（含跨境 RTT，但只有 19 个项目也偏慢）。
   * 缓存与异步审计属于架构级改动，风险大，这次只做「加索引」这一半 ——
   * 它零风险、可回滚，且正好覆盖数据范围过滤与列表排序。
   * 注意 project_members 的主键是 (project_id, user_id)，
   * 按 project_id 查已经走主键前缀，真正缺的是「按人反查」。
   */
  const INDEXES = [
    "CREATE INDEX IF NOT EXISTS idx_projects_status ON projects(status)",
    "CREATE INDEX IF NOT EXISTS idx_projects_assoc ON projects(assoc)",
    "CREATE INDEX IF NOT EXISTS idx_projects_owner ON projects(owner_id)",
    "CREATE INDEX IF NOT EXISTS idx_payments_pid_status ON payments(pid, status)",
    "CREATE INDEX IF NOT EXISTS idx_audit_module ON audit_logs(module)",
    "CREATE INDEX IF NOT EXISTS idx_audit_user ON audit_logs(user_id)",
    "CREATE INDEX IF NOT EXISTS idx_audit_at ON audit_logs(at)",
    "CREATE INDEX IF NOT EXISTS idx_members_user ON project_members(user_id)"
  ];
  for (const sql of INDEXES) {
    try {
      db.exec(sql);
    } catch {
      /* 旧库缺表或索引已存在，忽略 */
    }
  }

  // V1.2.7：需求条目的「预算归属」改成「预算金额」，旧值里的文字要清掉
  // 老数据这一列存的是「会务预算」这类归属说明，不是钱数。
  // 字段语义换了以后，它在金额列里既不能合计也不能对照，留着只会误导。
  // GLOB 里 [^0-9.] 表示「含有数字和小数点以外的字符」—— 那一定不是合法金额。
  try {
    db.exec(
      `UPDATE demand_items
          SET budget = ''
        WHERE budget IS NOT NULL AND budget <> ''
          AND (budget GLOB '*[^0-9.]*' OR budget GLOB '*.*.*')`
    );
  } catch {
    /* 旧库没有 demand_items 表，忽略 */
  }

  // V1.2.6：项目负责人改为按 user_id 认人
  // 原来 exec / finance 的数据范围是 `p.owner = ?`（比对姓名），
  // 于是新建一个同名账号就能看到别人名下的项目；负责人改名后又把自己名下的项目全丢了。
  addColumn("projects", "owner_id", "owner_id INTEGER");
  try {
    db.exec(
      `UPDATE projects
          SET owner_id = (SELECT u.id FROM users u WHERE u.name = projects.owner ORDER BY u.id LIMIT 1)
        WHERE owner_id IS NULL AND owner IS NOT NULL AND owner <> ''`
    );
  } catch {
    /* users 表为空或旧库缺列，忽略 */
  }

  // V1.2.6：结算单金额定点自愈
  // 旧版本 profit 是 `income - expense` 直接算的，浮点会留下尾巴
  // （140000 - 135580.6 = 4419.399999999994），已经入库的老数据不会自己变干净，
  // 导出 CSV 就是这一串小数。这里收敛到「分」，幂等，跑多少次结果一样。
  // 注意是 ROUND(income - expense, 2)，不是 ROUND(income,2) - ROUND(expense,2) ——
  // 后者相减又会把尾巴带回来。
  try {
    db.exec(
      `UPDATE settlements
          SET income = ROUND(income, 2),
              expense = ROUND(expense, 2),
              profit = ROUND(income - expense, 2)
        WHERE profit <> ROUND(income - expense, 2)
           OR income <> ROUND(income, 2)
           OR expense <> ROUND(expense, 2)`
    );
  } catch {
    /* 旧库没有 settlements 表，忽略 */
  }

  // V1.2.15：审批单 ↔ 业务单据脱钩（老种子把 ref_id 写成了项目号）
  try {
    repairApprovals();
  } catch {
    /* 旧库没有 approvals / exceptions / payments 表，忽略 */
  }
}

/**
 * V1.2.15 数据自愈：把审批单重新挂回它对应的业务单据。
 *
 * 老板 2026-10-28 报的：「审批中心待审批两个单子，点通过都说『不存在了』，单子还在」。
 * 根因不是审批逻辑坏了，是 ref_id 从种子起就写成了项目号：
 *   · 点「通过」→ 按 ref_id 找例外单 / 付款单 → 找到的是项目号 → notFound；
 *   · 付款审批、改判撤销 → 按 ref_id 找审批单 → 同样找不到 → 审批单永远挂「待审批」。
 * 于是「业务早办完了」和「审批中心还挂着」同时成立。
 *
 * 这里只做两件确定的事：
 *   ① 能唯一确定业务单据的，把 ref_id 回填（标题里的 EX 号 / 同项目同金额的付款单）；
 *   ② 业务单据已经有结论的，把审批单同步成同一结论。
 * 拿不准就一律不动 —— 宁可留一条待人工判断，也不要猜错把别人的单子关掉。
 */
function repairApprovals() {
  const stamp = now();

  // ① 例外单审批：标题里的 EX 号最可靠；否则仅当该项目只有一张例外单时才采用
  const exAps = db
    .prepare("SELECT id, pid, title, ref_id FROM approvals WHERE type = '例外单审批'")
    .all();
  for (const a of exAps) {
    const exists = (id) => !!db.prepare("SELECT 1 AS ok FROM exceptions WHERE id = ?").get(id);
    if (a.ref_id && exists(a.ref_id)) continue;
    const m = /EX-\d{4}-\d{3,}/.exec(String(a.title || ""));
    let ref = m && exists(m[0]) ? m[0] : null;
    if (!ref) {
      const list = db
        .prepare("SELECT id FROM exceptions WHERE pid = ? ORDER BY created_at DESC, id DESC")
        .all(a.pid);
      if (list.length === 1) ref = list[0].id;
    }
    if (ref) db.prepare("UPDATE approvals SET ref_id = ? WHERE id = ?").run(ref, a.id);
  }

  // ② 付款审批：同项目、同金额、未被驳回，且只有一张时才采用
  const payAps = db
    .prepare("SELECT id, pid, amount, ref_id FROM approvals WHERE type = '付款审批'")
    .all();
  for (const a of payAps) {
    const exists = (id) => !!db.prepare("SELECT 1 AS ok FROM payments WHERE id = ?").get(id);
    if (a.ref_id && exists(a.ref_id)) continue;
    const list = db
      .prepare(
        `SELECT id FROM payments
          WHERE pid = ? AND status <> '已驳回' AND ABS(amount - ?) < 0.005
          ORDER BY created_at DESC, id DESC`
      )
      .all(a.pid, Number(a.amount) || 0);
    if (list.length === 1) {
      db.prepare("UPDATE approvals SET ref_id = ? WHERE id = ?").run(list[0].id, a.id);
    }
  }

  // ③ 同步结论：业务单据已经处理完，审批单不能还挂「待审批」
  const exDone = db
    .prepare(
      `SELECT a.id AS aid, a.ref_id AS ref, e.status AS st, e.approved_by AS by, e.approved_at AS at
         FROM approvals a JOIN exceptions e ON e.id = a.ref_id
        WHERE a.type = '例外单审批' AND a.status = '待审批'`
    )
    .all();
  const EX_MAP = { 已通过: "已通过", 已驳回: "已驳回", 已撤销: "已撤销" };
  for (const r of exDone) {
    const st = EX_MAP[r.st];
    if (!st) continue;
    db.prepare(
      "UPDATE approvals SET status = ?, decided_by = ?, decided_at = ?, comment = ? WHERE id = ?"
    ).run(st, r.by || "系统", r.at || stamp, `例外单 ${r.ref} 已是「${r.st}」，审批单同步关闭`, r.aid);
  }

  const payDone = db
    .prepare(
      `SELECT a.id AS aid, a.ref_id AS ref, y.status AS st
         FROM approvals a JOIN payments y ON y.id = a.ref_id
        WHERE a.type = '付款审批' AND a.status = '待审批'`
    )
    .all();
  for (const r of payDone) {
    const st = r.st === "已驳回" ? "已驳回" : r.st === "已审批" || r.st === "已付款" ? "已通过" : null;
    if (!st) continue;
    db.prepare(
      "UPDATE approvals SET status = ?, decided_by = ?, decided_at = ?, comment = ? WHERE id = ?"
    ).run(st, "系统", stamp, `付款单 ${r.ref} 已是「${r.st}」，审批单同步关闭`, r.aid);
  }
}

module.exports = {
  db,
  migrate,
  transaction,
  attachDurableObject,
  attachBackend,
  DB_FILE,
  DATA_DIR,
  SCHEMA
};
