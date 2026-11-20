import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildTimerTask, mergeLastRun, serviceRun, statusFileRun } from '../../src/collector/sources/timers.ts';
import { parseJournalRuns, parseShow, prop } from '../../src/collector/sources/systemd.ts';
import { BACKUP_JOURNAL, FIX, NOW, fixtureConfig, showOutput } from './helpers.ts';

const units = new Map(parseShow(showOutput(['xcollect.timer', 'xcollect.service', 'backup.timer', 'backup.service', 'gone.timer'])).map(b => [prop(b, 'Id'), b]));
const xstatus = JSON.parse(readFileSync(join(FIX, 'x-status.json'), 'utf8'));
const base = { serverTz: 'Etc/UTC', displayTz: 'Europe/Moscow', missedRunsWarn: 3, now: NOW };

test('файл состояния скрипта: итог «29 постов · $0,005» или ошибка', () => {
  assert.deepEqual(statusFileRun(xstatus), { at: '2026-10-29T10:18:14.036Z', status: 'ok', durationSec: 0, tokens: 0, helpers: 0, usd: null, detail: '29 постов · $0,005' });
  assert.deepEqual(statusFileRun({ state: 'error', last_run: '2026-10-29T10:00:00Z', last_error: 'Apify: 402 Payment Required' })?.detail, 'Apify: 402 Payment Required');
  assert.equal(statusFileRun({ state: 'ok' }), null);
  assert.equal(statusFileRun(null), null);
});

test('ход по службе: успех, ошибка, ещё не запускалась, идёт сейчас', () => {
  assert.deepEqual(serviceRun(units.get('backup.service')), { at: '2026-10-29T03:08:14.000Z', status: 'ok', durationSec: 228, tokens: 0, helpers: 0, usd: null, detail: null });
  assert.equal(serviceRun(units.get('xcollect.service')), null);
  const failed = parseShow('Id=x.service\nResult=exit-code\nExecMainStartTimestamp=Thu 2026-10-29 03:00:00 UTC\nExecMainExitTimestamp=Thu 2026-10-29 03:00:05 UTC\nActiveState=failed\n')[0];
  assert.deepEqual(serviceRun(failed), { at: '2026-10-29T03:00:00.000Z', status: 'error', durationSec: 5, tokens: 0, helpers: 0, usd: null, detail: 'результат: exit-code' });
  const running = parseShow('Id=x.service\nResult=success\nExecMainStartTimestamp=Thu 2026-10-29 03:00:00 UTC\nActiveState=activating\n')[0];
  assert.equal(serviceRun(running), null);
});

test('ход службы и файла состояния — один ход, если рядом по времени', () => {
  const svc = { at: '2026-10-29T10:18:00.000Z', status: 'ok' as const, durationSec: 20, tokens: 0, helpers: 0, usd: null, detail: null };
  const file = statusFileRun(xstatus);
  assert.deepEqual(mergeLastRun(svc, file), { ...svc, detail: '29 постов · $0,005' });
  assert.equal(mergeLastRun(null, file), file);
  assert.equal(mergeLastRun(svc, null), svc);
  const old = { ...svc, at: '2026-10-29T03:00:00.000Z' };
  assert.equal(mergeLastRun(old, file), file, 'далеко по времени — берём более свежий');
});

test('таймер без журнала: последний ход из файла состояния, ожидаемых ходов не считаем', () => {
  const cfg = fixtureConfig().timers[0];
  const { task, findings } = buildTimerTask({ ...base, cfg, botName: 'Бета', timer: units.get('xcollect.timer'), service: units.get('xcollect.service'), journal: [], statusData: xstatus });
  assert.match(task.id, /^[0-9a-f]{10}$/);
  assert.equal(task.kind, 'timer');
  assert.equal(task.noAi, true);
  assert.equal(task.bot, 'beta');
  assert.equal(task.botName, 'Бета');
  assert.deepEqual(task.schedule, { type: 'cron', cron: '20 0/3 * * *', timezone: 'Etc/UTC', text: 'каждые 3 ч' });
  assert.equal(task.lastRun?.detail, '29 постов · $0,005');
  assert.equal(task.nextRunAt, '2026-10-29T12:22:12.000Z');
  assert.equal(task.stats24h.expected, null);
  assert.equal(task.stats24h.runs, 1);
  assert.deepEqual(task.slots24h, ['ok']);
  assert.equal(task.runs.length, 1);
  assert.deepEqual(task.gaps, []);
  assert.deepEqual(findings, []);
  assert.equal(task.attention, null);
});

test('таймер с журналом: ходы, слоты и время «~06:00» по Москве', () => {
  const cfg = fixtureConfig().timers[1];
  const { task } = buildTimerTask({ ...base, cfg, botName: 'Сервер', timer: units.get('backup.timer'), service: units.get('backup.service'), journal: parseJournalRuns(BACKUP_JOURNAL), statusData: null });
  assert.equal(task.schedule.text, 'ежедневно ~06:00');
  assert.equal(task.runs.length, 2);
  assert.equal(task.lastRun?.at, '2026-10-29T03:08:14.000Z');
  assert.equal(task.stats24h.expected, 1);
  assert.deepEqual(task.slots24h, ['ok']);
  assert.equal(task.nextRunAt, '2026-10-30T03:16:19.000Z');
});

test('таймер не установлен или выключен, последний ход с ошибкой — требует внимания', () => {
  const cfg = fixtureConfig().timers[1];
  const gone = buildTimerTask({ ...base, cfg, botName: 'Сервер', timer: units.get('gone.timer'), service: undefined, journal: [], statusData: null });
  assert.equal(gone.task.attention, 'crit');
  assert.equal(gone.task.attentionText, 'таймер не установлен');
  assert.equal(gone.task.nextRunAt, null);
  const off = parseShow('Id=backup.timer\nLoadState=loaded\nActiveState=inactive\n')[0];
  assert.equal(buildTimerTask({ ...base, cfg, botName: 'Сервер', timer: off, service: undefined, journal: [], statusData: null }).task.attentionText, 'таймер выключен (состояние: inactive)');
  const failedSvc = parseShow('Id=backup.service\nResult=exit-code\nExecMainStartTimestamp=Thu 2026-10-29 03:08:14 UTC\nExecMainExitTimestamp=Thu 2026-10-29 03:08:20 UTC\nActiveState=failed\n')[0];
  const failed = buildTimerTask({ ...base, cfg, botName: 'Сервер', timer: units.get('backup.timer'), service: failedSvc, journal: [], statusData: null });
  assert.equal(failed.task.attention, 'crit');
  assert.equal(failed.task.attentionText, 'последний ход закончился ошибкой: результат: exit-code');
});

test('монотонный таймер (OnUnitActiveSec): «следующий» — от последнего срабатывания', () => {
  const cfg = { ...fixtureConfig().timers[0]!, statusFile: null };
  const [timer] = parseShow([
    'Id=health.timer', 'LoadState=loaded', 'ActiveState=active', 'NextElapseUSecRealtime=',
    'LastTriggerUSec=Thu 2026-10-29 11:58:00 UTC',
    'TimersMonotonic={ OnUnitActiveUSec=5min ; next_elapse=21h 13min }', '',
  ].join('\n'));
  const { task } = buildTimerTask({ ...base, cfg, botName: 'Бета', timer, service: undefined, journal: [], statusData: null });
  assert.equal(task.schedule.type, 'interval');
  assert.equal(task.schedule.text, 'каждые 5 мин');
  assert.equal(task.nextRunAt, '2026-10-29T12:03:00.000Z');
});
