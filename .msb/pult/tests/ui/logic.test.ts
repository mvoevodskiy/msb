// Тесты чистой логики интерфейса (src/ui/logic.js) на фикстурах из макетов v2.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Snapshot, Task, SnapshotResponse, Run } from '../../src/shared/types.ts';
import * as L from '../../src/ui/logic.js';

const FX = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'ui');
const load = (name: string): Snapshot => JSON.parse(readFileSync(join(FX, name), 'utf8'));
const S = load('snapshot.json');
const Q = load('snapshot-quiet.json');
const NOW = Date.parse('2026-10-29T10:45:20Z');
/** Неразрывные пробелы → обычные, чтобы сравнивать строки глазами. */
const n = (s: string | null | undefined) => String(s ?? '').replace(/ /g, ' ');
const task = (id: string): Task => {
  const t = S.tasks.find((x) => x.id === id);
  assert.ok(t, `нет задачи ${id}`);
  return t;
};
const clone = <T>(x: T): T => structuredClone(x);

describe('время в МСК', () => {
  test('часы и даты', () => {
    assert.equal(L.fmtTime('2026-10-29T10:45:00Z'), '13:45');
    assert.equal(L.fmtDate('2026-10-29T10:45:00Z'), '29.10');
    assert.equal(L.fmtDateTime('2026-10-28T20:25:00Z'), '28.10 23:25');
    assert.equal(L.fmtTime('2026-10-28T21:00:00Z'), '00:00', 'полночь — 00, не 24');
    assert.equal(L.mskOffsetMs(NOW), 3 * 3600e3);
  });
  test('сегодня, завтра, вчера, другая дата', () => {
    assert.equal(L.fmtWhen('2026-10-29T11:00:00Z', NOW), '14:00');
    assert.equal(L.fmtWhen('2026-10-30T05:00:00Z', NOW), 'завтра 08:00');
    assert.equal(L.fmtWhen('2026-10-28T20:00:00Z', NOW), 'вчера 23:00');
    assert.equal(L.fmtWhen('2026-11-01T05:44:00Z', NOW), '01.11 08:44');
    assert.equal(L.fmtWhen('2026-10-28T21:30:00Z', NOW), '00:30', 'после полуночи МСК — уже сегодня');
  });
  test('разница дней по МСК, а не по UTC', () => {
    assert.equal(L.dayDiff('2026-10-28T20:59:00Z', '2026-10-28T21:01:00Z'), 1);
    assert.equal(L.dayDiff('2026-10-28T10:00:00Z', '2026-10-28T20:00:00Z'), 0);
  });
  test('ближайшая сводка в 08:00 МСК', () => {
    assert.equal(new Date(L.nextDigestAt(NOW)).toISOString(), '2026-10-30T05:00:00.000Z');
    assert.equal(new Date(L.nextDigestAt(Date.parse('2026-10-29T04:00:00Z'))).toISOString(), '2026-10-29T05:00:00.000Z');
    assert.equal(new Date(L.nextDigestAt(Date.parse('2026-10-29T05:00:00Z'))).toISOString(), '2026-10-30T05:00:00.000Z', 'ровно в 08:00 — уже следующая');
  });
});

describe('числа и длительности', () => {
  test('склонения', () => {
    const f = (k: number) => L.plural(k, 'бот', 'бота', 'ботов');
    assert.deepEqual([1, 2, 5, 11, 12, 14, 21, 22, 25, 111, 0].map(f), ['бот', 'бота', 'ботов', 'ботов', 'ботов', 'ботов', 'бот', 'бота', 'ботов', 'ботов', 'ботов']);
    assert.equal(n(L.count(3, 'бот', 'бота', 'ботов')), '3 бота');
  });
  test('токены', () => {
    assert.equal(n(L.fmtTokens(850)), '850');
    assert.equal(n(L.fmtTokens(43994)), '44 тыс.');
    assert.equal(n(L.fmtTokens(558791)), '0,56 млн');
    assert.equal(n(L.fmtTokens(8367471)), '8,4 млн');
    assert.equal(n(L.fmtTokens(12.4e6)), '12 млн');
    assert.equal(n(L.fmtTokens(1518528, true)), '1,52 млн');
    assert.equal(n(L.fmtTokens(0)), '0');
  });
  test('память, ядра, деньги, проценты', () => {
    assert.equal(n(L.fmtMb(236)), '236 МБ');
    assert.equal(n(L.fmtMb(1034)), '1,0 ГБ');
    assert.equal(n(L.fmtMb(4506)), '4,4 ГБ');
    assert.equal(L.fmtMb(null), '—');
    assert.equal(L.fmtCores(0.003), 'меньше 0,01');
    assert.equal(L.fmtCores(0.89), '0,89');
    assert.equal(L.fmtCores(null), '—');
    assert.equal(L.fmtUsd(0.005), '$0,005');
    assert.equal(L.fmtUsd(1.5), '$1,50');
    assert.equal(L.fmtUsd(11.19), '$11,2');
    assert.equal(n(L.fmtPct(27.4)), '27 %');
    assert.equal(n(L.fmtInt(6037)), '6 037');
    assert.equal(n(L.fmtGb(44)), '44 ГБ');
    assert.equal(n(L.fmtGb(7.46)), '7,5 ГБ');
  });
  test('«ждёт», «назад», длительность хода', () => {
    assert.equal(L.fmtSpan(30), 'меньше минуты');
    assert.equal(n(L.fmtSpan(45 * 60)), '45 мин');
    assert.equal(n(L.fmtSpan(93 * 60)), '1 ч 33 мин');
    assert.equal(n(L.fmtSpan(13 * 3600 + 20 * 60)), '13 ч');
    assert.equal(n(L.fmtSpan(50 * 3600)), '2 дня');
    assert.equal(n(L.fmtAgo(20)), '20 с назад');
    assert.equal(n(L.fmtAgo(750)), '12 мин назад');
    assert.equal(n(L.fmtAgo(5 * 86400)), '5 дней назад');
    assert.equal(n(L.fmtDur(308)), '5 мин 08 с');
    assert.equal(n(L.fmtDur(37)), '37 с');
    assert.equal(n(L.fmtDur(5340)), '1 ч 29 мин');
    assert.equal(n(L.fmtDurShort(308)), '5 мин');
    assert.equal(n(L.fmtMinutes(93)), '1 ч 33 мин');
    assert.equal(n(L.fmtMinutes(120)), '2 ч');
  });
  test('перечисление', () => {
    assert.equal(L.joinAnd([]), '');
    assert.equal(L.joinAnd(['а']), 'а');
    assert.equal(L.joinAnd(['а', 'б', 'в']), 'а, б и в');
  });
});

describe('маршруты', () => {
  test('разбор адреса', () => {
    assert.deepEqual(L.parseRoute(''), { name: 'overview', tab: 'overview', id: null, query: {} });
    assert.deepEqual(L.parseRoute('#/'), { name: 'overview', tab: 'overview', id: null, query: {} });
    assert.equal(L.parseRoute('#/bots').name, 'bots');
    assert.deepEqual(L.parseRoute('#/tasks?bot=SMM&range=7d'), { name: 'tasks', tab: 'tasks', id: null, query: { bot: 'SMM', range: '7d' } });
    assert.deepEqual(L.parseRoute('#/tasks/socpub-dev?range=30d'), { name: 'task', tab: 'tasks', id: 'socpub-dev', query: { range: '30d' } });
    assert.equal(L.parseRoute('#/nope').name, 'notfound');
    assert.equal(L.parseRoute('#/overview').name, 'notfound', 'обзор — только #/');
    assert.equal(L.parseRoute('#/tasks/%E0%A4%A').name, 'task', 'битая кодировка не роняет разбор');
  });
  test('сборка и обратный разбор', () => {
    const id = 'задача с пробелом/и слэшем?&';
    const h = L.buildHash('tasks', id, { range: '7d', bot: null });
    assert.equal(L.parseRoute(h).id, id);
    assert.equal(L.parseRoute(h).query.range, '7d');
    assert.equal(L.buildHash('overview'), '#/');
    assert.equal(L.buildHash('server', null, { range: '' }), '#/server');
  });
  test('период и ссылки «внимания»', () => {
    assert.equal(L.validRange('7d'), '7d');
    assert.equal(L.validRange('1y'), '24h');
    assert.equal(L.validRange(undefined, '7d'), '7d');
    assert.equal(L.attentionHref({ tab: 'tasks', id: 'socpub-dev' }), '#/tasks/socpub-dev');
    assert.equal(L.attentionHref({ tab: 'server' }), '#/server');
    assert.equal(L.attentionHref({ tab: 'overview' }), '#/');
    assert.equal(L.attentionHref(null), '#/');
    assert.equal(L.attentionLinkLabel({ tab: 'tasks', id: 'x' }), 'Задача');
    assert.equal(L.attentionLinkLabel({ tab: 'tasks' }), 'Задачи');
    assert.equal(L.attentionLinkLabel({ tab: 'server' }), 'Сервер');
  });
});

describe('часы веб-сервиса и свежесть', () => {
  const resp: SnapshotResponse = { snapshot: S, receivedAt: '2026-10-29T10:45:00Z', ageSec: 20, stale: false, notify: { configured: true, lastError: null, lastSentAt: null } };
  test('«сейчас» не зависит от часов браузера', () => {
    const fetched = 1_000_000;
    assert.equal(L.serverNow(resp, fetched, fetched), Date.parse('2026-10-29T10:45:20Z'));
    assert.equal(L.serverNow(resp, fetched, fetched + 5000), Date.parse('2026-10-29T10:45:25Z'));
    assert.equal(L.serverNow(null, fetched, 42), 42);
    assert.equal(L.currentAgeSec(resp, fetched, fetched + 3000), 23);
    assert.equal(L.currentAgeSec(null, 0, 0), null);
  });
  test('шапка: норма, устарело, нет связи, нет данных', () => {
    assert.equal(n(L.headerStatus({ resp, error: null, loading: false, ageSec: 20 }).text), '29.10, 13:44 · обновлено 20 с назад');
    assert.equal(L.headerStatus({ resp, error: null, loading: false, ageSec: 20 }).level, 'good');
    assert.equal(L.headerStatus({ resp: { ...resp, stale: true }, error: null, loading: false, ageSec: 900 }).level, 'warn');
    assert.equal(L.headerStatus({ resp, error: { text: 'x' }, loading: false, ageSec: 20 }).level, 'crit');
    assert.equal(L.headerStatus({ resp: null, error: null, loading: true, ageSec: null }).text, 'загружаю…');
    assert.equal(L.headerStatus({ resp: null, error: { text: 'x' }, loading: false, ageSec: null }).level, 'crit');
    assert.equal(L.headerStatus({ resp: { ...resp, snapshot: null }, error: null, loading: false, ageSec: null }).text, 'сборщик ещё не прислал данные');
  });
  test('плашка «данные устарели»', () => {
    assert.equal(L.staleBanner(resp, 20, NOW), null);
    assert.equal(n(L.staleBanner({ ...resp, stale: true }, 750, NOW)), 'Данные от 13:44 — сборщик молчит 12 мин');
    assert.equal(n(L.staleBanner({ ...resp, stale: true }, 26 * 3600, NOW + 26 * 3600e3)), 'Данные от вчера 13:44 — сборщик молчит 26 ч');
  });
});

describe('обзор', () => {
  test('плитки на фикстуре', () => {
    const sum = L.overviewSummary(S, NOW);
    assert.equal(sum.asks, 3);
    assert.equal(n(L.fmtSpan(sum.longestSec)), '2 дня');
    assert.equal(sum.attention, 3);
    assert.equal(sum.attentionWhere, 'сервер и фоновая задача «socpublisher: разработчик»');
    assert.equal(n(sum.totals), '3 бота · 7 фоновых задач · 9 служб');
    assert.deepEqual(sum.failing, []);
  });
  test('пусто и сбои', () => {
    const q = L.overviewSummary(Q, NOW);
    assert.equal(q.asks, 0);
    assert.equal(q.longestSec, 0);
    assert.equal(q.attentionWhere, '');
    const broken = clone(S);
    broken.services[1]!.state = 'failed';
    broken.bots[2]!.service.state = 'inactive';
    broken.platform = { total: 5, ok: 4, failed: 1 };
    const b = L.overviewSummary(broken, NOW);
    assert.deepEqual(b.failing, ['бот Личный — остановлена', 'socpublisher, тест — упала', 'служебных процессов платформы — 1']);
  });
  test('где проблемы: несколько задач и разделы', () => {
    const s = clone(S);
    s.attention.push({ key: 'x', level: 'warn', text: 't', project: null, link: { tab: 'tasks', id: 'proxyapi-balance' }, since: null });
    s.attention.push({ key: 'y', level: 'warn', text: 't', project: null, link: { tab: 'bots' }, since: null });
    assert.equal(L.overviewSummary(s, NOW).attentionWhere, 'сервер, боты и фоновые задачи');
  });
  test('расписание: сводка пульта встаёт по времени', () => {
    const rows = L.upcomingRows(S, { configured: true, lastError: null, lastSentAt: null }, NOW);
    assert.equal(rows.length, 7);
    const i = rows.findIndex((r) => r.digest);
    assert.equal(rows[i]!.name, 'Сводка пульта → в Telegram');
    assert.ok(rows[i - 1]!.at <= rows[i]!.at && rows[i]!.at <= rows[i + 1]!.at);
    assert.equal(L.upcomingRows(S, { configured: false, lastError: null, lastSentAt: null }, NOW).length, 6);
    assert.equal(L.upcomingRows(Q, null, NOW).length, 0);
  });
  test('боты сейчас', () => {
    const [def, smm] = S.bots as [typeof S.bots[0], typeof S.bots[0]];
    const a = L.botNowInfo(def, S, NOW);
    assert.equal(a.status, 'свободен');
    assert.equal(a.level, 'good');
    assert.equal(a.about, 'фон: ход «socpublisher: разработчик» в 14:00');
    assert.equal(a.sub, 'следующий фоновый ход в 14:00 — «socpublisher: разработчик»');
    const b = L.botNowInfo(smm, S, NOW);
    assert.equal(n(b.status), 'работает 52 мин');
    assert.equal(b.about, 'infosecurity → прод · 4 помощника');
    // Данные устарели на час — «работает» считается на момент снимка, а не растёт.
    assert.equal(n(L.botNowInfo(smm, S, NOW + 3600e3).status), 'работает 52 мин');
    const down = clone(def);
    down.service.state = 'failed';
    const c = L.botNowInfo(down, S, NOW);
    assert.equal(c.status, 'служба упала');
    assert.equal(c.level, 'crit');
    const idle = clone(def);
    assert.equal(L.botNowInfo(idle, Q, NOW).about, 'последний итог 01:01: ответ про переезд сервера');
  });
  test('строка о службах ботов', () => {
    assert.equal(L.botsServiceLine(S.bots), 'Все три работают с 28.10 23:25 · перезапусков не было');
    const b = clone(S.bots);
    b[1]!.service.since = '2026-10-29T08:00:00Z';
    b[1]!.service.restarts = 2;
    assert.equal(L.botsServiceLine(b), 'Основной — с 28.10 23:25 · SMM — с 29.10 11:00 · Личный — с 28.10 23:25 · перезапусков за время работы: 2');
    assert.equal(L.botsServiceLine([]), '');
  });
  test('подписка и остатки', () => {
    assert.equal(L.subscriptionInfo(S.subscription, NOW)!.text, 'в норме · сброс в 14:00');
    assert.equal(L.subscriptionInfo(null, NOW), null);
    const lim = L.subscriptionInfo({ ...S.subscription!, status: 'limited', overage: true }, NOW)!;
    assert.equal(lim.level, 'crit');
    assert.match(lim.text, /лимит исчерпан · расход сверх лимита/);
    assert.equal(L.subscriptionInfo({ ...S.subscription!, updatedAt: '2026-10-28T10:00:00Z' }, NOW)!.stale, true);
    const dg = S.balances.find((b) => b.id === 'deepgram')!;
    assert.equal(L.balanceInfo(dg, NOW).text, '$199,92 · на 25.10, устарело');
    assert.equal(L.balanceInfo(dg, NOW).stale, true);
    const low = L.balanceInfo({ ...S.balances[0]!, ok: false, note: 'порог 50 ₽' }, NOW);
    assert.equal(low.level, 'warn');
    assert.equal(low.text, '334,75 ₽ · ниже порога · порог 50 ₽');
  });
  test('проекты: уровень и службы', () => {
    assert.deepEqual(S.projects.map(L.projectLevel), ['good', 'warn', 'warn', 'off', 'pause', 'pause']);
    assert.deepEqual(L.projectServicesParts(S.projects[0]!, S.services), [{ text: 'Бот, Почта, WhatsApp-рассылка, Сайт — все в норме', level: null }]);
    assert.deepEqual(L.projectServicesParts(S.projects[1]!, S.services), [
      { text: 'socpublisher, тест — в норме', level: null }, { text: 'Проверки socpublisher — тяжёлая', level: 'serious' },
    ]);
    const p = clone(S.projects[0]!);
    p.services[0]!.state = 'failed';
    assert.equal(L.projectServicesParts(p, [])[0]!.level, 'crit');
    assert.deepEqual(L.projectServicesParts(S.projects[2]!, S.services), []);
  });
});

describe('фоновые задачи', () => {
  test('группы и фильтры по боту', () => {
    const g = L.splitTasks(S.tasks);
    assert.deepEqual(g.attention.map((t) => t.id), ['socpub-dev']);
    assert.equal(g.ok.length, 6);
    assert.deepEqual(L.botFilters(S.tasks, S.bots).map((f) => `${f.label} · ${f.count}`), ['Все · 7', 'Основной · 5', 'SMM · 1', 'Сервер · 1']);
    assert.deepEqual(L.filterTasks(S.tasks, 'SMM').map((t) => t.id), ['infosec-x']);
    assert.equal(L.filterTasks(S.tasks, 'all').length, 7);
    assert.equal(L.filterTasks(S.tasks, null).length, 7);
    assert.deepEqual(L.botFilters([], S.bots), [{ key: 'all', label: 'Все', count: 0 }]);
  });
  test('подписи бота', () => {
    assert.equal(L.botLabel('Основной'), 'основной бот');
    assert.equal(L.botLabel('SMM'), 'SMM-бот');
    assert.equal(L.botLabel('Сервер', 'server'), 'сервер');
    assert.equal(L.botShortName('server', S.bots), 'Сервер');
    assert.equal(L.botShortName('nobody', S.bots, 'Призрак'), 'Призрак');
  });
  test('строки списка', () => {
    assert.equal(L.taskSubtitle(task('socpub-dev')), 'socpublisher · основной бот');
    assert.equal(L.taskSubtitle(task('infosec-x')), 'infosecurity · SMM-бот · таймер сервера');
    assert.equal(L.taskSubtitle(task('server-backup')), 'все проекты · таймер сервера');
    assert.equal(n(L.lastRunText(task('socpub-dev'), NOW)), '13:00 · молча · 5 мин');
    assert.equal(L.lastRunText(task('infosec-x'), NOW), '13:20 · 29 постов · $0,005');
    assert.equal(L.lastRunText(task('offer-reminder'), NOW), 'ещё не было');
    assert.equal(n(L.lastRunText(task('socpub-alarm'), NOW)), '26.10 20:39 · итог · 21 с');
    assert.equal(L.nextRunText(task('socpub-dev'), NOW), '14:00');
    assert.equal(L.nextRunText(task('socpub-alarm'), NOW), 'ждёт события');
    assert.equal(L.nextRunText(task('offer-reminder'), NOW), '01.11 08:44');
    const done = { ...task('offer-reminder'), nextRunAt: null };
    assert.equal(L.nextRunText(done, NOW), '—');
  });
  test('пропуски в окне', () => {
    const g = task('socpub-dev').gaps[0]!;
    assert.equal(L.gapSlotsIn(g, NOW - 864e5, NOW), 12);
    assert.equal(L.gapSlotsIn(g, NOW - 7 * 864e5, NOW), 15);
    assert.equal(L.gapSlotsIn(g, NOW - 3600e3, NOW), 0);
    assert.equal(L.gapSlotsIn({ from: '2026-10-29T08:00:00Z', to: '2026-10-29T08:00:00Z', missed: 1 }, NOW - 864e5, NOW), 1);
    assert.equal(L.gapSlotsIn({ from: '2026-10-29T08:00:00Z', to: '2026-10-29T09:00:00Z', missed: 0 }, NOW - 864e5, NOW), 0);
    assert.equal(L.gapWhen(g), '28.10 с 11:00 до 01:00');
    assert.equal(L.gapWhen({ from: '2026-10-26T08:00:00Z', to: '2026-10-28T08:00:00Z', missed: 49 }), 'с 26.10 11:00 до 28.10 11:00');
  });
  test('показатели за 24 ч — из stats24h, за 7 и 30 дней — из ходов и пропусков', () => {
    const t = task('socpub-dev');
    const d = L.rangeStats(t, '24h', NOW);
    assert.deepEqual([d.runs, d.ok, d.silent, d.error, d.missed, d.expected], [12, 0, 12, 0, 12, 24]);
    assert.equal(d.tokens, t.stats24h.tokens);
    assert.equal(d.commits.length, 3);
    const w = L.rangeStats(t, '7d', NOW);
    assert.deepEqual([w.runs, w.ok, w.silent, w.error, w.missed, w.expected], [61, 5, 56, 0, 15, 76]);
    assert.equal(w.tokens, t.runs.reduce((k, r) => k + r.tokens, 0));
    assert.equal(w.commits.length, 15);
    assert.equal(L.rangeStats(t, '30d', NOW).runs, 61);
    // По событию — «из N» не считается.
    assert.equal(L.rangeStats(task('socpub-alarm'), '7d', NOW).expected, null);
  });
  test('отдельные пропуски-ходы не задваиваются с интервалами пропусков', () => {
    const t = clone(task('socpub-dev'));
    const missed = (at: string): Run => ({ at, status: 'missed', durationSec: 0, tokens: 0, helpers: 0, usd: null, detail: null });
    t.runs.push(missed('2026-10-28T12:00:00Z'), missed('2026-10-25T12:00:00Z'));
    t.runs.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
    const w = L.rangeStats(t, '7d', NOW);
    assert.equal(w.missed, 16, '12:00 28.10 внутри интервала — не считается второй раз; 25.10 — отдельно');
    assert.equal(w.runs, 61);
  });
  test('подпись под полоской', () => {
    assert.deepEqual(L.stripSummary(task('socpub-dev'), '24h', NOW), { text: '12 из 24 — пропуск 28.10', warn: true, empty: false });
    assert.deepEqual(L.stripSummary(task('socpub-digest'), '24h', NOW), { text: '1 из 1', warn: false, empty: false });
    assert.deepEqual(L.stripSummary(task('socpub-alarm'), '24h', NOW), { text: 'событий не было', warn: false, empty: true });
    assert.deepEqual(L.stripSummary(task('offer-reminder'), '24h', NOW), { text: '—', warn: false, empty: true });
    assert.equal(L.stripSummary(task('socpub-dev'), '7d', NOW).text, '61 из 76 — пропуск 28.10');
    const e = clone(task('proxyapi-balance'));
    e.stats24h.error = 1;
    assert.deepEqual(L.stripSummary(e, '24h', NOW), { text: '1 из 1 · 1 ошибка', warn: true, empty: false });
  });
  test('клетки по дням: худший итог дня', () => {
    const c = L.dayCells(task('socpub-dev'), '7d', NOW);
    assert.equal(c.length, 7);
    assert.deepEqual(c, ['none', 'none', 'none', 'ok', 'silent', 'missed', 'missed'], '27.10 — только молча, 28 и 29 — с пропусками');
    assert.deepEqual(L.dayCells(task('server-backup'), '7d', NOW), ['none', 'none', 'none', 'ok', 'ok', 'ok', 'ok']);
    assert.equal(L.dayCells(task('socpub-digest'), '30d', NOW).length, 30);
    const e = clone(task('proxyapi-balance'));
    e.runs[3]!.status = 'error';
    assert.equal(L.dayCells(e, '7d', NOW)[6], 'error');
    assert.equal(L.slotsSummary(['ok', 'silent', 'silent', 'missed', 'error', 'none']), '1 с итогом, 2 молча, 1 с ошибкой, 1 пропущено');
    assert.equal(L.slotsSummary([]), 'ходов не было');
  });
  test('что вышло за ход: коммиты в окне хода и деталь', () => {
    const t = task('socpub-dev');
    const last = t.runs.length - 1;
    assert.deepEqual(L.commitsForRun(t, last, NOW).map((c) => c.hash), ['fbca3e5']);
    assert.equal(L.runOutcome(t, last, NOW), 'коммит fbca3e5 в 13:23');
    assert.equal(L.runOutcome(t, last - 1, NOW), '');
    const p = task('proxyapi-balance');
    assert.equal(L.runOutcome(p, p.runs.length - 1, NOW), 'баланс 334,75 ₽');
    const lr = L.lastRuns(t, 8);
    assert.equal(lr.length, 8);
    assert.equal(lr[0]!.index, last);
    assert.ok(Date.parse(lr[0]!.run.at) > Date.parse(lr[7]!.run.at));
    assert.deepEqual(L.lastRuns(task('offer-reminder')), []);
  });
});

describe('карточка задачи', () => {
  test('пять показателей «разработчика» за сутки', () => {
    const k = L.taskKpis(task('socpub-dev'), '24h', NOW);
    assert.deepEqual(k.map((x) => n(x.value)), ['12', '0 / 12 / 0', '3 коммита', '8,4 млн', '13:05']);
    assert.equal(k[0]!.extra, 'из 24');
    assert.equal(k[0]!.sub, '12 пропущено 28.10');
    assert.equal(k[0]!.level, 'warn');
    assert.equal(k[2]!.sub, '06:17 · 09:17 · 13:23');
    assert.equal(k[3]!.sub, '≈ $11,2 по тарифу API');
    assert.equal(k[4]!.dot, 'good');
    assert.equal(k[4]!.sub, 'ход закончен · зависших нет');
  });
  test('показатели таймера и задачи без пульса', () => {
    const k = L.taskKpis(task('infosec-x'), '24h', NOW);
    assert.equal(k[0]!.sub, 'без пропусков');
    assert.equal(k[2]!.value, '29 постов · $0,005');
    assert.equal(k[3]!.value, 'без ИИ');
    assert.equal(k[4]!.value, '—');
    assert.equal(k[4]!.sub, 'задача пульс не пишет');
    const p = L.taskKpis(task('proxyapi-balance'), '24h', NOW);
    assert.equal(p[2]!.value, '0 итогов');
    assert.equal(p[2]!.sub, 'итогов в чат не было');
  });
  test('несвежий пульс и ошибки — цветом и словом', () => {
    const t = clone(task('socpub-dev'));
    t.pulse = { ...t.pulse!, fresh: false };
    t.stats24h.error = 2;
    const k = L.taskKpis(t, '24h', NOW);
    assert.equal(k[1]!.level, 'crit');
    assert.equal(k[4]!.dot, 'warn');
    assert.equal(k[4]!.dotWord, 'несвежий');
    assert.match(k[4]!.sub, /^несвежий/);
  });
  test('наблюдения — факты сверх KPI (без повтора молча/итог)', () => {
    const o = L.observations(task('socpub-dev'), '24h', NOW).map(n);
    assert.deepEqual(o, [
      'В проекте за сутки 3 коммита, последний — 13:23.',
      '3 хода с помощниками — 44 % токенов; остальные 9 — в среднем 1 мин и 0,52 млн токенов на ход.',
      'Самый затратный ход — 13:00: 1,52 млн токенов, 18 % за сутки.',
      '28.10 с 11:00 до 01:00 — 15 пропусков по расписанию подряд.',
      'Пульс обновлён в 13:05 (40 мин назад) — свежий.',
    ]);
    const w = L.observations(task('socpub-dev'), '7d', NOW).map(n);
    assert.ok(w.some((x) => x.includes('коммит')), w.join(' | '));
    assert.ok(!w.some((x) => /молча/.test(x)), 'молчание уже в KPI');
  });
  test('наблюдения: ошибки, несвежий пульс, ни одного хода', () => {
    const t = clone(task('proxyapi-balance'));
    t.runs[3]!.status = 'error';
    t.stats24h = { ...t.stats24h, silent: 0, error: 1 };
    const o = L.observations(t, '24h', NOW);
    assert.ok(o.includes('1 ход с ошибкой, последний — 10:00.'), o.join(' | '));
    const p = clone(task('socpub-dev'));
    p.pulse = { ...p.pulse!, fresh: false };
    assert.match(n(L.observations(p, '24h', NOW).at(-1)), /^Пульс несвежий: последнее обновление 13:05 \(40 мин назад\), ждали к 14:15\.$/);
    assert.deepEqual(L.observations(task('offer-reminder'), '7d', NOW), ['За 7 дней ходов не было.']);
    const none = clone(task('socpub-digest'));
    none.stats24h = { ...none.stats24h, runs: 0, ok: 0 };
    assert.deepEqual(L.observations(none, '24h', NOW), ['За сутки ни одного хода из 1 по расписанию.']);
  });
  test('параметры в шапке (без cron; cron отдельно)', () => {
    assert.equal(L.taskParams(task('socpub-dev'), NOW), 'каждый час · основной бот · socpublisher · задание ИИ · следующий 14:00');
    assert.equal(L.taskCron(task('socpub-dev')), '0 * * * *');
    assert.equal(L.taskParams(task('server-backup'), NOW), 'ежедневно ~06:00 · таймер сервера · без ИИ · следующий завтра 06:00');
    assert.equal(L.taskCron(task('server-backup')), '0 6 * * *');
    assert.equal(L.taskParams(task('socpub-alarm'), NOW), 'по событию · основной бот · socpublisher · задание ИИ · ждёт события');
    assert.equal(L.taskCron(task('socpub-alarm')), null);
  });
  test('схлоп одинаковых молча в последних ходах', () => {
    const g = L.groupedLastRuns(task('proxyapi-balance'), 8, NOW);
    assert.ok(g.length >= 1);
    assert.ok(g.every((x) => x.count >= 1 && x.run));
  });
});

describe('сервер', () => {
  test('четыре показателя', () => {
    const k = L.serverKpis(S.server);
    assert.deepEqual(k.map((x) => n(x.value)), ['27 %', '3,1 ГБ', '57 %', '307 МБ']);
    assert.equal(n(k[0]!.label), 'Процессор · 8 ядер');
    assert.equal(n(k[0]!.sub), 'нагрузка 2,2 · ожидание диска 10 %');
    assert.equal(n(k[1]!.sub), '32 % · ещё 5,5 ГБ кэш · свободно 6,6 ГБ');
    assert.equal(n(k[2]!.sub), 'занято 44 ГБ · свободно 33 ГБ');
    assert.equal(n(L.serverKpis({ ...S.server, swapTotalMb: 0, swapUsedMb: 0 })[3]!.sub), 'не настроена');
  });
  test('службы: тяжёлые сверху, затем по памяти; службы ботов — в той же таблице', () => {
    const rows = L.serviceRows(S);
    assert.equal(rows.length, 12);
    assert.equal(rows[0]!.name, 'Проверки socpublisher');
    assert.deepEqual(rows.slice(1, 4).map((r) => r.name), ['SMM-бот', 'Личный бот', 'Основной бот']);
    for (let i = 2; i < rows.length; i++) assert.ok((rows[i - 1]!.memMb ?? 0) >= (rows[i]!.memMb ?? 0));
  });
  test('служебные процессы платформы и уровни служб', () => {
    assert.equal(n(L.platformLine(S.platform)!.text), 'Ещё 5 служебных процессов платформы ботов — в норме');
    assert.equal(L.platformLine({ total: 5, ok: 3, failed: 2 })!.level, 'crit');
    assert.equal(L.platformLine({ total: 0, ok: 0, failed: 0 }), null);
    assert.equal(L.serviceLevel('active'), 'good');
    assert.equal(L.serviceLevel('active', true), 'serious');
    assert.equal(L.serviceLevel('failed'), 'crit');
    assert.equal(L.serviceLevel('activating'), 'warn');
    assert.equal(L.serviceLevel('inactive'), 'off');
    assert.equal(L.serviceStateWord('failed'), 'упала');
    assert.equal(L.serviceStateWord('weird'), 'weird');
  });
});

describe('графики: оси и ряды', () => {
  test('верх оси', () => {
    assert.equal(L.niceMax(7.36e6), 8e6);
    assert.equal(L.niceMax(4.4), 5);
    assert.equal(L.niceMax(100), 100);
    assert.equal(L.niceMax(0), 1);
    assert.equal(L.niceMax(1518528), 2e6);
  });
  test('дыры в рядах', () => {
    const pts = [0, 1, 2, 10, 11].map((t) => ({ t: t * 60e3, v: t }));
    assert.equal(L.medianStep(pts), 60e3);
    assert.deepEqual(L.splitSegments(pts, 180e3).map((s) => s.length), [3, 2]);
    assert.equal(L.medianStep([]), 0);
  });
  test('подписи оси времени — круглые часы и полночи МСК', () => {
    const t24 = L.timeTicks(NOW - 864e5, NOW, 5);
    assert.ok(t24.length <= 5);
    assert.deepEqual(t24.map((x) => x.label), ['18:00', '00:00', '06:00', '12:00']);
    assert.equal(t24[1]!.midnight, true);
    const t7 = L.timeTicks(NOW - 7 * 864e5, NOW, 10);
    assert.deepEqual(t7.map((x) => x.label), ['23.10', '24.10', '25.10', '26.10', '27.10', '28.10', '29.10']);
    for (const x of t7) assert.equal(L.fmtTime(x.t), '00:00');
    assert.ok(L.timeTicks(NOW - 30 * 864e5, NOW, 8).length <= 8);
    assert.deepEqual(L.midnights(NOW - 864e5, NOW).map((t) => new Date(t).toISOString()), ['2026-10-28T21:00:00.000Z']);
  });
  test('ряд истории и его итог для подписи', () => {
    const pts = L.seriesOf([
      { t: '2026-10-29T10:00:00Z', cpu: 30, mem: 1, disk: 1, swap: 1 },
      { t: '2026-10-29T09:00:00Z', cpu: 10, mem: 1, disk: 1, swap: 1 },
      { t: 'мусор', cpu: 5, mem: 1, disk: 1, swap: 1 },
    ], 'cpu');
    assert.deepEqual(pts.map((p) => p.v), [10, 30]);
    assert.equal(n(L.seriesSummary(pts)), 'сейчас 30 %, за период от 10 до 30 %, в среднем 20 %');
    assert.equal(L.seriesSummary([]), 'данных нет');
  });
  test('лента «кто что делал»', () => {
    const lane = L.laneRows(S, NOW);
    assert.deepEqual(lane.rows.map((r) => r.label), ['Основной · чат', 'Основной · фон', 'SMM · чат', 'Личный · чат', 'Сервер']);
    assert.equal(lane.rows[1]!.gaps.length, 1);
    assert.equal(lane.rows[1]!.gaps[0]!.taskName, 'socpublisher: разработчик');
    assert.equal(lane.rows[4]!.spans.length, 4, 'три сбора X и копия');
    assert.ok(lane.rows[2]!.spans.some((sp) => sp.live));
    const q = L.laneRows(Q, NOW);
    assert.deepEqual(q.rows.map((r) => r.label), ['Основной · чат', 'SMM · чат', 'Личный · чат']);
  });
  test('подсказка к отрезку', () => {
    const live = S.bots[1]!.timeline.find((sp) => sp.live)!;
    const tt = L.spanTooltip(live, NOW);
    assert.equal(tt.title, 'infosecurity → прод');
    assert.equal(n(tt.sub), '12:52–сейчас · 52 мин · идёт сейчас');
    const bg = L.spanTooltip({ start: '2026-10-29T10:00:00Z', end: '2026-10-29T10:05:00Z', kind: 'bg', status: 'silent' }, NOW);
    assert.equal(bg.title, 'фоновый ход');
    assert.equal(n(bg.sub), '13:00–13:05 · 5 мин · фоновый ход · молча');
  });
});

describe('фикстуры: логика не падает ни на одной задаче и периоде', () => {
  for (const snap of [S, Q]) {
    test(`снимок ${snap === S ? 'обычный' : 'тихий'}`, () => {
      L.overviewSummary(snap, NOW);
      L.laneRows(snap, NOW);
      L.serviceRows(snap);
      for (const b of snap.bots) L.botNowInfo(b, snap, NOW);
      for (const t of snap.tasks) {
        for (const r of L.RANGES) {
          L.observations(t, r, NOW);
          L.taskKpis(t, r, NOW);
          L.stripSummary(t, r, NOW);
          if (r !== '24h') L.dayCells(t, r, NOW);
        }
        L.taskParams(t, NOW);
        L.lastRuns(t).forEach(({ index }) => L.runOutcome(t, index, NOW));
      }
    });
  }
});
