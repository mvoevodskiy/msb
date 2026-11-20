import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import type { Attention, Snapshot } from '../../src/shared/types.ts';
import { alertItemText, alertMessage, allAlerts, createAlerter, recoveryMessage, REMIND_MS, STALE_KEY, type AlertRow } from '../../src/server/alerts.ts';
import { openDb } from '../../src/server/db.ts';
import { silentLog } from '../../src/server/log.ts';
import { storeSnapshot } from '../../src/server/snapshot.ts';
import type { Notifier } from '../../src/server/telegram.ts';
import { config, fixture, tmpDir } from './helpers.ts';

const T0 = Date.UTC(2026, 9, 30, 5, 0, 0); // 08:00 МСК
const MIN = 60_000;

function fakeNotifier(configured = true) {
  const sent: { text: string; kind: string }[] = [];
  let fail = false;
  const n: Notifier & { sent: typeof sent; setFail(v: boolean): void } = {
    configured,
    sent,
    setFail(v) { fail = v; },
    async send(text, kind) {
      if (!configured) return { ok: false, skipped: true, error: null };
      if (fail) return { ok: false, skipped: false, error: 'Telegram недоступен' };
      sent.push({ text, kind });
      return { ok: true, skipped: false, error: null };
    },
    async setWebAppMenu() { return { ok: true, skipped: false, error: null }; },
    async getMe() { return { ok: true, username: 'x' }; },
    status() { return { configured, lastError: null, lastSentAt: null }; },
  };
  return n;
}

const att = (key: string, text: string, since: string | null = null, level: Attention['level'] = 'crit', project: string | null = null): Attention =>
  ({ key, level, text, project, link: { tab: 'overview' }, since });

test('текст тревоги: проект впереди, если есть', () => {
  assert.equal(alertItemText({ text: 'упала служба', project: null }), 'упала служба');
  assert.equal(alertItemText({ text: 'упала служба', project: 'zapcita' }), 'zapcita · упала служба');
});

test('тревога с проектом — в Telegram-тексте', async t => {
  const { notifier, snap } = setup(t);
  const row = att('task:x:error', 'задача упала', null, 'crit', 'zapcita');
  await snap(T0, [row]);
  await snap(T0 + 6 * MIN, [row]);
  assert.equal(notifier.sent.length, 1);
  assert.match(notifier.sent[0].text, /zapcita · задача упала/);
});

function setup(t: TestContext, o: { configured?: boolean; startedAt?: number } = {}) {
  const dir = tmpDir(t);
  const db = openDb(dir);
  t.after(() => db.close());
  const cfg = config(dir);
  const clock = { t: o.startedAt ?? T0 };
  const notifier = fakeNotifier(o.configured ?? true);
  const alerter = createAlerter({ db, cfg, notifier, log: silentLog, now: () => clock.t, startedAt: clock.t });
  const base: Snapshot = fixture();
  async function snap(at: number, attention: Attention[]) {
    clock.t = at;
    const s = { ...base, attention };
    storeSnapshot(db, s, at);
    alerter.onSnapshot(attention, at);
    await alerter.check();
  }
  async function tick(at: number) {
    clock.t = at;
    await alerter.check();
  }
  return { db, cfg, clock, notifier, alerter, snap, tick };
}

test('тревога: одна запись не тревожит; два снимка подряд, но < 3 мин — ещё нет; ≥ 3 мин — одно сообщение', async t => {
  const { notifier, snap, tick } = setup(t);
  const disk = att('disk', 'Диск занят на 93 %');
  await snap(T0, [disk]);
  await tick(T0 + 5 * MIN);
  assert.equal(notifier.sent.length, 0, 'один снимок — не тревожим, даже если прошло 5 минут');
  await snap(T0 + 6 * MIN, [disk]);
  assert.equal(notifier.sent.length, 1);

  const { notifier: n2, snap: snap2, tick: tick2 } = setup(t);
  await snap2(T0, [disk]);
  await snap2(T0 + MIN, [disk]);
  await tick2(T0 + 2 * MIN);
  assert.equal(n2.sent.length, 0, 'два снимка, но держится меньше 3 минут');
  await tick2(T0 + 3 * MIN);
  assert.equal(n2.sent.length, 1);
  assert.equal(n2.sent[0].kind, 'alert');
  assert.equal(n2.sent[0].text, '🔴 Нужно от тебя: посмотреть\n\n<b>Пульт · Сервер ботов</b>\n• Диск занят на 93 % (с 08:00)\n\nhttps://panel.example.test');

  // Держится — не повторяем.
  for (let i = 4; i < 60; i += 1) await snap2(T0 + i * MIN, [disk]);
  assert.equal(n2.sent.length, 1, 'одна проблема — одна тревога');
});

test('тревога: since от сборщика учитывается — давняя проблема тревожит на втором снимке; несколько новых — одним сообщением', async t => {
  const { notifier, snap } = setup(t);
  const a = att('bot:personal:down', 'Бот «Личный» не работает', new Date(T0 - 50 * MIN).toISOString());
  const b = att('mem', 'Память занята на 95 % <b>&</b>');
  const warn = att('apify', 'Apify: мало', null, 'serious');
  await snap(T0, [a, b, warn]);
  await snap(T0 + MIN, [a, b, warn]);
  assert.equal(notifier.sent.length, 1, 'проблема a держится 50 минут — сразу');
  assert.match(notifier.sent[0].text, /• Бот «Личный» не работает \(с 07:10\)/);
  assert.doesNotMatch(notifier.sent[0].text, /Память/, 'b ещё держится меньше 3 минут');
  await snap(T0 + 3 * MIN, [a, b, warn]);
  assert.equal(notifier.sent.length, 2);
  assert.match(notifier.sent[1].text, /• Память занята на 95 % &lt;b&gt;&amp;&lt;\/b&gt; \(с 08:00\)/, 'HTML экранирован');
  assert.doesNotMatch(notifier.sent.map(s => s.text).join('\n'), /Apify/, 'serious/warn не тревожат');

  const { notifier: n2, snap: s2 } = setup(t);
  const c = att('c', 'Служба «Почта» не работает');
  await s2(T0, [b, c]);
  await s2(T0 + 4 * MIN, [b, c]);
  assert.equal(n2.sent.length, 1, 'две новые — одним сообщением');
  assert.match(n2.sent[0].text, /^🔴 Нужно от тебя: посмотреть\n\n<b>Пульт · Сервер ботов<\/b>\n• .*\n• .*\n\nhttps:\/\/panel\.example\.test$/);
  assert.match(n2.sent[0].text, /\n• Память занята на 95 % .* \(с 08:00\)\n/);
  assert.match(n2.sent[0].text, /\n• Служба «Почта» не работает \(с 08:00\)\n/);
});

test('тревога: ушла — «снова в норме»; о которой не тревожили — молчим; вернулась до сообщения — тот же случай', async t => {
  const { notifier, snap, db } = setup(t);
  const disk = att('disk', 'Диск занят на 93 %');
  const blip = att('blip', 'Кратковременный сбой');
  await snap(T0, [disk, blip]);
  await snap(T0 + 4 * MIN, [disk]);
  assert.equal(notifier.sent.length, 1);
  assert.doesNotMatch(notifier.sent[0].text, /Кратковременный/, 'пропала до тревоги — не тревожим');
  await snap(T0 + 10 * MIN, []);
  assert.equal(notifier.sent.length, 2);
  assert.equal(notifier.sent[1].kind, 'recovery');
  assert.equal(notifier.sent[1].text, '🟢 От тебя ничего не нужно\n\nСнова в норме: Диск занят на 93 % (было с 08:00 до 08:10)');
  assert.equal(allAlerts(db).length, 0);
  await snap(T0 + 11 * MIN, []);
  assert.equal(notifier.sent.length, 2, 'о «Кратковременном сбое» не пишем вовсе');

  // Telegram лёг ровно в момент ухода — «снова в норме» ждёт; проблема вернулась — повторной тревоги нет.
  const x = setup(t);
  await x.snap(T0, [disk]);
  await x.snap(T0 + 4 * MIN, [disk]);
  x.notifier.setFail(true);
  await x.snap(T0 + 5 * MIN, []);
  x.notifier.setFail(false);
  await x.snap(T0 + 6 * MIN, [disk]);
  await x.snap(T0 + 11 * MIN, [disk]);
  await x.snap(T0 + 12 * MIN, [disk]);
  assert.equal(x.notifier.sent.length, 1, 'вернулась до отправки «снова в норме» — молчим');
});

test('тревога: напоминание раз в 12 часов, пока держится', async t => {
  const { notifier, snap } = setup(t);
  const disk = att('disk', 'Диск занят на 93 %');
  await snap(T0, [disk]);
  await snap(T0 + 3 * MIN, [disk]);
  assert.equal(notifier.sent.length, 1);
  await snap(T0 + 3 * MIN + REMIND_MS - MIN, [disk]);
  assert.equal(notifier.sent.length, 1, 'ещё нет 12 часов');
  await snap(T0 + 3 * MIN + REMIND_MS, [disk]);
  assert.equal(notifier.sent.length, 2);
  assert.match(notifier.sent[1].text, /<\/b>\nВсё ещё не в норме:\n• Диск занят на 93 % \(с 08:00\)\n/);
  await snap(T0 + 3 * MIN + REMIND_MS + 60 * MIN, [disk]);
  assert.equal(notifier.sent.length, 2, 'следующее — ещё через 12 часов');
  await snap(T0 + 3 * MIN + 2 * REMIND_MS, [disk]);
  assert.equal(notifier.sent.length, 3);
  assert.match(notifier.sent[2].text, /• Диск занят на 93 % \(с 30\.10 08:00\)/, 'на следующий день — с датой');
});

test('сборщик молчит: сразу при превышении порога, «снова в норме» при свежем снимке', async t => {
  const { notifier, snap, tick, cfg, db } = setup(t);
  await snap(T0, []);
  await tick(T0 + cfg.staleSec * 1000);
  assert.equal(notifier.sent.length, 0, 'ровно порог — ещё не молчит');
  await tick(T0 + cfg.staleSec * 1000 + 1000);
  assert.equal(notifier.sent.length, 1);
  assert.match(notifier.sent[0].text, /• Сборщик не присылает данные \(с 08:00\)/);
  await tick(T0 + 30 * MIN);
  assert.equal(notifier.sent.length, 1, 'одна тревога на весь случай');
  assert.ok(allAlerts(db).some(a => a.key === STALE_KEY && a.notified));
  await snap(T0 + 40 * MIN, []);
  assert.equal(notifier.sent.length, 2);
  assert.equal(notifier.sent[1].text, '🟢 От тебя ничего не нужно\n\nСнова в норме: Сборщик не присылает данные (было с 08:00 до 08:40)');
});

test('сборщик молчит: снимка нет с запуска; после рестарта со старым снимком — даём время прислать свежий', async t => {
  const fresh = setup(t);
  await fresh.tick(T0 + 4 * MIN);
  assert.equal(fresh.notifier.sent.length, 0);
  await fresh.tick(T0 + 6 * MIN);
  assert.match(fresh.notifier.sent[0].text, /Сборщик не прислал ни одного снимка \(с 08:00\)/);

  // Старый снимок в базе (сервис был выключен сутки) — сразу не тревожим.
  const dir = tmpDir(t);
  const db = openDb(dir);
  t.after(() => db.close());
  storeSnapshot(db, fixture(), T0 - 86_400_000);
  const n = fakeNotifier();
  const clock = { t: T0 };
  const alerter = createAlerter({ db, cfg: config(dir), notifier: n, log: silentLog, now: () => clock.t, startedAt: T0 });
  await alerter.check();
  clock.t = T0 + 4 * MIN;
  await alerter.check();
  assert.equal(n.sent.length, 0, 'после старта ждём PULT_STALE_SEC');
  clock.t = T0 + 5 * MIN + 1000;
  await alerter.check();
  assert.equal(n.sent.length, 1);
  assert.match(n.sent[0].text, /Сборщик не присылает данные \(с 29\.10 08:00\)/, 'время — реального последнего снимка');
});

test('тревога: Telegram недоступен — не теряем, повтор через 5 минут; не настроен — состояние копится молча', async t => {
  const { notifier, snap, tick, db } = setup(t);
  const disk = att('disk', 'Диск занят на 93 %');
  notifier.setFail(true);
  await snap(T0, [disk]);
  await snap(T0 + 3 * MIN, [disk]);
  assert.equal(notifier.sent.length, 0);
  assert.equal(allAlerts(db).find(a => a.key === 'disk')?.notified, false);
  notifier.setFail(false);
  await tick(T0 + 4 * MIN);
  assert.equal(notifier.sent.length, 0, 'пауза после неудачи');
  await tick(T0 + 8 * MIN + 1000);
  assert.equal(notifier.sent.length, 1);

  const off = setup(t, { configured: false });
  await off.snap(T0, [disk]);
  await off.snap(T0 + 3 * MIN, [disk]);
  assert.equal(off.notifier.sent.length, 0);
  assert.equal(allAlerts(off.db).find(a => a.key === 'disk')?.seenCount, 2);
});

test('тексты тревог: длинный список ужимается до 3500 символов', () => {
  const row = (i: number): AlertRow => ({ key: `k${i}`, source: 'snapshot', level: 'crit', text: `Проблема номер ${i} `.repeat(10), since: T0, firstSeen: T0, seenCount: 2, lastSeen: T0, notified: false, notifiedAt: null, resolvedAt: null });
  const many = Array.from({ length: 100 }, (_, i) => row(i));
  const text = alertMessage({ fresh: many, remind: many.slice(0, 50), host: 'Сервер <ботов>', publicUrl: 'https://p.test', tz: 'Europe/Moscow', now: T0 });
  assert.ok(text.length <= 3500, `длина ${text.length}`);
  assert.match(text, /<b>Пульт · Сервер &lt;ботов&gt;<\/b>/);
  assert.match(text, /…и ещё \d+/);
  assert.ok(text.endsWith('\n\nhttps://p.test'));
  const rec = recoveryMessage([{ ...row(1), text: 'A & B', resolvedAt: T0 + 90 * MIN }], 'Europe/Moscow', T0 + 90 * MIN);
  assert.equal(rec, '🟢 От тебя ничего не нужно\n\nСнова в норме: A &amp; B (было с 08:00 до 09:30)');
});
