// SQLite schema for users, leaders (per-user), trades, and connect-flow nonces.
// Single solo user model (chat_id is the primary key) — every Telegram chat
// becomes one tenant. Easy to extend to multi-tenant SaaS later.
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DB_PATH = process.env.DB_PATH || path.join(process.cwd(), 'data', 'bot.db');
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');

// idempotent column-add helper (SQLite has no ADD COLUMN IF NOT EXISTS)
function addCol(table, col, ddl) {
  try { db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${ddl}`); } catch (_) {}
}

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  chat_id              INTEGER PRIMARY KEY,
  telegram_username    TEXT,
  created_at           INTEGER NOT NULL DEFAULT (unixepoch()),
  proxy_address        TEXT,
  encrypted_trading_key TEXT,
  polymarket_api_key   TEXT,
  polymarket_api_secret TEXT,
  polymarket_api_passphrase TEXT,
  bot_enabled          INTEGER NOT NULL DEFAULT 1,
  mode                 TEXT NOT NULL DEFAULT 'COPY',
  size_multiplier      REAL NOT NULL DEFAULT 1.0,
  max_trade_size_usdc  REAL NOT NULL DEFAULT 50.0
);

CREATE TABLE IF NOT EXISTS leaders (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id              INTEGER NOT NULL,
  address              TEXT NOT NULL,
  label                TEXT,
  active               INTEGER NOT NULL DEFAULT 1,
  copy_size_pct        REAL,
  max_trade_size_usdc  REAL,
  mode_override        TEXT,
  filter_min_price            REAL,
  filter_max_price            REAL,
  filter_min_hours_to_close   REAL,
  filter_max_hours_to_close   REAL,
  filter_only_side            TEXT,
  filter_only_outcome         TEXT,
  filter_min_leader_usdc      REAL,
  filter_cooldown_minutes     REAL,
  last_copied_at              INTEGER,
  created_at           INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE (chat_id, address),
  FOREIGN KEY (chat_id) REFERENCES users (chat_id)
);

CREATE INDEX IF NOT EXISTS idx_leaders_address_active
  ON leaders (address, active);

CREATE TABLE IF NOT EXISTS trades (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id           INTEGER NOT NULL,
  leader_address    TEXT NOT NULL,
  market_id         TEXT,
  market_name       TEXT,
  side              TEXT,
  outcome           TEXT,
  price             REAL,
  size              REAL,
  notional_usdc     REAL,
  mode              TEXT,
  status            TEXT NOT NULL,
  error_msg         TEXT,
  leader_tx_hash    TEXT,
  bot_order_id      TEXT,
  detected_at       INTEGER NOT NULL,
  submitted_at      INTEGER,
  latency_ms        INTEGER,
  pnl_usdc          REAL
);

CREATE INDEX IF NOT EXISTS idx_trades_chat_status
  ON trades (chat_id, status, detected_at DESC);

CREATE TABLE IF NOT EXISTS connect_nonces (
  nonce        TEXT PRIMARY KEY,
  chat_id      INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL,
  consumed     INTEGER NOT NULL DEFAULT 0,
  created_at   INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS tp_sl_targets (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id       INTEGER NOT NULL,
  market_id     TEXT NOT NULL,
  market_name   TEXT,
  outcome       TEXT NOT NULL,
  tp_price      REAL,
  sl_price      REAL,
  active        INTEGER NOT NULL DEFAULT 1,
  created_at    INTEGER NOT NULL DEFAULT (unixepoch()),
  triggered_at  INTEGER
);

CREATE TABLE IF NOT EXISTS autopilot_config (
  chat_id        INTEGER PRIMARY KEY,
  enabled        INTEGER NOT NULL DEFAULT 0,
  top_n          INTEGER NOT NULL DEFAULT 5,
  min_winrate    REAL,
  last_synced_at INTEGER
);

CREATE TABLE IF NOT EXISTS limit_orders (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id      INTEGER NOT NULL,
  market_id    TEXT,
  market_name  TEXT,
  side         TEXT,
  outcome      TEXT,
  price        REAL,
  size         REAL,
  status       TEXT NOT NULL DEFAULT 'pending',
  created_at   INTEGER NOT NULL DEFAULT (unixepoch()),
  filled_at    INTEGER,
  cancelled_at INTEGER
);

CREATE TABLE IF NOT EXISTS referrals (
  chat_id              INTEGER PRIMARY KEY,
  ref_code             TEXT NOT NULL UNIQUE,
  referred_by          INTEGER,
  total_referred       INTEGER NOT NULL DEFAULT 0,
  total_earnings_usdc  REAL NOT NULL DEFAULT 0,
  created_at           INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS pending_inputs (
  chat_id    INTEGER PRIMARY KEY,
  action     TEXT NOT NULL,
  context    TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
`);

// ── per-leader management columns (idempotent) ──────────────────────────
addCol('leaders', 'sizing_mode',         "TEXT DEFAULT 'PCT'");      // PCT | FIXED_USDC | MATCH
addCol('leaders', 'fixed_size_usdc',     'REAL');
addCol('leaders', 'slippage_pct',        'REAL');
addCol('leaders', 'daily_limit_trades',  'INTEGER');
addCol('leaders', 'daily_limit_usdc',    'REAL');
addCol('leaders', 'auto_tp_pct',         'REAL');                    // auto-close at +X%
addCol('leaders', 'auto_sl_pct',         'REAL');                    // auto-close at -X%
addCol('leaders', 'muted',               'INTEGER NOT NULL DEFAULT 0');
addCol('leaders', 'paused',              'INTEGER NOT NULL DEFAULT 0');

const stmt = {
  upsertUser: db.prepare(`
    INSERT INTO users (chat_id, telegram_username) VALUES (?, ?)
    ON CONFLICT (chat_id) DO UPDATE SET telegram_username = excluded.telegram_username
  `),
  findUser: db.prepare('SELECT * FROM users WHERE chat_id = ?'),

  setUserCreds: db.prepare(`
    UPDATE users SET
      proxy_address = ?,
      encrypted_trading_key = ?,
      polymarket_api_key = ?,
      polymarket_api_secret = ?,
      polymarket_api_passphrase = ?
    WHERE chat_id = ?
  `),
  setMode: db.prepare('UPDATE users SET mode = ? WHERE chat_id = ?'),
  setBotEnabled: db.prepare('UPDATE users SET bot_enabled = ? WHERE chat_id = ?'),
  setSizing: db.prepare('UPDATE users SET size_multiplier = ?, max_trade_size_usdc = ? WHERE chat_id = ?'),

  addLeader: db.prepare(`
    INSERT INTO leaders (chat_id, address, label) VALUES (?, ?, ?)
    ON CONFLICT (chat_id, address) DO UPDATE SET active = 1, label = COALESCE(excluded.label, leaders.label)
  `),
  removeLeader: db.prepare('UPDATE leaders SET active = 0 WHERE chat_id = ? AND address = ?'),
  listLeaders: db.prepare('SELECT * FROM leaders WHERE chat_id = ? AND active = 1 ORDER BY id DESC'),
  listAllActiveLeaders: db.prepare(`
    SELECT l.*, u.bot_enabled, u.mode AS user_mode, u.size_multiplier, u.max_trade_size_usdc AS user_max_usdc,
           u.proxy_address, u.encrypted_trading_key,
           u.polymarket_api_key, u.polymarket_api_secret, u.polymarket_api_passphrase
    FROM leaders l JOIN users u ON l.chat_id = u.chat_id
    WHERE l.active = 1 AND u.bot_enabled = 1 AND u.proxy_address IS NOT NULL
  `),
  setLeaderSizing: db.prepare('UPDATE leaders SET copy_size_pct = ?, max_trade_size_usdc = ? WHERE id = ?'),

  getLeaderById: db.prepare('SELECT * FROM leaders WHERE id = ? AND chat_id = ?'),
  setLeaderField: (col) => db.prepare(`UPDATE leaders SET ${col} = ? WHERE id = ? AND chat_id = ?`),
  leaderPnl: db.prepare(`
    SELECT COUNT(*) AS n, SUM(COALESCE(pnl_usdc,0)) AS pnl, SUM(COALESCE(notional_usdc,0)) AS vol
    FROM trades WHERE chat_id = ? AND lower(leader_address) = lower(?)
  `),
  leaderDailyCount: db.prepare(`
    SELECT COUNT(*) AS n, SUM(COALESCE(notional_usdc,0)) AS vol
    FROM trades WHERE chat_id = ? AND lower(leader_address) = lower(?)
      AND detected_at > unixepoch() - 86400 AND status = 'submitted'
  `),
  setLeaderFilters: db.prepare(`
    UPDATE leaders SET
      filter_min_price = ?, filter_max_price = ?,
      filter_min_hours_to_close = ?, filter_max_hours_to_close = ?,
      filter_only_side = ?, filter_only_outcome = ?,
      filter_min_leader_usdc = ?, filter_cooldown_minutes = ?
    WHERE id = ?
  `),
  markLeaderCopied: db.prepare('UPDATE leaders SET last_copied_at = ? WHERE id = ?'),

  recordTrade: db.prepare(`
    INSERT INTO trades (chat_id, leader_address, market_id, market_name,
      side, outcome, price, size, notional_usdc, mode, status, error_msg,
      leader_tx_hash, bot_order_id, detected_at, submitted_at, latency_ms)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `),
  listRecentTrades: db.prepare(`
    SELECT * FROM trades WHERE chat_id = ? ORDER BY detected_at DESC LIMIT ?
  `),
  statsForChat: db.prepare(`
    SELECT
      COUNT(*) AS n_total,
      SUM(CASE WHEN status='submitted' THEN 1 ELSE 0 END) AS n_submitted,
      SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END) AS n_failed,
      SUM(CASE WHEN status='skipped' THEN 1 ELSE 0 END) AS n_skipped,
      SUM(CASE WHEN status='paper' THEN 1 ELSE 0 END) AS n_paper,
      AVG(CASE WHEN latency_ms > 0 THEN latency_ms END) AS avg_latency,
      SUM(COALESCE(pnl_usdc, 0)) AS total_pnl
    FROM trades WHERE chat_id = ?
  `),

  newNonce: db.prepare(`
    INSERT INTO connect_nonces (nonce, chat_id, expires_at) VALUES (?, ?, ?)
  `),
  consumeNonce: db.prepare(`
    UPDATE connect_nonces SET consumed = 1
    WHERE nonce = ? AND consumed = 0 AND expires_at > unixepoch()
    RETURNING chat_id
  `),

  // ── TP/SL targets ─────────────────────────────────────────────────
  addTpSl: db.prepare(`
    INSERT INTO tp_sl_targets (chat_id, market_id, market_name, outcome, tp_price, sl_price)
    VALUES (?, ?, ?, ?, ?, ?)
  `),
  listTpSl: db.prepare(`
    SELECT * FROM tp_sl_targets WHERE chat_id = ? AND active = 1 ORDER BY id DESC
  `),
  setTpSlActive: db.prepare('UPDATE tp_sl_targets SET active = ? WHERE id = ? AND chat_id = ?'),
  triggerTpSl: db.prepare(`
    UPDATE tp_sl_targets SET active = 0, triggered_at = unixepoch() WHERE id = ?
  `),

  // ── AutoPilot ─────────────────────────────────────────────────────
  upsertAutopilot: db.prepare(`
    INSERT INTO autopilot_config (chat_id, enabled, top_n)
    VALUES (?, ?, ?)
    ON CONFLICT (chat_id) DO UPDATE SET enabled = excluded.enabled, top_n = excluded.top_n
  `),
  getAutopilot: db.prepare('SELECT * FROM autopilot_config WHERE chat_id = ?'),
  setAutopilotSynced: db.prepare(`
    UPDATE autopilot_config SET last_synced_at = unixepoch() WHERE chat_id = ?
  `),

  // ── Limit Orders ──────────────────────────────────────────────────
  addLimitOrder: db.prepare(`
    INSERT INTO limit_orders (chat_id, market_id, market_name, side, outcome, price, size, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')
  `),
  listLimitOrders: db.prepare(`
    SELECT * FROM limit_orders WHERE chat_id = ? AND status = 'pending' ORDER BY id DESC
  `),
  cancelLimitOrder: db.prepare(`
    UPDATE limit_orders SET status = 'cancelled', cancelled_at = unixepoch()
    WHERE id = ? AND chat_id = ? AND status = 'pending'
  `),

  // ── Referrals ─────────────────────────────────────────────────────
  upsertReferral: db.prepare(`
    INSERT INTO referrals (chat_id, ref_code, referred_by) VALUES (?, ?, ?)
    ON CONFLICT (chat_id) DO NOTHING
  `),
  getReferral: db.prepare('SELECT * FROM referrals WHERE chat_id = ?'),
  findReferralByCode: db.prepare('SELECT * FROM referrals WHERE ref_code = ?'),
  bumpReferralCount: db.prepare(`
    UPDATE referrals SET total_referred = total_referred + 1 WHERE chat_id = ?
  `),

  // ── Pending input flow (when bot asks for a value) ────────────────
  setPendingInput: db.prepare(`
    INSERT INTO pending_inputs (chat_id, action, context, created_at)
    VALUES (?, ?, ?, unixepoch())
    ON CONFLICT (chat_id) DO UPDATE SET
      action = excluded.action,
      context = excluded.context,
      created_at = excluded.created_at
  `),
  getPendingInput: db.prepare('SELECT * FROM pending_inputs WHERE chat_id = ?'),
  clearPendingInput: db.prepare('DELETE FROM pending_inputs WHERE chat_id = ?'),
};

module.exports = { db, stmt };
