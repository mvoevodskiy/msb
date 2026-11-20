// Резервные копии базы: PULT_DATA_DIR/backups/ГГГГ-ММ-ДД.db (дата по PULT_TZ), храним 14 последних.
// Копия делается через VACUUM INTO (согласованный снимок даже при работающем сервисе) и сразу
// проверяется: открываем копию и делаем quick_check — непроверенная копия копией не считается.
// Восстановление — только при остановленном сервисе (pid-файл и порт), текущая база сохраняется рядом.

import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { dbPath, kvSet, type Db } from './db.ts';
import { localDate } from './time.ts';

export const KEEP_DAILY = 14;
const KEEP_BEFORE_RESTORE = 5;
const DAILY_RE = /^\d{4}-\d{2}-\d{2}\.db$/;

export const backupsDir = (dataDir: string): string => join(dataDir, 'backups');
export const pidFile = (dataDir: string): string => join(dataDir, 'pult.pid');

export interface DbFileInfo {
  ok: boolean;
  error: string | null;
  sizeBytes: number;
  schema: number | null;
  snapshotReceivedAt: string | null;
  metricsRows: number | null;
  metricsFrom: string | null;
  sessions: number | null;
  totpEnrolled: boolean | null;
}

/** Открыть файл базы только на чтение, проверить целостность и рассказать, что внутри. */
export function inspectDbFile(path: string): DbFileInfo {
  const info: DbFileInfo = { ok: false, error: null, sizeBytes: 0, schema: null, snapshotReceivedAt: null, metricsRows: null, metricsFrom: null, sessions: null, totpEnrolled: null };
  try {
    info.sizeBytes = statSync(path).size;
  } catch {
    info.error = 'файла нет';
    return info;
  }
  let db: DatabaseSync | null = null;
  try {
    db = new DatabaseSync(path, { readOnly: true });
    const check = db.prepare('PRAGMA quick_check').get() as { quick_check: string };
    if (check.quick_check !== 'ok') {
      info.error = `повреждена: ${check.quick_check}`;
      return info;
    }
    info.schema = Number((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version);
    if (info.schema >= 1) {
      const snap = db.prepare('SELECT received_at FROM snapshot WHERE id = 1').get() as { received_at: number } | undefined;
      info.snapshotReceivedAt = snap ? new Date(Number(snap.received_at)).toISOString() : null;
      const m = db.prepare('SELECT count(*) AS n, min(t) AS t FROM metrics').get() as { n: number; t: number | null };
      info.metricsRows = Number(m.n);
      info.metricsFrom = m.t === null ? null : new Date(Number(m.t)).toISOString();
      info.sessions = Number((db.prepare("SELECT count(*) AS n FROM sessions WHERE kind = 'full'").get() as { n: number }).n);
      info.totpEnrolled = Number((db.prepare('SELECT count(*) AS n FROM totp').get() as { n: number }).n) > 0;
    }
    info.ok = true;
  } catch (e) {
    info.error = `не открывается: ${(e as Error).message}`;
  } finally {
    db?.close();
  }
  return info;
}

/** Ежедневные копии, новые первыми. */
export function listBackups(dataDir: string): string[] {
  const dir = backupsDir(dataDir);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter(f => DAILY_RE.test(f)).sort().reverse();
}

function rotate(dataDir: string): void {
  const dir = backupsDir(dataDir);
  for (const f of listBackups(dataDir).slice(KEEP_DAILY)) rmSync(join(dir, f), { force: true });
  const before = readdirSync(dir).filter(f => f.startsWith('before-restore-') && f.endsWith('.db')).sort().reverse();
  for (const f of before.slice(KEEP_BEFORE_RESTORE)) rmSync(join(dir, f), { force: true });
}

/** VACUUM INTO во временный файл → проверка → переименование (атомарно заменяет копию за тот же день). */
function vacuumTo(db: Db, target: string): DbFileInfo {
  const tmp = `${target}.tmp-${process.pid}`;
  rmSync(tmp, { force: true });
  try {
    db.prepare('VACUUM INTO ?').run(tmp);
    const info = inspectDbFile(tmp);
    if (!info.ok) throw new Error(`копия не прошла проверку: ${info.error}`);
    renameSync(tmp, target);
    return info;
  } finally {
    rmSync(tmp, { force: true });
  }
}

export function makeBackup(db: Db, dataDir: string, now: number, tz: string): { file: string; info: DbFileInfo } {
  const dir = backupsDir(dataDir);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, `${localDate(now, tz)}.db`);
  const info = vacuumTo(db, file);
  rotate(dataDir);
  kvSet(db, 'last_backup', JSON.stringify({ at: new Date(now).toISOString(), file, sizeBytes: info.sizeBytes }));
  return { file, info };
}

/**
 * Жив ли процесс сервиса с этим pid. pid-файл переживает аварию и перезагрузку, а номер мог достаться
 * чужому процессу — поэтому на Linux сверяем командную строку (/proc/<pid>/cmdline) с server/main.ts.
 */
const pultAlive = (pid: number): boolean => {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EPERM') return false;
  }
  try {
    return readFileSync(`/proc/${pid}/cmdline`, 'utf8').includes('server/main.ts');
  } catch (e) {
    // Нет /proc (не Linux) — верим проверке сигналом; процесс исчез между проверками — не жив.
    return (e as NodeJS.ErrnoException).code !== 'ENOENT';
  }
};

/** Записать pid-файл сервиса. Если в нём живой чужой процесс — отказ (второй экземпляр на те же данные). */
export function acquirePidFile(dataDir: string): void {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const f = pidFile(dataDir);
  if (existsSync(f)) {
    const pid = Number(readFileSync(f, 'utf8').trim());
    if (pid !== process.pid && pultAlive(pid)) {
      throw new Error(`Пульт уже запущен на этих данных (pid ${pid}, ${f})`);
    }
  }
  writeFileSync(f, `${process.pid}\n`, { mode: 0o600 });
}

export function releasePidFile(dataDir: string): void {
  const f = pidFile(dataDir);
  try {
    if (readFileSync(f, 'utf8').trim() === String(process.pid)) unlinkSync(f);
  } catch { /* уже нет */ }
}

export function portOpen(host: string, port: number): Promise<boolean> {
  return new Promise(resolve => {
    const s = connect({ host, port });
    const done = (v: boolean): void => {
      s.destroy();
      resolve(v);
    };
    s.setTimeout(1000, () => done(false));
    s.once('connect', () => done(true));
    s.once('error', () => done(false));
  });
}

/** Почему сервис считается запущенным, или null. */
export async function serviceRunning(dataDir: string, host: string, port: number): Promise<string | null> {
  const f = pidFile(dataDir);
  if (existsSync(f)) {
    const pid = Number(readFileSync(f, 'utf8').trim());
    if (pultAlive(pid)) return `запущен процесс сервиса (pid ${pid} из ${f})`;
  }
  if (await portOpen(host, port)) return `порт ${host}:${port} занят — похоже, сервис работает`;
  return null;
}

export function backupFileFor(dataDir: string, date: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(`дата копии — ГГГГ-ММ-ДД, сейчас «${date}»`);
  return join(backupsDir(dataDir), `${date}.db`);
}

/**
 * Заменить базу копией. Вызывать только при остановленном сервисе (проверяет вызывающий).
 * Текущая база сохраняется в backups/before-restore-….db; возвращает путь к ней (или null, если базы не было).
 */
export function restoreBackup(dataDir: string, date: string, now: number): { savedCurrent: string | null } {
  const src = backupFileFor(dataDir, date);
  const info = inspectDbFile(src);
  if (!info.ok) throw new Error(`копия ${src}: ${info.error}`);
  const live = dbPath(dataDir);
  const dir = backupsDir(dataDir);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  let savedCurrent: string | null = null;
  if (existsSync(live)) {
    savedCurrent = join(dir, `before-restore-${new Date(now).toISOString().replace(/[:.]/g, '-')}.db`);
    try {
      const cur = new DatabaseSync(live);
      try {
        vacuumTo(cur, savedCurrent);
      } finally {
        cur.close();
      }
    } catch {
      // Текущая база не открывается (повреждена) — сохраняем файлы как есть.
      copyFileSync(live, savedCurrent);
      for (const ext of ['-wal', '-shm']) if (existsSync(live + ext)) copyFileSync(live + ext, savedCurrent + ext);
    }
  }
  const tmp = `${live}.restore-${process.pid}`;
  copyFileSync(src, tmp);
  for (const ext of ['-wal', '-shm']) rmSync(live + ext, { force: true });
  renameSync(tmp, live);
  rotate(dataDir);
  return { savedCurrent };
}

/** Автоматическая копия: первый проход после 04:00 по PULT_TZ, раз в сутки. */
export function autoBackupDue(now: number, tz: string, lastAutoDate: string | null, hourLocal: number): boolean {
  return hourLocal >= 4 && lastAutoDate !== localDate(now, tz);
}
