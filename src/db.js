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
`);

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
};

module.exports = { db, stmt };
