import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { copyFileSync, existsSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { runAdmin } from '../../src/server/admin-cli.ts';
import { createSession, enrollTotp, getTotp } from '../../src/server/auth.ts';
import { acquirePidFile, autoBackupDue, backupsDir, inspectDbFile, makeBackup, pidFile, releasePidFile, serviceRunning } from '../../src/server/backup.ts';
import { kvGet, kvSet, openDb } from '../../src/server/db.ts';
import { silentLog } from '../../src/server/log.ts';
import { startService } from '../../src/server/service.ts';
import { storeSnapshot } from '../../src/server/snapshot.ts';
import { generateSecret, totpAt } from '../../src/server/totp.ts';
import { config, env, fakeTelegram, fixture, INGEST_TOKEN, PASSWORD, TG_TOKEN, tmpDir } from './helpers.ts';

const NOW = Date.UTC(2026, 9, 30, 5, 0, 0); // 30.10 08:00 МСК

async function admin(argv: string[], o: { env: Record<string, string | undefined>; fetchFn?: typeof fetch; now?: number }) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runAdmin(argv, { env: o.env, out: s => out.push(s), err: s => err.push(s), fetchFn: o.fetchFn, now: () => o.now ?? NOW });
  const all = [...out, ...err].join('\n');
  for (const secret of [PASSWORD, INGEST_TOKEN, TG_TOKEN]) assert.ok(!all.includes(secret), `секрет в выводе команды ${argv.join(' ')}`);
  return { code, out: out.join('\n'), err: err.join('\n') };
}

function seeded(t: TestContext) {
  const dir = tmpDir(t);
  const db = openDb(dir);
  storeSnapshot(db, fixture(), NOW - 60_000);
  db.close();
  return { dir, env: env(dir) };
}

test('admin: справка, неизвестная команда, ошибка настроек', async t => {
  const dir = tmpDir(t);
  const help = await admin(['--help'], { env: env(dir) });
  assert.equal(help.code, 0);
  assert.match(help.out, /reset-2fa --yes/);
  assert.match(help.out, /restore <ГГГГ-ММ-ДД> --yes/);
  assert.equal((await admin([], { env: env(dir) })).code, 2);
  const unknown = await admin(['fly'], { env: env(dir) });
  assert.equal(unknown.code, 2);
  assert.match(unknown.err, /Неизвестная команда «fly»/);
  const bad = await admin(['check'], { env: env(dir, { PULT_PASSWORD: 'short' }) });
  assert.equal(bad.code, 1);
  assert.match(bad.err, /^Настройки: PULT_PASSWORD: пароль короче 12 символов$/);
  const badJson = await admin(['check', '--json'], { env: env(dir, { PULT_INGEST_TOKEN: undefined }) });
  assert.equal(JSON.parse(badJson.out).ok, false);
});

test('admin check: база, снимок, Telegram getMe без отправки сообщений', async t => {
  const empty = tmpDir(t);
  const tg = fakeTelegram();
  const none = await admin(['check'], { env: env(join(empty, 'data')), fetchFn: tg.fetchFn });
  assert.equal(none.code, 0);
  assert.match(none.out, /База: ещё не создана/);
  assert.equal(existsSync(join(empty, 'data', 'pult.db')), false, 'check не создаёт базу');
  assert.match(none.out, /Telegram: бот @pult_test_bot доступен/);

  const { env: e } = seeded(t);
  const ok = await admin(['check'], { env: e, fetchFn: tg.fetchFn });
  assert.equal(ok.code, 0, ok.out);
  assert.match(ok.out, /База: в порядке, схема 1/);
  assert.match(ok.out, /Снимок: получен 1 мин назад \(30\.10\.2026 07:59\), \d+ КБ — свежий/);
  assert.match(ok.out, /Второй фактор: не подключён/);
  assert.match(ok.out, /Итог: работает/);
  assert.deepEqual(tg.calls.map(c => c.method), ['getMe', 'getMe'], 'только getMe, без сообщений');

  const stale = await admin(['check'], { env: e, fetchFn: tg.fetchFn, now: NOW + 3_600_000 });
  assert.match(stale.out, /УСТАРЕЛ/);
  assert.equal(stale.code, 0, 'устаревший снимок — предупреждение, не ошибка');

  const broken = fakeTelegram(() => ({ status: 401, body: { ok: false, description: 'Unauthorized' } }));
  const bad = await admin(['check', '--json'], { env: e, fetchFn: broken.fetchFn });
  assert.equal(bad.code, 1);
  const j = JSON.parse(bad.out);
  assert.equal(j.ok, false);
  assert.deepEqual(j.problems, ['Telegram недоступен']);
  assert.match(j.telegram.getMe.error, /неверный токен/);
  assert.equal(j.config.port, 0);
  assert.equal(j.snapshot.ageSec, 60);
});

test('admin: сессии, сброс второго фактора, проверочное сообщение, текст сводки', async t => {
  const { dir, env: e } = seeded(t);
  const db = openDb(dir);
  const secret = generateSecret();
  enrollTotp(db, secret, totpAt(secret, Date.now()), Date.now());
  createSession(db, 'full', Date.now(), 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) Safari/604.1', '203.0.113.5');
  db.close();

  const list = await admin(['sessions'], { env: e, now: Date.now() });
  assert.match(list.out, /^• Safari · iOS, IP 203\.0\.113\.5 — вход /);
  const listJson = JSON.parse((await admin(['sessions', '--json'], { env: e, now: Date.now() })).out);
  assert.equal(listJson.length, 1);
  assert.equal(listJson[0].device, 'Safari · iOS');

  assert.equal((await admin(['sessions', 'clear'], { env: e })).code, 2, 'без --yes не делает');
  assert.equal((await admin(['reset-2fa'], { env: e })).code, 2, 'без --yes не делает');
  const tg = fakeTelegram();
  const reset = await admin(['reset-2fa', '--yes'], { env: e, fetchFn: tg.fetchFn });
  assert.equal(reset.code, 0);
  assert.match(reset.out, /Второй фактор сброшен; сессий завершено: 1/);
  assert.match(tg.texts()[0], /Второй фактор входа в Пульт сброшен/);
  const db2 = openDb(dir);
  assert.equal(getTotp(db2), null);
  createSession(db2, 'full', Date.now(), null, null);
  db2.close();
  const cleared = await admin(['sessions', 'clear', '--yes'], { env: e });
  assert.match(cleared.out, /Сессии завершены: 1/);

  const test1 = await admin(['send-test'], { env: e, fetchFn: tg.fetchFn });
  assert.equal(test1.code, 0);
  assert.equal(tg.texts().at(-1), '🟢 От тебя ничего не нужно\n\nПроверка связи Пульта — кнопка ниже открывает панель как мини-приложение');
  assert.ok(tg.calls.some(c => c.method === 'setChatMenuButton'), 'send-test обновляет кнопку меню Mini App');
  const fail = fakeTelegram(() => ({ status: 403, body: { ok: false, description: "Forbidden: bot can't initiate conversation with a user" } }));
  const test2 = await admin(['send-test'], { env: e, fetchFn: fail.fetchFn });
  assert.equal(test2.code, 1);
  assert.match(test2.err, /Открой бота уведомлений и нажми «Старт»/);
  const noTg = await admin(['send-test'], { env: { ...e, PULT_TG_TOKEN: undefined } });
  assert.equal(noTg.code, 1);

  const sum = await admin(['summary', '--print'], { env: e });
  assert.equal(sum.code, 0);
  assert.match(sum.out, /^🔴 Нужно от тебя: 2 решения, посмотреть тревоги\n\n<b>Сводка Пульта, 30\.10<\/b>/);
  assert.equal((await admin(['summary'], { env: e })).code, 2);
});

test('копии: файл за день, проверка, ротация 14, автокопия после 04:00', async t => {
  const { dir, env: e } = seeded(t);
  const r = await admin(['backup'], { env: e });
  assert.equal(r.code, 0, r.err);
  const file = join(backupsDir(dir), '2026-10-30.db');
  assert.ok(existsSync(file));
  const info = inspectDbFile(file);
  assert.equal(info.ok, true);
  assert.equal(info.schema, 1);
  assert.ok(info.snapshotReceivedAt);
  assert.equal((await admin(['backup'], { env: e })).code, 0, 'повтор в тот же день — заменяет');
  assert.deepEqual(readdirSync(backupsDir(dir)), ['2026-10-30.db'], 'временных файлов не осталось');

  for (let d = 1; d <= 16; d++) copyFileSync(file, join(backupsDir(dir), `2026-09-${String(d).padStart(2, '0')}.db`));
  await admin(['backup'], { env: e });
  const files = readdirSync(backupsDir(dir)).sort();
  assert.equal(files.length, 14);
  assert.equal(files[0], '2026-09-04.db');
  assert.equal(files.at(-1), '2026-10-30.db');

  writeFileSync(join(dir, 'broken.db'), 'это не база');
  assert.equal(inspectDbFile(join(dir, 'broken.db')).ok, false);
  assert.equal(inspectDbFile(join(dir, 'nope.db')).error, 'файла нет');

  assert.equal(autoBackupDue(Date.UTC(2026, 9, 30, 0, 59), 'Europe/Moscow', null, 3), false, '03:59 — рано');
  assert.equal(autoBackupDue(Date.UTC(2026, 9, 30, 1, 0), 'Europe/Moscow', '2026-10-29', 4), true);
  assert.equal(autoBackupDue(Date.UTC(2026, 9, 30, 1, 0), 'Europe/Moscow', '2026-10-30', 4), false);

  // Автокопия в сервисе: первый проход после 04:00.
  const dir2 = tmpDir(t);
  const clock = { t: Date.UTC(2026, 9, 30, 0, 50) };
  const svc = await startService(config(dir2), { log: silentLog, timers: false, now: () => clock.t });
  t.after(() => svc.close());
  svc.backupTick();
  assert.equal(existsSync(backupsDir(dir2)), false);
  clock.t = Date.UTC(2026, 9, 30, 1, 5);
  svc.backupTick();
  assert.ok(existsSync(join(backupsDir(dir2), '2026-10-30.db')));
  assert.equal(kvGet(svc.db, 'backup_auto_date'), '2026-10-30');
});

test('восстановление: показ копии, отказ при работающем сервисе, замена с сохранением текущей базы', async t => {
  const { dir, env: e } = seeded(t);
  const db = openDb(dir);
  makeBackup(db, dir, NOW, 'Europe/Moscow');
  kvSet(db, 'marker', 'после копии');
  db.close();

  const list = await admin(['restore'], { env: e });
  assert.match(list.out, /• 2026-10-30/);
  const show = await admin(['restore', '2026-10-30'], { env: e });
  assert.equal(show.code, 0);
  assert.match(show.out, /проверка целостности пройдена/);
  assert.match(show.out, /повтори с --yes/);
  assert.equal((await admin(['restore', '30.10.2026'], { env: e })).code, 2);
  assert.equal((await admin(['restore', '2026-01-01', '--yes'], { env: e })).code, 1, 'нет такой копии');

  // «Сервис»: живой процесс, в командной строке которого есть server/main.ts.
  const fakeService = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)', 'src/server/main.ts'], { stdio: 'ignore' });
  t.after(() => fakeService.kill());
  writeFileSync(pidFile(dir), `${fakeService.pid}\n`);
  const refused = await admin(['restore', '2026-10-30', '--yes'], { env: e });
  assert.equal(refused.code, 1);
  assert.match(refused.err, /Восстановление отменено: запущен процесс сервиса/);
  assert.throws(() => acquirePidFile(dir), /уже запущен/, 'второй экземпляр на те же данные не стартует');
  fakeService.kill();
  await new Promise(r => fakeService.once('exit', r));

  // pid-файл после аварии, а номер достался чужому живому процессу: это не сервис, старт не блокируется.
  const stranger = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'ignore' });
  t.after(() => stranger.kill());
  writeFileSync(pidFile(dir), `${stranger.pid}\n`);
  assert.equal(await serviceRunning(dir, '127.0.0.1', 0), null);
  acquirePidFile(dir);
  stranger.kill();
  releasePidFile(dir);
  assert.equal(existsSync(pidFile(dir)), false);

  const done = await admin(['restore', '2026-10-30', '--yes'], { env: e });
  assert.equal(done.code, 0, done.err);
  assert.match(done.out, /База восстановлена из 2026-10-30/);
  const db2 = openDb(dir);
  assert.equal(kvGet(db2, 'marker'), null, 'база — из копии');
  db2.close();
  const saved = readdirSync(backupsDir(dir)).find(f => f.startsWith('before-restore-'));
  assert.ok(saved, 'прежняя база сохранена');
  const { DatabaseSync } = await import('node:sqlite');
  const old = new DatabaseSync(join(backupsDir(dir), saved!), { readOnly: true });
  assert.equal((old.prepare("SELECT value FROM kv WHERE key = 'marker'").get() as { value: string }).value, 'после копии');
  old.close();
});
