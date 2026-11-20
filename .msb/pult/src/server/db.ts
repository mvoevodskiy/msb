// Хранилище веб-сервиса: SQLite (node:sqlite) в PULT_DATA_DIR/pult.db, режим WAL.
// Время во всех таблицах — мс с эпохи (UTC). Версия схемы — PRAGMA user_version;
// новая миграция = новый элемент в MIGRATIONS, старые не менять.

import { chmodSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export type Db = DatabaseSync;

const MIGRATIONS: string[] = [
  // 1 — первая схема
  `
  CREATE TABLE snapshot (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    json TEXT NOT NULL,
    received_at INTEGER NOT NULL,
    collected_at TEXT NOT NULL,
    size INTEGER NOT NULL
  );
  -- Метрики сервера из каждого снимка, проценты. Хранятся 35 дней.
  CREATE TABLE metrics (t INTEGER NOT NULL, cpu REAL NOT NULL, mem REAL NOT NULL, disk REAL NOT NULL, swap REAL NOT NULL);
  CREATE INDEX metrics_t ON metrics (t);
  -- kind: full — вход выполнен; pre — пароль верный, ждём подключения второго фактора (pending_secret).
  CREATE TABLE sessions (
    token_hash TEXT PRIMARY KEY,
    kind TEXT NOT NULL CHECK (kind IN ('full', 'pre')),
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    last_seen_at INTEGER,
    user_agent TEXT,
    ip TEXT,
    pending_secret TEXT
  );
  CREATE INDEX sessions_expires ON sessions (expires_at);
  -- Второй фактор: одна строка. last_step — последний принятый шаг TOTP (защита от повтора кода).
  CREATE TABLE totp (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    secret TEXT NOT NULL,
    enrolled_at INTEGER NOT NULL,
    last_step INTEGER
  );
  CREATE TABLE login_failures (t INTEGER NOT NULL, ip TEXT NOT NULL);
  CREATE INDEX login_failures_t ON login_failures (t);
  CREATE INDEX login_failures_ip ON login_failures (ip, t);
  -- Тревоги. source: snapshot — из attention снимка, stale — «сборщик молчит».
  -- resolved_at не null — проблема ушла, ждёт отправки «снова в норме».
  CREATE TABLE alerts (
    key TEXT PRIMARY KEY,
    source TEXT NOT NULL,
    level TEXT NOT NULL,
    text TEXT NOT NULL,
    since INTEGER NOT NULL,
    first_seen INTEGER NOT NULL,
    seen_count INTEGER NOT NULL,
    last_seen INTEGER NOT NULL,
    notified INTEGER NOT NULL DEFAULT 0,
    notified_at INTEGER,
    resolved_at INTEGER
  );
  CREATE TABLE tg_log (
    id INTEGER PRIMARY KEY,
    t INTEGER NOT NULL,
    kind TEXT NOT NULL,
    ok INTEGER NOT NULL,
    error TEXT,
    chars INTEGER NOT NULL
  );
  CREATE INDEX tg_log_t ON tg_log (t);
  -- Служебное: дата последней сводки, последняя копия, ошибки Telegram и т. п.
  CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  `,
];

export const SCHEMA_VERSION = MIGRATIONS.length;

export function dbPath(dataDir: string): string {
  return join(dataDir, 'pult.db');
}

export function openDb(dataDir: string): Db {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const path = dbPath(dataDir);
  const db = new DatabaseSync(path, { timeout: 5000 });
  try {
    chmodSync(path, 0o600);
  } catch { /* чужая ФС без прав — не мешает работе */ }
  db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON;');
  migrate(db);
  return db;
}

export function schemaVersion(db: Db): number {
  return Number((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version);
}

export function migrate(db: Db): void {
  const current = schemaVersion(db);
  if (current > SCHEMA_VERSION) throw new Error(`База новее сервиса: схема ${current}, сервис знает до ${SCHEMA_VERSION}. Обнови код Пульта.`);
  for (let v = current; v < SCHEMA_VERSION; v++) {
    tx(db, () => {
      db.exec(MIGRATIONS[v]);
      db.exec(`PRAGMA user_version = ${v + 1}`);
    });
  }
}

/** Транзакция: BEGIN IMMEDIATE, чтобы admin.ts и сервис не столкнулись на записи. */
export function tx<T>(db: Db, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

export function kvGet(db: Db, key: string): string | null {
  const row = db.prepare('SELECT value FROM kv WHERE key = ?').get(key) as { value: string } | undefined;
  return row ? row.value : null;
}

export function kvSet(db: Db, key: string, value: string | null): void {
  if (value === null) db.prepare('DELETE FROM kv WHERE key = ?').run(key);
  else db.prepare('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value').run(key, value);
}

export interface StoredSnapshot { json: string; receivedAt: number; collectedAt: string; size: number }

export function getSnapshot(db: Db): StoredSnapshot | null {
  const row = db.prepare('SELECT json, received_at, collected_at, size FROM snapshot WHERE id = 1').get() as
    { json: string; received_at: number; collected_at: string; size: number } | undefined;
  return row ? { json: row.json, receivedAt: Number(row.received_at), collectedAt: row.collected_at, size: Number(row.size) } : null;
}

/** Чистка раз в час: метрики старше 35 дней, истёкшие сессии, старые неудачи входа и журнал Telegram. */
export function cleanup(db: Db, now: number): void {
  const day = 86_400_000;
  db.prepare('DELETE FROM metrics WHERE t < ?').run(now - 35 * day);
  db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(now);
  db.prepare('DELETE FROM login_failures WHERE t < ?').run(now - day);
  db.prepare('DELETE FROM tg_log WHERE t < ?').run(now - 90 * day);
}
