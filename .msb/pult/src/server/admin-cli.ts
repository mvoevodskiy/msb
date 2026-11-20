// Команды администратора Пульта (вызываются через admin.ts). Вынесены отдельно, чтобы тесты
// гоняли их как функцию: runAdmin(argv, io) → код выхода.

import { existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { listSessions, clearSessions, getTotp, resetTotp, shortUserAgent } from './auth.ts';
import { backupFileFor, inspectDbFile, listBackups, makeBackup, restoreBackup, serviceRunning } from './backup.ts';
import { ConfigError, loadConfig, type Config } from './config.ts';
import { dbPath, getSnapshot, kvGet, migrate, openDb, schemaVersion, type Db } from './db.ts';
import { silentLog } from './log.ts';
import { summaryText } from './summary.ts';
import { loadSnapshot } from './snapshot.ts';
import { createTelegram } from './telegram.ts';
import { ago, localDate, plural, whenShort } from './time.ts';

export const HELP = `Пульт — команды администратора веб-сервиса.

Запуск: node src/server/admin.ts <команда> [флаги]
Настройки — те же переменные окружения, что у сервиса. С файлом секретов службы, например:
  (set -a; . /home/client/pult-secrets/web.env; set +a; node src/server/admin.ts check)

Команды:
  check [--json]            проверить настройки, базу, свежесть снимка, копии, отвечает ли сервис (/health)
                            и Telegram (getMe, без сообщений). Код выхода 1 — есть ошибки.
  sessions [--json]         список активных сессий входа
  sessions clear --yes      завершить все сессии (выйти на всех устройствах)
  reset-2fa --yes           сбросить второй фактор и все сессии; при следующем входе подключишь заново
  send-test                 обновить кнопку меню Mini App и отправить проверочное сообщение с кнопкой «Открыть Пульт»
  summary --print           показать текст утренней сводки (HTML для Telegram), ничего не отправляя
  backup                    сделать копию базы сейчас: backups/ГГГГ-ММ-ДД.db, проверить её, хранить 14
  restore                   показать доступные копии
  restore <ГГГГ-ММ-ДД>      показать, что в копии
  restore <ГГГГ-ММ-ДД> --yes  заменить базу копией (сервис должен быть остановлен; текущая база
                            сохранится в backups/before-restore-….db)

Платных вызовов нет. Секреты (пароль, токены) команды не выводят.`;

export interface AdminIo {
  env?: Record<string, string | undefined>;
  out?: (s: string) => void;
  err?: (s: string) => void;
  fetchFn?: typeof fetch;
  now?: () => number;
}

export async function runAdmin(argv: string[], io: AdminIo = {}): Promise<number> {
  const out = io.out ?? (s => process.stdout.write(`${s}\n`));
  const err = io.err ?? (s => process.stderr.write(`${s}\n`));
  const now = io.now ?? Date.now;
  const flags = new Set(argv.filter(a => a.startsWith('--')));
  const args = argv.filter(a => !a.startsWith('--'));
  const cmd = args[0];

  if (!cmd || flags.has('--help') || cmd === 'help') {
    out(HELP);
    return cmd || flags.has('--help') ? 0 : 2;
  }

  let cfg: Config;
  try {
    cfg = loadConfig(io.env ?? process.env);
  } catch (e) {
    if (cmd === 'check' && flags.has('--json')) out(JSON.stringify({ ok: false, error: (e as Error).message }));
    else err(`Настройки: ${e instanceof ConfigError ? e.message : (e as Error).message}`);
    return 1;
  }

  const withDb = <T>(fn: (db: Db) => T): T => {
    const db = openDb(cfg.dataDir);
    try {
      return fn(db);
    } finally {
      db.close();
    }
  };
  const tz = cfg.tz;
  const when = (iso: string | number): string => {
    const t = typeof iso === 'number' ? iso : Date.parse(iso);
    return `${localDate(t, tz).split('-').reverse().join('.')} ${whenShort(t, t, tz)}`;
  };

  switch (cmd) {
    case 'check':
      return check(cfg, io, flags.has('--json'), out, now, when);

    case 'sessions': {
      if (args[1] === 'clear') {
        if (!flags.has('--yes')) {
          err('Завершит все сессии: придётся войти заново на всех устройствах. Повтори с --yes.');
          return 2;
        }
        const n = withDb(db => clearSessions(db));
        out(`Сессии завершены: ${n}.`);
        return 0;
      }
      if (args[1]) {
        err(`Неизвестная подкоманда sessions ${args[1]}. Смотри --help.`);
        return 2;
      }
      const list = withDb(db => listSessions(db, now()));
      if (flags.has('--json')) {
        out(JSON.stringify(list.map(s => ({
          createdAt: new Date(s.createdAt).toISOString(),
          lastSeenAt: s.lastSeenAt === null ? null : new Date(s.lastSeenAt).toISOString(),
          expiresAt: new Date(s.expiresAt).toISOString(),
          ip: s.ip,
          device: shortUserAgent(s.userAgent),
        }))));
        return 0;
      }
      if (!list.length) out('Активных сессий нет.');
      for (const s of list) {
        out(`• ${shortUserAgent(s.userAgent)}, IP ${s.ip ?? '?'} — вход ${when(s.createdAt)}, последний раз ${s.lastSeenAt ? when(s.lastSeenAt) : '—'}, действует до ${when(s.expiresAt)}`);
      }
      return 0;
    }

    case 'reset-2fa': {
      if (!flags.has('--yes')) {
        err('Сбросит второй фактор и завершит все сессии. После этого первый вход по паролю откроет подключение нового приложения. Повтори с --yes.');
        return 2;
      }
      const r = withDb(db => resetTotp(db));
      out(`${r.hadTotp ? 'Второй фактор сброшен' : 'Второй фактор и не был подключён'}; сессий завершено: ${r.sessions}.`);
      const db = openDb(cfg.dataDir);
      try {
        const tg = createTelegram({ tg: cfg.tg, db, log: silentLog, fetchFn: io.fetchFn, webAppUrl: cfg.publicUrl });
        if (tg.configured) await tg.send('🟢 От тебя ничего не нужно\n\nВторой фактор входа в Пульт сброшен командой администратора, все сессии завершены', 'reset-2fa');
      } finally {
        db.close();
      }
      return 0;
    }

    case 'send-test': {
      const db = openDb(cfg.dataDir);
      try {
        const tg = createTelegram({ tg: cfg.tg, db, log: silentLog, fetchFn: io.fetchFn, webAppUrl: cfg.publicUrl });
        if (!tg.configured) {
          err('Telegram не настроен: задай PULT_TG_TOKEN и PULT_TG_CHAT_ID (или OWNER_USER_ID).');
          return 1;
        }
        const menu = await tg.setWebAppMenu(cfg.publicUrl);
        if (menu.ok) out('Кнопка меню Mini App «Пульт» обновлена.');
        else if (!menu.skipped) err(`Меню Mini App: ${menu.error}`);
        const r = await tg.send('🟢 От тебя ничего не нужно\n\nПроверка связи Пульта — кнопка ниже открывает панель как мини-приложение', 'test');
        if (r.ok) {
          out('Проверочное сообщение отправлено (с кнопкой Mini App).');
          return 0;
        }
        err(`Не отправлено: ${r.error}`);
        return 1;
      } finally {
        db.close();
      }
    }

    case 'summary': {
      if (!flags.has('--print')) {
        err('Сейчас есть только summary --print (показать текст сводки без отправки).');
        return 2;
      }
      const text = withDb(db => summaryText({ snap: loadSnapshot(db), now: now(), tz, staleSec: cfg.staleSec, publicUrl: cfg.publicUrl }));
      out(text);
      return 0;
    }

    case 'backup': {
      try {
        const { file, info } = withDb(db => makeBackup(db, cfg.dataDir, now(), tz));
        out(`Копия готова и проверена: ${file} (${Math.round(info.sizeBytes / 1024)} КБ). Хранится 14 последних.`);
        return 0;
      } catch (e) {
        err(`Копия не сделана: ${(e as Error).message}`);
        return 1;
      }
    }

    case 'restore': {
      const date = args[1];
      if (!date) {
        const list = listBackups(cfg.dataDir);
        out(list.length ? `Копии (новые первыми):\n${list.map(f => `• ${f.replace(/\.db$/, '')}`).join('\n')}` : 'Копий пока нет.');
        return 0;
      }
      let file: string;
      try {
        file = backupFileFor(cfg.dataDir, date);
      } catch (e) {
        err((e as Error).message);
        return 2;
      }
      const info = inspectDbFile(file);
      if (!info.ok) {
        err(`Копия ${file}: ${info.error}`);
        return 1;
      }
      out(`Копия ${file}: ${Math.round(info.sizeBytes / 1024)} КБ, схема ${info.schema}, проверка целостности пройдена.`);
      out(`  последний снимок: ${info.snapshotReceivedAt ? when(info.snapshotReceivedAt) : 'нет'}`);
      out(`  метрики: ${info.metricsRows} ${plural(info.metricsRows ?? 0, ['точка', 'точки', 'точек'])}${info.metricsFrom ? ` с ${when(info.metricsFrom)}` : ''}`);
      out(`  второй фактор: ${info.totpEnrolled ? 'подключён' : 'не подключён'}; сессий: ${info.sessions}`);
      if (!flags.has('--yes')) {
        out('Чтобы заменить текущую базу этой копией, останови сервис и повтори с --yes.');
        return 0;
      }
      const running = await serviceRunning(cfg.dataDir, cfg.host, cfg.port);
      if (running) {
        err(`Восстановление отменено: ${running}. Останови сервис (systemctl stop …) и повтори.`);
        return 1;
      }
      try {
        const r = restoreBackup(cfg.dataDir, date, now());
        const v = withDb(db => schemaVersion(db));
        out(`База восстановлена из ${date} (схема ${v}).${r.savedCurrent ? ` Прежняя база сохранена: ${r.savedCurrent}` : ''}`);
        out('Запусти сервис снова.');
        return 0;
      } catch (e) {
        err(`Восстановление не выполнено: ${(e as Error).message}`);
        return 1;
      }
    }

    default:
      err(`Неизвестная команда «${cmd}». Смотри --help.`);
      return 2;
  }
}

async function check(cfg: Config, io: AdminIo, asJson: boolean, out: (s: string) => void, now: () => number, when: (t: string | number) => string): Promise<number> {
  const problems: string[] = [];
  const warnings: string[] = [];
  const lines: string[] = [];
  const report: Record<string, unknown> = {
    config: { host: cfg.host, port: cfg.port, dataDir: cfg.dataDir, publicUrl: cfg.publicUrl, tz: cfg.tz, staleSec: cfg.staleSec, summaryHour: cfg.summaryHour, cookieSecure: cfg.cookieSecure, trustProxy: cfg.trustProxy },
  };
  lines.push(`Настройки: в порядке — ${cfg.host}:${cfg.port}, данные ${cfg.dataDir}, адрес ${cfg.publicUrl}, пояс ${cfg.tz}`);

  const path = dbPath(cfg.dataDir);
  if (!existsSync(path)) {
    lines.push(`База: ещё не создана (${path}) — появится при первом запуске сервиса`);
    warnings.push('базы ещё нет');
    report.db = { exists: false, path };
  } else {
    let db: Db | null = null;
    try {
      db = openDb(cfg.dataDir);
      const v = schemaVersion(db);
      lines.push(`База: в порядке, схема ${v} — ${path}`);
      const row = getSnapshot(db);
      const t = now();
      if (!row) {
        lines.push('Снимок: ещё не приходил');
        warnings.push('снимка нет');
      } else {
        const age = Math.floor((t - row.receivedAt) / 1000);
        const stale = age > cfg.staleSec;
        lines.push(`Снимок: получен ${ago(row.receivedAt, t)} назад (${when(row.receivedAt)}), ${Math.round(row.size / 1024)} КБ — ${stale ? 'УСТАРЕЛ' : 'свежий'}`);
        if (stale) warnings.push('снимок устарел');
      }
      const totp = getTotp(db);
      lines.push(`Второй фактор: ${totp ? `подключён ${when(totp.enrolledAt)}` : 'не подключён — подключится при первом входе'}`);
      const sessions = listSessions(db, t).length;
      lines.push(`Сессии: ${sessions}`);
      const lastBackup = kvGet(db, 'last_backup');
      const lb = lastBackup ? (JSON.parse(lastBackup) as { at: string; file: string; sizeBytes: number }) : null;
      lines.push(`Копия: ${lb ? `${lb.file}, ${when(lb.at)}` : 'ещё не делалась'} (всего копий: ${listBackups(cfg.dataDir).length})`);
      report.db = { exists: true, path, schema: v };
      report.snapshot = row ? { receivedAt: new Date(row.receivedAt).toISOString(), ageSec: Math.floor((t - row.receivedAt) / 1000), sizeBytes: row.size } : null;
      report.totp = { enrolled: totp !== null, enrolledAt: totp ? new Date(totp.enrolledAt).toISOString() : null };
      report.sessions = sessions;
      report.backup = lb;
    } catch (e) {
      lines.push(`База: ОШИБКА — ${(e as Error).message}`);
      problems.push('база недоступна');
    } finally {
      db?.close();
    }
  }

  if (cfg.port !== 0) {
    const host = cfg.host === '0.0.0.0' || cfg.host === '::' ? '127.0.0.1' : cfg.host;
    const url = `http://${host.includes(':') ? `[${host}]` : host}:${cfg.port}/health`;
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(3000) });
      const j = (await r.json()) as { ok?: boolean; snapshotAgeSec?: number | null };
      lines.push(`Сервис: отвечает (${url})${j.snapshotAgeSec !== null && j.snapshotAgeSec !== undefined ? `, снимку ${j.snapshotAgeSec} с` : ''}`);
      report.service = { running: true, url };
    } catch {
      lines.push(`Сервис: не отвечает на ${url} — не запущен или другой порт`);
      warnings.push('сервис не отвечает');
      report.service = { running: false, url };
    }
  }

  if (!cfg.tg) {
    lines.push('Telegram: не настроен — тревоги и сводка не отправляются (PULT_TG_TOKEN, PULT_TG_CHAT_ID)');
    warnings.push('Telegram не настроен');
    report.telegram = { configured: false };
  } else {
    // Базы может ещё не быть — тогда getMe проверяем на временной базе в памяти, ничего не создавая на диске.
    let db: Db;
    if (existsSync(path)) db = openDb(cfg.dataDir);
    else {
      db = new DatabaseSync(':memory:');
      migrate(db);
    }
    try {
      const tg = createTelegram({ tg: cfg.tg, db, log: silentLog, fetchFn: io.fetchFn });
      const me = await tg.getMe();
      const st = tg.status();
      if (me.ok) lines.push(`Telegram: бот @${me.username} доступен, чат ${cfg.tg.chatId}`);
      else {
        lines.push(`Telegram: ОШИБКА — ${me.error}`);
        problems.push('Telegram недоступен');
      }
      if (st.lastError) lines.push(`  последняя ошибка отправки: ${st.lastError}`);
      if (st.lastSentAt) lines.push(`  последняя отправка: ${when(st.lastSentAt)}`);
      report.telegram = { configured: true, chatId: cfg.tg.chatId, getMe: me, lastError: st.lastError, lastSentAt: st.lastSentAt };
    } finally {
      db.close();
    }
  }

  const ok = problems.length === 0;
  if (asJson) {
    out(JSON.stringify({ ok, problems, warnings, ...report }));
  } else {
    for (const l of lines) out(l);
    out(ok ? `Итог: работает${warnings.length ? `, но обрати внимание: ${warnings.join(', ')}` : ', всё в порядке'}` : `Итог: есть ошибки — ${problems.join(', ')}`);
  }
  return ok ? 0 : 1;
}
