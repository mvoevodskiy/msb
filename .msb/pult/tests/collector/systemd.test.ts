import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import {
  intervalText, onCalendarToCron, parseJournalRuns, parseMemoryStat, parseShow, parseTimespanSec, prop, showUnits,
  systemdTime, timerEntry, timerSchedule, unitHealth,
} from '../../src/collector/sources/systemd.ts';
import { BACKUP_JOURNAL, FIX, NOW, UNITS, fakeExec, showOutput } from './helpers.ts';

const CG = join(FIX, 'cgroup');

test('systemctl show: блоки через пустую строку, свойства по ключам, повторы — списком', () => {
  const blocks = parseShow(`Id=a.timer
TimersCalendar={ OnCalendar=*-*-* 03:00:00 ; next_elapse=n/a }
TimersCalendar={ OnCalendar=Mon *-*-* 09:00:00 ; next_elapse=n/a }
Description=Значение=с равенством

Result=success
Id=b.service
`);
  assert.equal(blocks.length, 2);
  assert.equal(prop(blocks[0], 'Id'), 'a.timer');
  assert.equal(blocks[0].TimersCalendar.length, 2);
  assert.equal(prop(blocks[0], 'Description'), 'Значение=с равенством');
  assert.equal(prop(blocks[1], 'Id'), 'b.service');
  assert.equal(prop(blocks[1], 'Нет'), '');
});

test('один вызов systemctl на все юниты; порядок блоков — порядок аргументов', async () => {
  const exec = fakeExec();
  const m = await showUnits(exec, ['heavy.service', 'opt.service', 'heavy.service']);
  assert.equal(exec.calls.length, 1);
  assert.equal(exec.calls[0].args.filter(a => !a.startsWith('-') && !/^[A-Z]/.test(a)).length, 3, 'дубли убраны: show + 2 юнита');
  assert.equal(prop(m.get('heavy.service'), 'ActiveState'), 'active');
  assert.equal(prop(m.get('opt.service'), 'LoadState'), 'not-found');
  // число блоков не совпало — сопоставляем по Id
  const odd = fakeExec({ systemctl: () => ({ code: 0, stdout: showOutput(['web.service']), stderr: '', error: null }) });
  const m2 = await showUnits(odd, ['x.service', 'web.service']);
  assert.equal(prop(m2.get('web.service'), 'ActiveState'), 'active');
  const bad = fakeExec({ systemctl: () => ({ code: 1, stdout: '', stderr: 'Failed to connect to bus', error: 'Failed to connect to bus' }) });
  await assert.rejects(showUnits(bad, ['x.service']), /Failed to connect to bus/);
  assert.equal((await showUnits(exec, [])).size, 0);
});

test('время systemd → ISO', () => {
  assert.equal(systemdTime('Wed 2026-10-28 20:25:21 UTC'), '2026-10-28T20:25:21.000Z');
  assert.equal(systemdTime('Thu 2026-10-29 12:22:12.123456 UTC'), '2026-10-29T12:22:12.123Z');
  assert.equal(systemdTime(''), null);
  assert.equal(systemdTime('n/a'), null);
  assert.equal(systemdTime('0'), null);
  assert.equal(systemdTime('Wed 2026-10-28 23:25:21 MSK'), null, 'чужой пояс не угадываем — запускаем с TZ=UTC');
});

test('memory.stat: anon + kernel, без файлового кэша', () => {
  assert.equal(parseMemoryStat('anon 100\nfile 5000\nkernel 20\n'), 120);
  assert.equal(parseMemoryStat('anon 100\nfile 5000\n'), 100);
  assert.equal(parseMemoryStat('file 5000\n'), null);
});

test('здоровье юнита: память по cgroup, иначе MemoryCurrent; ядра — с момента запуска', () => {
  const units = new Map(parseShow(showOutput(['heavy.service', 'web.service', 'down.service', 'opt.service'])).map(b => [prop(b, 'Id'), b]));
  const heavy = unitHealth(units.get('heavy.service'), CG, NOW.getTime());
  assert.equal(heavy.state, 'active');
  assert.equal(heavy.memMb, 4505);
  assert.equal(heavy.cpuCores, 0.89);
  assert.equal(heavy.since, '2026-10-28T21:02:51.000Z');
  assert.equal(heavy.loaded, true);
  const web = unitHealth(units.get('web.service'), CG, NOW.getTime());
  assert.equal(web.memMb, 50);
  assert.equal(web.controlGroup, null);
  const down = unitHealth(units.get('down.service'), CG, NOW.getTime());
  assert.equal(down.state, 'failed');
  assert.equal(down.memMb, null);
  assert.equal(down.cpuCores, null, 'у остановленной службы ядра не считаем');
  assert.equal(down.since, '2026-10-29T09:30:00.000Z', 'для неработающей — когда сменилось состояние');
  const opt = unitHealth(units.get('opt.service'), CG, NOW.getTime());
  assert.equal(opt.loaded, false);
  assert.equal(opt.loadState, 'not-found');
  assert.equal(unitHealth(undefined, CG, NOW.getTime()).state, 'unknown');
});

test('промежутки systemd и интервалы словами', () => {
  assert.equal(parseTimespanSec('15min'), 900);
  assert.equal(parseTimespanSec('1h 30min'), 5400);
  assert.equal(parseTimespanSec('4h'), 14400);
  assert.equal(parseTimespanSec('30s'), 30);
  assert.equal(parseTimespanSec('0'), 0);
  assert.equal(parseTimespanSec('1d'), 86400);
  assert.equal(parseTimespanSec(''), null);
  assert.equal(parseTimespanSec('потом'), null);
  assert.equal(intervalText(900), 'каждые 15 мин');
  assert.equal(intervalText(3600), 'каждый час');
  assert.equal(intervalText(14400), 'каждые 4 ч');
  assert.equal(intervalText(86400), 'раз в сутки');
  assert.equal(intervalText(60), 'каждую минуту');
  assert.equal(intervalText(45), 'каждые 45 с');
});

test('OnCalendar → cron', () => {
  assert.deepEqual(onCalendarToCron('*-*-* 00/3:20:00'), { cron: '20 0/3 * * *', tz: null });
  assert.deepEqual(onCalendarToCron('*-*-* 03:00:00'), { cron: '0 3 * * *', tz: null });
  assert.deepEqual(onCalendarToCron('*-*-* *:00/30:00'), { cron: '0/30 * * * *', tz: null });
  assert.deepEqual(onCalendarToCron('Mon..Fri *-*-* 09:00:00'), { cron: '0 9 * * 1-5', tz: null });
  assert.deepEqual(onCalendarToCron('Sat,Sun *-*-* 10:00:00'), { cron: '0 10 * * 6,7', tz: null });
  assert.deepEqual(onCalendarToCron('*-*-* 06:00:00 Europe/Moscow'), { cron: '0 6 * * *', tz: 'Europe/Moscow' });
  assert.deepEqual(onCalendarToCron('*-*-* 08,20:15:00'), { cron: '15 8,20 * * *', tz: null });
  assert.equal(onCalendarToCron('*-*-01 03:00:00'), null, 'конкретные даты не поддержаны');
  assert.equal(onCalendarToCron('*-*-* 03:00:30'), null, 'секунды кроме 00 — нет');
  assert.equal(onCalendarToCron('Funday *-*-* 03:00:00'), null);
});

test('запись таймера «{ OnCalendar=… ; next_elapse=… }»', () => {
  assert.deepEqual(timerEntry('{ OnCalendar=*-*-* 00/3:20:00 ; next_elapse=Thu 2026-10-29 12:20:00 UTC }'), { key: 'OnCalendar', value: '*-*-* 00/3:20:00' });
  assert.deepEqual(timerEntry('{ OnUnitActiveUSec=15min ; next_elapse=15h 9min 55.08s }'), { key: 'OnUnitActiveUSec', value: '15min' });
  assert.equal(timerEntry('мусор'), null);
});

test('расписание таймера словами', () => {
  const opts = { serverTz: 'Etc/UTC', displayTz: 'Europe/Moscow', fallback: null, now: NOW };
  const units = new Map(parseShow(showOutput(['xcollect.timer', 'backup.timer'])).map(b => [prop(b, 'Id'), b]));
  assert.deepEqual(timerSchedule(units.get('xcollect.timer'), opts), { type: 'cron', cron: '20 0/3 * * *', timezone: 'Etc/UTC', text: 'каждые 3 ч' });
  assert.deepEqual(timerSchedule(units.get('backup.timer'), opts), { type: 'cron', cron: '0 3 * * *', timezone: 'Etc/UTC', text: 'ежедневно ~06:00' });
  const mono = parseShow('Id=t.timer\nTimersMonotonic={ OnUnitActiveUSec=15min ; next_elapse=1min }\nTimersMonotonic={ OnBootUSec=1min ; next_elapse=1min }\n')[0];
  assert.deepEqual(timerSchedule(mono, opts), { type: 'interval', everySec: 900, text: 'каждые 15 мин' });
  const odd = parseShow('Id=t.timer\nTimersCalendar={ OnCalendar=*-*-01 03:00:00 ; next_elapse=n/a }\n')[0];
  assert.deepEqual(timerSchedule(odd, { ...opts, fallback: 'раз в месяц' }), { type: 'cron', text: 'раз в месяц' });
  assert.deepEqual(timerSchedule(odd, opts), { type: 'cron', text: '*-*-01 03:00:00' });
  assert.deepEqual(timerSchedule(undefined, opts), { type: 'interval', text: 'по таймеру' });
});

test('ходы службы из журнала: только сообщения systemd', () => {
  const runs = parseJournalRuns(BACKUP_JOURNAL);
  assert.deepEqual(runs.map(r => [r.at, r.status, r.durationSec]), [
    ['2026-10-28T03:05:00.000Z', 'ok', 240],
    ['2026-10-29T03:08:14.000Z', 'ok', 228],
  ]);
  const us = (s: string) => String(Date.parse(s) * 1000);
  const failed = [
    { __REALTIME_TIMESTAMP: us('2026-10-29T03:00:00Z'), SYSLOG_IDENTIFIER: 'systemd', MESSAGE: 'Starting x.service...' },
    { __REALTIME_TIMESTAMP: us('2026-10-29T03:00:05Z'), SYSLOG_IDENTIFIER: 'systemd', MESSAGE: 'x.service: Main process exited, code=exited, status=1/FAILURE' },
    { __REALTIME_TIMESTAMP: us('2026-10-29T03:00:05Z'), SYSLOG_IDENTIFIER: 'systemd', MESSAGE: "x.service: Failed with result 'exit-code'." },
  ].map(e => JSON.stringify(e)).join('\n') + '\n{битая строка\n';
  assert.deepEqual(parseJournalRuns(failed).map(r => [r.status, r.durationSec, r.detail]), [['error', 5, 'код выхода 1/FAILURE']]);
  assert.deepEqual(parseJournalRuns(''), []);
});
