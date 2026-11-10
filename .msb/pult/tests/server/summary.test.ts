import assert from 'node:assert/strict';
import { test } from 'node:test';
import { kvGet, openDb } from '../../src/server/db.ts';
import { silentLog } from '../../src/server/log.ts';
import { storeSnapshot } from '../../src/server/snapshot.ts';
import { createSummary, MAX_CHARS, summaryDue, summaryText } from '../../src/server/summary.ts';
import type { Notifier } from '../../src/server/telegram.ts';
import { config, fixture, tmpDir } from './helpers.ts';

const TZ = 'Europe/Moscow';
const NOW = Date.UTC(2026, 9, 30, 5, 0, 30); // 30.10 08:00 МСК
const base = { tz: TZ, staleSec: 300, publicUrl: 'https://panel.example.test' };

test('сводка: полный текст по снимку-примеру', () => {
  const text = summaryText({ ...base, snap: { snapshot: fixture(), receivedAt: NOW - 30_000 }, now: NOW });
  assert.equal(text, [
    '🔴 Нужно от тебя: 2 решения, посмотреть тревоги',
    '',
    '<b>Сводка Пульта, 30.10</b>',
    '',
    '<b>Нужно от тебя</b>',
    '• Какой канал кемперов вести первым · ждёт 44 ч',
    '• Zapcita: Утвердить текст письма клиникам &lt;Богота&gt; &amp; Сантьяго · ждёт 14 ч',
    '',
    '<b>Требует внимания</b>',
    '🔴 Бот «Личный» не работает',
    '🟠 Баланс ProxyAPI: 2 ошибки за сутки',
    '🟡 Apify: осталось меньше $1',
    '',
    '<b>Боты</b>',
    '• Основной — работает · за сутки 12 запросов в чате, 31 фоновый ход',
    '• SMM — работает · за сутки 1 запрос в чате, 22 фоновых хода',
    '• Личный — не работает (failed) · за сутки 0 запросов в чате, 2 фоновых хода',
    '',
    '<b>Фон за сутки</b>',
    '• Баланс ProxyAPI (Основной): 2 ошибки, 2 пропуска',
    '',
    '<b>Сервер</b>',
    'Процессор 12 % · память 45 % · диск 61 %',
    '',
    '<b>Остатки</b>',
    '• ProxyAPI: 334,75 ₽',
    '• Apify: $0,80 из $5 — мало',
    '• Deepgram: $187,20 (давно не обновлялся)',
    '',
    'https://panel.example.test',
  ].join('\n'));
});

test('сводка: всё спокойно — зелёная строка и «штатно»', () => {
  const s = fixture();
  s.asks = [];
  s.attention = [];
  s.tasks = s.tasks.filter(t => t.stats24h.error === 0 && t.stats24h.missed === 0);
  s.balances = [];
  const text = summaryText({ ...base, snap: { snapshot: s, receivedAt: NOW }, now: NOW });
  assert.ok(text.startsWith('🟢 От тебя ничего не нужно\n\n<b>Сводка Пульта, 30.10</b>'));
  assert.match(text, /<b>Фон за сутки<\/b>\nвсе задачи отработали штатно/);
  assert.doesNotMatch(text, /Нужно от тебя<\/b>|Требует внимания|Остатки/);
  s.attention = [{ key: 'k', level: 'crit', text: 'x', project: null, link: { tab: 'overview' }, since: null }];
  assert.match(summaryText({ ...base, snap: { snapshot: s, receivedAt: NOW }, now: NOW }), /^🔴 Нужно от тебя: посмотреть тревоги\n/);
  s.attention = [];
  s.asks = [fixture().asks[0]];
  assert.match(summaryText({ ...base, snap: { snapshot: s, receivedAt: NOW }, now: NOW }), /^🔴 Нужно от тебя: 1 решение\n/);
});

test('сводка: снимок устарел или его нет — первой строкой', () => {
  const stale = summaryText({ ...base, snap: { snapshot: fixture(), receivedAt: Date.UTC(2026, 9, 30, 1, 15, 0) }, now: NOW });
  assert.match(stale, /^🔴 Нужно от тебя: посмотреть — сборщик молчит с 04:15\n\n<b>Сводка Пульта, 30\.10<\/b>\nДанные на 04:15 — новее нет\./);
  const yesterday = summaryText({ ...base, snap: { snapshot: fixture(), receivedAt: NOW - 86_400_000 }, now: NOW });
  assert.match(yesterday, /^🔴 Нужно от тебя: посмотреть — сборщик молчит с 29\.10 08:00\n/);
  const none = summaryText({ ...base, snap: null, now: NOW });
  assert.equal(none, '🔴 Нужно от тебя: посмотреть — сборщик ещё не прислал данных\n\n<b>Сводка Пульта, 30.10</b>\n\nhttps://panel.example.test');
});

test('сводка: не длиннее 3500 символов при огромных списках, ссылка на месте', () => {
  const s = fixture();
  const long = 'очень длинный текст вопроса '.repeat(20);
  s.asks = Array.from({ length: 60 }, (_, i) => ({ ...s.asks[0], id: `a${i}`, text: `${i} ${long}` }));
  s.attention = Array.from({ length: 80 }, (_, i) => ({ key: `k${i}`, level: 'warn' as const, text: long, project: null, link: { tab: 'overview' as const }, since: null }));
  s.tasks = Array.from({ length: 50 }, (_, i) => ({ ...s.tasks[0], id: `t${i}`, name: `Задача ${i} ${long}` }));
  s.balances = Array.from({ length: 30 }, (_, i) => ({ ...s.balances[0], id: `b${i}`, name: `Сервис ${i}` }));
  const text = summaryText({ ...base, snap: { snapshot: s, receivedAt: NOW }, now: NOW });
  assert.ok(text.length <= MAX_CHARS, `длина ${text.length}`);
  assert.ok(text.startsWith('🔴 Нужно от тебя: 60 решений'));
  assert.ok(text.endsWith('\nhttps://panel.example.test'));
  assert.match(text, /…и ещё \d+/);
});

test('расписание сводки: в час сводки, догон до 12:00, раз в день', () => {
  const at = (h: number, m = 0) => Date.UTC(2026, 9, 30, h - 3, m); // МСК = UTC+3
  assert.equal(summaryDue(at(7, 59), TZ, 8, null), false);
  assert.equal(summaryDue(at(8, 0), TZ, 8, null), true);
  assert.equal(summaryDue(at(11, 59), TZ, 8, '2026-10-29'), true, 'сервис был выключен в 08:00 — догоняем');
  assert.equal(summaryDue(at(12, 0), TZ, 8, '2026-10-29'), false, 'после 12:00 не догоняем');
  assert.equal(summaryDue(at(9, 0), TZ, 8, '2026-10-30'), false, 'сегодня уже отправляли');
  assert.equal(summaryDue(at(20, 0), TZ, 19, null), true, 'вечерний час сводки — догон до конца дня');
});

test('сводка: отправляется один раз в день, при ошибке — повтор не раньше чем через 10 минут', async t => {
  const dir = tmpDir(t);
  const db = openDb(dir);
  t.after(() => db.close());
  storeSnapshot(db, fixture(), NOW);
  const sent: string[] = [];
  let fail = true;
  const notifier: Notifier = {
    configured: true,
    async send(text) {
      if (fail) return { ok: false, skipped: false, error: 'нет сети' };
      sent.push(text);
      return { ok: true, skipped: false, error: null };
    },
    async setWebAppMenu() { return { ok: true, skipped: false, error: null }; },
    async getMe() { return { ok: true, username: 'x' }; },
    status() { return { configured: true, lastError: null, lastSentAt: null }; },
  };
  const clock = { t: Date.UTC(2026, 9, 30, 4, 59, 0) }; // 07:59
  const summary = createSummary({ db, cfg: config(dir), notifier, log: silentLog, now: () => clock.t });
  await summary.tick();
  assert.equal(sent.length, 0);
  clock.t = NOW;
  await summary.tick();
  assert.equal(sent.length, 0, 'Telegram лёг');
  fail = false;
  clock.t = NOW + 5 * 60_000;
  await summary.tick();
  assert.equal(sent.length, 0, 'повтор не раньше чем через 10 минут');
  clock.t = NOW + 10 * 60_000;
  await summary.tick();
  assert.equal(sent.length, 1);
  assert.equal(kvGet(db, 'summary_last_date'), '2026-10-30');
  clock.t = NOW + 60 * 60_000;
  await summary.tick();
  assert.equal(sent.length, 1, 'второй раз за день — нет');
  clock.t = NOW + 86_400_000;
  await summary.tick();
  assert.equal(sent.length, 2, 'на следующий день — снова');
});
