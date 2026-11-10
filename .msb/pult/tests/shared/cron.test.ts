import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CronError, cronBetween, cronNext, cronText, isValidTimeZone, parseCron, tzOffsetMs, zonedParts, zonedToUtc } from '../../src/shared/cron.ts';

const MSK = 'Europe/Moscow';
const at = (s: string) => new Date(s).getTime();
const isoList = (ds: Date[]) => ds.map(d => d.toISOString());

test('разбор: *, */n, a-b, a-b/n, a/n, списки, 7 — воскресенье', () => {
  const s = parseCron('*/15 9-17/4 1,15 * 1-5');
  assert.deepEqual(s.minutes, [0, 15, 30, 45]);
  assert.deepEqual(s.hours, [9, 13, 17]);
  assert.deepEqual(s.days, [1, 15]);
  assert.equal(s.months.length, 12);
  assert.deepEqual(s.weekdays, [1, 2, 3, 4, 5]);
  assert.equal(s.dayStar, false);
  assert.equal(s.weekdayStar, false);
  assert.deepEqual(parseCron('20 0/3 * * *').hours, [0, 3, 6, 9, 12, 15, 18, 21]);
  assert.deepEqual(parseCron('0 0 * * 7').weekdays, [0]);
  assert.deepEqual(parseCron('0 0 * * 5-7').weekdays, [0, 5, 6]);
  assert.equal(parseCron('  0   8 * * *  ').source, '0 8 * * *');
});

test('разбор: понятные ошибки', () => {
  assert.throws(() => parseCron('0 8 * *'), (e: Error) => e instanceof CronError && /5 полей/.test(e.message));
  assert.throws(() => parseCron('60 * * * *'), /минуты.*вне диапазона/);
  assert.throws(() => parseCron('0 25 * * *'), /часы/);
  assert.throws(() => parseCron('0 8 * * MON'), /не понимаю поле «день недели»/);
  assert.throws(() => parseCron('*/0 * * * *'), /шаг/);
  assert.throws(() => parseCron('5-1 * * * *'), /вне диапазона/);
});

test('часовой пояс: Москва +3, настенное время туда и обратно', () => {
  assert.equal(tzOffsetMs(at('2026-10-29T10:45:00Z'), MSK), 3 * 3600_000);
  assert.equal(tzOffsetMs(at('2026-10-29T10:45:00Z'), 'UTC'), 0);
  const p = zonedParts(at('2026-10-29T21:30:00Z'), MSK);
  assert.deepEqual([p.y, p.mo, p.d, p.h, p.mi, p.dow], [2026, 10, 30, 0, 30, 5]);
  assert.equal(new Date(zonedToUtc(2026, 10, 30, 0, 30, MSK)).toISOString(), '2026-10-29T21:30:00.000Z');
  assert.equal(isValidTimeZone('Europe/Moscow'), true);
  assert.equal(isValidTimeZone('Mars/Olympus'), false);
});

test('следующее срабатывание по Москве', () => {
  assert.equal(cronNext('0 * * * *', new Date('2026-10-29T10:45:00Z'), MSK)?.toISOString(), '2026-10-29T11:00:00.000Z');
  // ровно в момент срабатывания — следующее, а не текущее
  assert.equal(cronNext('0 * * * *', new Date('2026-10-29T11:00:00Z'), MSK)?.toISOString(), '2026-10-29T12:00:00.000Z');
  // 08:00 МСК уже прошло (сейчас 09:00 МСК) — завтра в 05:00 UTC
  assert.equal(cronNext('0 8 * * *', new Date('2026-10-29T06:00:00Z'), MSK)?.toISOString(), '2026-10-30T05:00:00.000Z');
  // по будням: 29.10.2026 — четверг; после 09:00 пятницы — понедельник 02.11
  assert.equal(cronNext('0 9 * * 1-5', new Date('2026-10-30T07:00:00Z'), MSK)?.toISOString(), '2026-11-02T06:00:00.000Z');
  assert.equal(cronNext('0 0 31 2 *', new Date('2026-10-29T00:00:00Z'), MSK), null);
});

test('все срабатывания в интервале: [from, to)', () => {
  const day = cronBetween('0 * * * *', at('2026-10-28T10:45:00Z'), at('2026-10-29T10:45:00Z'), MSK);
  assert.equal(day.length, 24);
  assert.equal(day[0].toISOString(), '2026-10-28T11:00:00.000Z');
  assert.equal(day[23].toISOString(), '2026-10-29T10:00:00.000Z');
  assert.deepEqual(isoList(cronBetween('*/15 * * * *', at('2026-10-29T10:00:00Z'), at('2026-10-29T11:00:00Z'), MSK)),
    ['2026-10-29T10:00:00.000Z', '2026-10-29T10:15:00.000Z', '2026-10-29T10:30:00.000Z', '2026-10-29T10:45:00.000Z']);
  assert.deepEqual(cronBetween('0 * * * *', at('2026-10-29T10:00:00Z'), at('2026-10-29T10:00:00Z'), MSK), []);
  // 30 дней почасовой задачи — 720 слотов, быстро
  const t0 = performance.now();
  assert.equal(cronBetween('0 * * * *', at('2026-09-29T10:45:00Z'), at('2026-10-29T10:45:00Z'), MSK).length, 720);
  assert.ok(performance.now() - t0 < 500);
});

test('день месяца ИЛИ день недели, если ограничены оба', () => {
  // 13-е число или пятница, ноябрь 2026: пятницы 6, 13, 20, 27 и 13-е (тоже пятница)
  const fires = cronBetween('0 12 13 * 5', at('2026-11-01T00:00:00Z'), at('2026-12-01T00:00:00Z'), 'UTC').map(d => d.getUTCDate());
  assert.deepEqual(fires, [6, 13, 20, 27]);
  // только день недели ограничен — И (то есть просто по пятницам)
  assert.equal(cronBetween('0 12 * * 5', at('2026-11-01T00:00:00Z'), at('2026-12-01T00:00:00Z'), 'UTC').length, 4);
  // */2 в дне месяца начинается со звезды — правило И
  assert.deepEqual(cronBetween('0 12 */10 * 5', at('2026-11-01T00:00:00Z'), at('2026-12-01T00:00:00Z'), 'UTC').map(d => d.getUTCDate()), []);
});

test('перевод часов: Берлин 25.10.2026 и Нью-Йорк 08.03.2026', () => {
  // до перевода 03:00 CEST = 01:00 UTC, после — 03:00 CET = 02:00 UTC
  assert.deepEqual(isoList(cronBetween('0 3 * * *', at('2026-10-24T00:00:00Z'), at('2026-10-27T00:00:00Z'), 'Europe/Berlin')),
    ['2026-10-24T01:00:00.000Z', '2026-10-25T02:00:00.000Z', '2026-10-26T02:00:00.000Z']);
  // 02:30 8 марта в Нью-Йорке не существует — срабатывание сдвигается, но не теряется и не дублируется
  const ny = cronBetween('30 2 * * *', at('2026-03-07T00:00:00Z'), at('2026-03-10T00:00:00Z'), 'America/New_York');
  assert.equal(ny.length, 3);
  assert.ok(ny.every((d, i) => i === 0 || d > ny[i - 1]));
});

test('текст: как на панели', () => {
  assert.equal(cronText('0 * * * *'), 'каждый час');
  assert.equal(cronText('0 */2 * * *'), 'каждые 2 ч');
  assert.equal(cronText('5 */2 * * *'), 'каждые 2 ч');
  assert.equal(cronText('20 0/3 * * *'), 'каждые 3 ч');
  assert.equal(cronText('*/30 * * * *'), 'каждые 30 мин');
  assert.equal(cronText('0,30 * * * *'), 'каждые 30 мин');
  assert.equal(cronText('* * * * *'), 'каждую минуту');
  assert.equal(cronText('0 8 * * *'), 'ежедневно 08:00');
  assert.equal(cronText('0 9,16 * * *'), 'ежедневно 09:00 и 16:00');
  assert.equal(cronText('0 9 * * 1-5'), 'по будням 09:00');
  assert.equal(cronText('0 9 * * 1'), 'по понедельникам 09:00');
  assert.equal(cronText('0 9 * * 0'), 'по воскресеньям 09:00');
  assert.equal(cronText('0 10 * * 6,0'), 'по выходным 10:00');
  assert.equal(cronText('0 9 * * 1,3,5'), 'пн, ср, пт 09:00');
  assert.equal(cronText('0 * * * 1-5'), 'по будням каждый час');
});

test('текст: чего не сказать словами — сам cron', () => {
  assert.equal(cronText('0 0 1 * *'), '0 0 1 * *');
  assert.equal(cronText('0 9 * 1 *'), '0 9 * 1 *');
  assert.equal(cronText('7,9,11 9-18 * * *'), '7,9,11 9-18 * * *');
  assert.equal(cronText('мусор'), 'мусор');
});

test('текст: пересчёт пояса и «~» для случайной задержки', () => {
  const now = new Date('2026-10-29T10:45:00Z');
  assert.equal(cronText('0 3 * * *', { tz: 'Etc/UTC', displayTz: MSK, approx: true, now }), 'ежедневно ~06:00');
  assert.equal(cronText('0 22 * * *', { tz: 'Etc/UTC', displayTz: MSK, now }), 'ежедневно 01:00');
  assert.equal(cronText('0 8 * * *', { tz: MSK, displayTz: MSK, now }), 'ежедневно 08:00');
  // по будням 22:00 UTC — это уже другой день недели по Москве: честно показываем cron и пояс
  assert.equal(cronText('0 22 * * 1-5', { tz: 'Etc/UTC', displayTz: MSK, now }), '0 22 * * 1-5 (Etc/UTC)');
  assert.equal(cronText('0 6 * * 1-5', { tz: 'Etc/UTC', displayTz: MSK, now }), 'по будням 09:00');
  // шаг по часам от пояса не зависит
  assert.equal(cronText('20 0/3 * * *', { tz: 'Etc/UTC', displayTz: MSK, approx: true, now }), 'каждые 3 ч');
});
