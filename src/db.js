'use strict';
const { DatabaseSync } = require('node:sqlite');
const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new DatabaseSync(path.join(DATA_DIR, 'alerts.db'));
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = NORMAL;
  PRAGMA busy_timeout = 5000;

  CREATE TABLE IF NOT EXISTS requests (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    email           TEXT NOT NULL,
    sku             TEXT NOT NULL,
    product_name    TEXT,
    status          TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending','sending','notified','failed')),
    attempts        INTEGER NOT NULL DEFAULT 0,
    last_error      TEXT,
    created_at      INTEGER NOT NULL,
    next_attempt_at INTEGER NOT NULL DEFAULT 0,
    send_started_at INTEGER,
    notified_at     INTEGER,
    message_id      TEXT
  );

  -- The database, not application code, guarantees "no duplicate open requests".
  CREATE UNIQUE INDEX IF NOT EXISTS uq_open_request
    ON requests (email, sku) WHERE status IN ('pending','sending');
  CREATE INDEX IF NOT EXISTS idx_requests_sku_status ON requests (sku, status);

  CREATE TABLE IF NOT EXISTS events (
    event_id    TEXT PRIMARY KEY,
    sku         TEXT NOT NULL,
    quantity    INTEGER,
    received_at INTEGER NOT NULL
  );
`);

module.exports = { db, DATA_DIR };
