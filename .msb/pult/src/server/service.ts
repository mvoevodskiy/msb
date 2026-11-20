// Сборка сервиса: база, Telegram, тревоги, сводка, HTTP-сервер и таймеры.
// main.ts вызывает startService с настройками из окружения; тесты — с временным каталогом,
// своим now() и подменённым fetch для Telegram.

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { createAlerter, type Alerter } from './alerts.ts';
import { createApp } from './app.ts';
import { autoBackupDue, makeBackup } from './backup.ts';
import type { Config } from './config.ts';
import { cleanup, kvGet, kvSet, openDb, type Db } from './db.ts';
import { stdoutLog, type Log } from './log.ts';
import { createSummary, type Summary } from './summary.ts';
import { createTelegram, type Notifier } from './telegram.ts';
import { runTgInbox } from './tg-inbox.ts';
import { localDate, localParts } from './time.ts';

export const DEFAULT_UI_DIR = join(import.meta.dirname, '..', 'ui');

export interface ServiceOptions {
  log?: Log;
  now?: () => number;
  fetchFn?: typeof fetch;
  retryDelaysMs?: number[];
  uiDir?: string;
  /** false — без таймеров (тесты дёргают проверки сами). */
  timers?: boolean;
}

export interface Service {
  server: Server;
  port: number;
  db: Db;
  notifier: Notifier;
  alerter: Alerter;
  summary: Summary;
  /** Ежедневная копия, если пора (первый проход после 04:00). */
  backupTick(): void;
  close(): Promise<void>;
}

export async function startService(cfg: Config, o: ServiceOptions = {}): Promise<Service> {
  const log = o.log ?? stdoutLog;
  const now = o.now ?? Date.now;
  const startedAt = now();
  const db = openDb(cfg.dataDir);
  const notifier = createTelegram({
    tg: cfg.tg, db, log, fetchFn: o.fetchFn, retryDelaysMs: o.retryDelaysMs, now, webAppUrl: cfg.publicUrl,
  });
  const alerter = createAlerter({ db, cfg, notifier, log, now, startedAt });
  const summary = createSummary({ db, cfg, notifier, log, now });

  const backupTick = (): void => {
    const t = now();
    if (!autoBackupDue(t, cfg.tz, kvGet(db, 'backup_auto_date'), localParts(t, cfg.tz).hour)) return;
    try {
      const { file, info } = makeBackup(db, cfg.dataDir, t, cfg.tz);
      kvSet(db, 'backup_auto_date', localDate(t, cfg.tz));
      log(`копия базы: ${file} (${Math.round(info.sizeBytes / 1024)} КБ, проверена)`);
    } catch (e) {
      log(`ошибка копии базы: ${(e as Error).message}`);
    }
  };

  const server = createServer(createApp({ cfg, db, notifier, alerter, log, now, uiDir: o.uiDir ?? DEFAULT_UI_DIR }));
  // 60 с — с запасом на снимок до 5 МБ по медленному каналу с другого сервера.
  server.requestTimeout = 60_000;
  server.headersTimeout = 15_000;

  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(cfg.port, cfg.host, () => {
        server.off('error', reject);
        resolve();
      });
    });
  } catch (e) {
    db.close();
    const err = e as NodeJS.ErrnoException;
    if (err.code === 'EADDRINUSE') throw new Error(`порт ${cfg.host}:${cfg.port} занят — другой процесс уже слушает его (PULT_PORT)`);
    if (err.code === 'EADDRNOTAVAIL') throw new Error(`адрес ${cfg.host} недоступен на этой машине (PULT_HOST)`);
    throw e;
  }
  const port = (server.address() as AddressInfo).port;

  // Кнопка меню бота → панель как Mini App только у владельца (один раз при старте).
  if (o.timers !== false && notifier.configured) {
    notifier.setWebAppMenu(cfg.publicUrl).then(r => {
      if (r.skipped) return;
      if (r.ok) log(`меню бота: Mini App «Пульт» → ${cfg.publicUrl} (только владелец)`);
      else log(`меню бота Mini App не поставилось: ${r.error}`);
    }).catch(e => log(`меню бота Mini App: ${(e as Error).message}`));
  }

  const timers: NodeJS.Timeout[] = [];
  const inboxAbort = new AbortController();
  const safe = (name: string, fn: () => unknown) => () => {
    try {
      const r = fn();
      if (r instanceof Promise) r.catch(e => log(`ошибка таймера «${name}»: ${(e as Error).message}`));
    } catch (e) {
      log(`ошибка таймера «${name}»: ${(e as Error).message}`);
    }
  };
  if (o.timers !== false) {
    const tick = {
      alerts: safe('тревоги', () => alerter.check()),
      summary: safe('сводка', () => summary.tick()),
      cleanup: safe('чистка', () => cleanup(db, now())),
      backup: safe('копия', backupTick),
    };
    timers.push(setInterval(tick.alerts, 30_000), setInterval(tick.summary, 60_000), setInterval(tick.cleanup, 3_600_000), setInterval(tick.backup, 10 * 60_000));
    tick.cleanup();
    // Сводку и копию — сразу при старте: догоняем пропущенное, пока сервис был выключен.
    tick.summary();
    timers.push(setTimeout(tick.backup, 60_000));

    // Любое сообщение владельца боту → свежая кнопка; чужим — тишина.
    if (cfg.tg && notifier.configured) {
      const inboxPromise = runTgInbox({
        tg: cfg.tg,
        db,
        log,
        fetchFn: o.fetchFn,
        now,
        signal: inboxAbort.signal,
        onOwnerMessage: async () => {
          await notifier.send(
            '🟢 От тебя ничего не нужно\n\nСвежая кнопка входа в Пульт — ниже и в меню бота',
            'button-req',
          );
        },
      });
      void inboxPromise.catch(e => {
        if (!inboxAbort.signal.aborted) log(`Telegram inbox остановился: ${(e as Error).message}`);
      });
      log('Telegram inbox: жду сообщения владельца');
    }
  }

  let closed = false;
  return {
    server, port, db, notifier, alerter, summary, backupTick,
    async close() {
      if (closed) return;
      closed = true;
      inboxAbort.abort();
      for (const t of timers) clearInterval(t);
      await new Promise<void>(resolve => {
        server.close(() => resolve());
        server.closeIdleConnections();
        // Висящие соединения (долгий запрос) не держат остановку дольше 5 с.
        setTimeout(() => {
          server.closeAllConnections();
          resolve();
        }, 5000).unref();
      });
      db.close();
    },
  };
}
