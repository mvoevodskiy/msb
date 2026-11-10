// Генератор фикстур интерфейса: tests/fixtures/ui/*.json. Данные — из утверждённых макетов v2
// (concept/v2/data.js и dev.js: ходы «socpublisher: разработчик», ленты ботов, ряды процессора и памяти).
// Объекты типизированы контрактом (src/shared/types.ts) — tsc проверяет, что фикстуры ему соответствуют.
// Запуск: node tests/ui/make-fixtures.ts  (результат детерминирован — «сейчас» зафиксировано).

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Snapshot, Task, Run, Span, Bot, HistoryResponse, RunStatus } from '../../src/shared/types.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUT = join(ROOT, 'tests', 'fixtures', 'ui');

/** «Сейчас» фикстуры: 29.10.2026 13:45 МСК. */
export const NOW = Date.parse('2026-10-29T10:45:00Z');
const BASE = NOW - 864e5;
const iso = (ms: number) => new Date(Math.round(ms)).toISOString();
const atH = (h: number) => iso(BASE + h * 3600e3);
const H = 3600e3;

function readConst(file: string, name: string): unknown {
  const src = readFileSync(join(ROOT, 'concept', 'v2', file), 'utf8');
  const m = src.match(new RegExp(`const ${name}=(.*?);\\s*$`, 'm'));
  if (!m) throw new Error(`нет ${name} в ${file}`);
  return JSON.parse(m[1]);
}

type DevRow = [string, 'ok' | 'skipped', number, number, number, number];
type TlChat = [number, number, number, number, string];
type TlBg = [number, number, 'ok' | 'skipped', string, number];
const DEV = readConst('dev.js', 'DEV') as DevRow[];
const TL = readConst('data.js', 'TL') as { default: TlChat[]; SMM: TlChat[]; personal: TlChat[]; bg: TlBg[] };
const CPU = readConst('data.js', 'CPU') as [number, number][];
const MEM = readConst('data.js', 'MEM') as [number, number][];

// ---------- ленты ботов ----------

const neutral = (t: string) => (t === '[multimodal]' ? 'голосовое сообщение' : t);
const chatSpans = (rows: TlChat[], label?: string): Span[] =>
  rows.map((r) => ({ start: atH(r[0]), end: atH(r[1]), kind: 'chat', label: label ?? neutral(r[4]).trim() }));
const bgSpans: Span[] = TL.bg.map((r) => ({
  start: atH(r[0]), end: atH(r[0] + Math.max(r[1], 0.01)), kind: 'bg',
  status: r[2] === 'ok' ? 'ok' : 'silent', label: r[3].replace(/^Задача: /, '').replace(/ \(демо Zapcita\)…$/, ''),
}));

// ---------- задачи ----------

const devRuns: Run[] = DEV.map((r) => ({
  at: r[0], status: r[1] === 'ok' ? 'ok' : 'silent', durationSec: Math.round(r[2] / 1000), tokens: r[3],
  helpers: r[5], usd: Math.round(r[4] * 1000) / 1000, detail: null,
}));

function stats(runs: Run[], expected: number | null, missed: number) {
  const inDay = runs.filter((r) => Date.parse(r.at) > NOW - 864e5);
  return {
    expected, runs: inDay.length,
    ok: inDay.filter((r) => r.status === 'ok').length,
    silent: inDay.filter((r) => r.status === 'silent').length,
    error: inDay.filter((r) => r.status === 'error').length,
    missed,
    tokens: inDay.reduce((n, r) => n + r.tokens, 0),
    minutes: Math.round(inDay.reduce((n, r) => n + r.durationSec, 0) / 6) / 10,
    usd: Math.round(inDay.reduce((n, r) => n + (r.usd ?? 0), 0) * 100) / 100,
  };
}

const devSlots: RunStatus[] = [];
for (let k = 0; k < 24; k++) {
  const slot = Date.parse('2026-10-28T11:00:00Z') + k * H;
  devSlots.push(devRuns.some((r) => Math.abs(Date.parse(r.at) - slot) < 30 * 60e3) ? 'silent' : 'missed');
}

const devCommits = [
  ['2026-10-26T08:10:00Z', 'a1c03e2', 'Очередь публикаций: повтор при 429 от Telegram'],
  ['2026-10-26T11:40:00Z', '4be19f0', 'Предпросмотр: кнопки одобрения под постом'],
  ['2026-10-26T13:20:00Z', '9d2e771', 'Тесты: сценарии отклонения и правки'],
  ['2026-10-26T17:30:00Z', 'c7f4a10', 'Клиентский формат job.json: проверка картинок'],
  ['2026-10-26T19:45:00Z', '0e6b5d3', 'Журнал публикаций: причина отказа'],
  ['2026-10-27T02:30:00Z', '57aa0c9', 'outbox: результат с адресом поста'],
  ['2026-10-27T05:20:00Z', 'b3d9e48', 'Требования 260–271: расписание публикаций'],
  ['2026-10-27T11:30:00Z', 'e81f2c6', 'Telegram: альбомы до 10 картинок'],
  ['2026-10-27T14:25:00Z', '2fd06a1', 'Тесты: альбомы и подписи'],
  ['2026-10-27T17:20:00Z', '7c5b3e0', 'Проверки: отчёт о покрытии требований'],
  ['2026-10-27T21:15:00Z', 'd40e9b2', 'Повтор одобрения после правки текста'],
  ['2026-10-28T07:20:00Z', '13ab7f5', 'Требования 280–288: отмена публикации'],
  ['2026-10-29T03:17:00Z', '6acd4d8', 'Публикация: защита от двойной отправки'],
  ['2026-10-29T06:17:00Z', '33c6473', 'Требования 289–294: статусы в outbox'],
  ['2026-10-29T10:23:00Z', 'fbca3e5', 'Тесты: 6 037 зелёных'],
].map(([at, hash, subject]) => ({ at: at!, hash: hash!, subject: subject! }));

const devTask: Task = {
  id: 'socpub-dev', name: 'socpublisher: разработчик', bot: 'default', botName: 'Основной', project: 'socpublisher', kind: 'prompt',
  schedule: { type: 'cron', text: 'каждый час', cron: '0 * * * *', timezone: 'Europe/Moscow' },
  expect: 'в чат — только итог этапа; работа видна по коммитам', noAi: false,
  lastRun: devRuns[devRuns.length - 1]!, nextRunAt: '2026-10-29T11:00:00.000Z',
  stats24h: stats(devRuns, 24, 12), slots24h: devSlots, runs: devRuns,
  gaps: [{ from: '2026-10-28T08:00:00.000Z', to: '2026-10-28T22:00:00.000Z', missed: 15 }],
  attention: 'warn', attentionText: 'не запускался 28.10 с 11:00 до 01:00 — 15 ходов',
  pulse: { updatedAt: '2026-10-29T10:05:12.000Z', phase: 'ход закончен', text: 'зависших нет', nextBy: '2026-10-29T11:15:00.000Z', fresh: true },
  commits: devCommits,
};

const daily = (hourUtc: number, min: number, mk: (d: number) => Partial<Run>): Run[] =>
  [26, 27, 28, 29].map((d) => ({ at: iso(Date.parse(`2026-10-${d}T00:00:00Z`) + hourUtc * H + min * 60e3), status: 'ok', durationSec: 30, tokens: 0, helpers: 0, usd: null, detail: null, ...mk(d) }) as Run)
    .filter((r) => Date.parse(r.at) <= NOW);

const digestRuns = daily(5, 0.5, (d) => ({ status: 'ok', durationSec: 37 + (d % 3) * 4, tokens: [512340, 601234, 533900, 558791][d - 26]!, usd: 0.48 + (d % 2) * 0.05 }));
const proxyRuns = daily(7, 0.5, (d) => ({ status: 'silent', durationSec: 6, tokens: [44120, 43870, 42990, 43994][d - 26]!, usd: 0.04, detail: `баланс ${['351,10', '345,62', '340,18', '334,75'][d - 26]} ₽` }));
const backupRuns = daily(3, 8, (d) => ({ status: 'ok', durationSec: 410 + d, detail: `сделана · ${['2,0', '2,0', '2,1', '2,1'][d - 26]} ГБ` }));
const xRuns: Run[] = [
  { at: '2026-10-29T04:20:31.000Z', status: 'ok', durationSec: 48, tokens: 0, helpers: 0, usd: null, detail: '41 пост · $0,007' },
  { at: '2026-10-29T07:20:12.000Z', status: 'ok', durationSec: 39, tokens: 0, helpers: 0, usd: null, detail: '12 постов · $0,002' },
  { at: '2026-10-29T10:20:05.000Z', status: 'ok', durationSec: 44, tokens: 0, helpers: 0, usd: null, detail: '29 постов · $0,005' },
];
const alarmRuns: Run[] = [{ at: '2026-10-26T17:39:00.000Z', status: 'ok', durationSec: 21, tokens: 61234, helpers: 0, usd: 0.06, detail: 'фон завис — сообщение в чат' }];

const base: Pick<Task, 'gaps' | 'attention' | 'attentionText' | 'pulse' | 'commits'> = { gaps: [], attention: null, attentionText: null, pulse: null, commits: [] };
const tasks: Task[] = [
  devTask,
  { ...base, id: 'socpub-digest', name: 'socpublisher: утренняя сводка', bot: 'default', botName: 'Основной', project: 'socpublisher', kind: 'digest',
    schedule: { type: 'cron', text: 'ежедневно 08:00', cron: '0 8 * * *', timezone: 'Europe/Moscow' }, expect: 'сводка в чат каждое утро', noAi: false,
    lastRun: digestRuns[digestRuns.length - 1]!, nextRunAt: '2026-10-30T05:00:00.000Z', stats24h: stats(digestRuns, 1, 0), slots24h: ['ok'], runs: digestRuns, gaps: [] },
  { ...base, id: 'proxyapi-balance', name: 'Баланс ProxyAPI', bot: 'default', botName: 'Основной', project: 'Zapcita', kind: 'prompt',
    schedule: { type: 'cron', text: 'ежедневно 10:00', cron: '0 10 * * *', timezone: 'Europe/Moscow' }, expect: 'пишет, только если баланс ниже порога', noAi: false,
    lastRun: proxyRuns[proxyRuns.length - 1]!, nextRunAt: '2026-10-30T07:00:00.000Z', stats24h: stats(proxyRuns, 1, 0), slots24h: ['silent'], runs: proxyRuns, gaps: [] },
  { ...base, id: 'socpub-alarm', name: 'socpublisher: тревога фона', bot: 'default', botName: 'Основной', project: 'socpublisher', kind: 'prompt',
    schedule: { type: 'event', text: 'по событию' }, expect: 'сообщит, если фон завис', noAi: false,
    lastRun: alarmRuns[0]!, nextRunAt: null, stats24h: stats(alarmRuns, null, 0), slots24h: [], runs: alarmRuns, gaps: [] },
  { ...base, id: 'offer-reminder', name: 'Напоминание: оферта до 31.10 закончилась', bot: 'default', botName: 'Основной', project: 'Zapcita', kind: 'reminder',
    schedule: { type: 'once', text: 'разово' }, expect: 'текст в чат', noAi: false,
    lastRun: null, nextRunAt: '2026-11-01T05:44:00.000Z', stats24h: stats([], null, 0), slots24h: [], runs: [], gaps: [] },
  { ...base, id: 'infosec-x', name: 'Сбор постов X', bot: 'SMM', botName: 'SMM', project: 'infosecurity', kind: 'timer',
    schedule: { type: 'interval', text: 'каждые 3 ч', everySec: 10800 }, expect: 'пополняет ленту сборщика; предохранитель $2 в месяц', noAi: true,
    lastRun: xRuns[2]!, nextRunAt: '2026-10-29T13:21:00.000Z', stats24h: stats(xRuns, 3, 0), slots24h: ['ok', 'ok', 'ok'], runs: xRuns, gaps: [] },
  { ...base, id: 'server-backup', name: 'Резервная копия сервера', bot: 'server', botName: 'Сервер', project: null, kind: 'timer',
    schedule: { type: 'cron', text: 'ежедневно ~06:00', cron: '0 6 * * *', timezone: 'Europe/Moscow' }, expect: 'шифрованная копия сервера', noAi: true,
    lastRun: backupRuns[backupRuns.length - 1]!, nextRunAt: '2026-10-30T03:00:00.000Z', stats24h: stats(backupRuns, 1, 0), slots24h: ['ok'], runs: backupRuns, gaps: [] },
];

// ---------- боты ----------

const SINCE = '2026-10-28T20:25:00.000Z';
const svc = (memMb: number, cpuCores: number) => ({ state: 'active', since: SINCE, restarts: 0, memMb, cpuCores });
const bots: Bot[] = [
  {
    id: 'default', name: 'Основной', projects: ['Zapcita', 'socpublisher'], service: svc(236, 0.01),
    now: { busy: false, since: null, kind: null, text: null, helpers: 0 },
    lastResult: { at: '2026-10-28T22:01:00.000Z', text: 'ответ про переезд сервера', durationMin: 89, actions: 234 },
    chat24h: { requests: 5, minutes: 93 },
    bg24h: { tasks: 3, runs: 14, tokens: tasks.slice(0, 3).reduce((n, t) => n + t.stats24h.tokens, 0), minutes: 26 },
    timeline: [...chatSpans(TL.default), ...bgSpans],
  },
  {
    id: 'SMM', name: 'SMM', projects: ['infosecurity', 'Zapcita — соцсети', 'кемперы'], service: svc(1034, 0.02),
    now: { busy: true, since: atH(23.13), kind: 'chat', text: 'infosecurity → прод', helpers: 4 },
    lastResult: { at: '2026-10-29T05:38:00.000Z', text: 'пост в тест-канале InfoSecurity', durationMin: 52, actions: 780 },
    chat24h: { requests: 1, minutes: 52 }, bg24h: { tasks: 0, runs: 0, tokens: 0, minutes: 0 },
    timeline: [...chatSpans(TL.SMM, 'пост для тест-канала InfoSecurity'), { start: atH(23.13), end: iso(NOW), kind: 'chat', label: 'infosecurity → прод', live: true }],
  },
  {
    id: 'personal', name: 'Личный', projects: ['Задачи с созвонов', 'Пульт', 'личное'], service: svc(256, 0.01),
    now: { busy: true, since: atH(23.78), kind: 'chat', text: 'концепт панели мониторинга', helpers: 0 },
    lastResult: { at: '2026-10-29T10:26:00.000Z', text: 'роли ботов записаны', durationMin: 2, actions: 9 },
    chat24h: { requests: 11, minutes: 59 }, bg24h: { tasks: 0, runs: 0, tokens: 0, minutes: 0 },
    timeline: [...chatSpans(TL.personal, 'личный запрос'), { start: atH(23.78), end: iso(NOW), kind: 'chat', label: 'концепт панели мониторинга', live: true }],
  },
];

// ---------- снимок ----------

const service = (id: string, name: string, project: string | null, memMb: number, cpuCores: number, extra: Partial<{ since: string; heavy: boolean }> = {}) =>
  ({ id, name, project, state: 'active', since: extra.since ?? SINCE, restarts: 0, memMb, cpuCores, heavy: extra.heavy ?? false });

export const snapshot: Snapshot = {
  schema: 1, host: 'Сервер ботов', collectedAt: '2026-10-29T10:44:58.000Z', collectMs: 840,
  server: {
    cores: 8, cpuPct: 27, iowaitPct: 10, load1: 2.2, memTotalMb: 9933, memUsedMb: 3174, memCacheMb: 5632, memAvailMb: 6759,
    swapTotalMb: 4096, swapUsedMb: 307, diskTotalGb: 77, diskUsedGb: 44, bootAt: '2026-10-28T20:20:00.000Z',
  },
  bots, tasks, tasksHidden: 32,
  services: [
    service('socpub-ci', 'Проверки socpublisher', 'socpublisher', 4506, 0.89, { since: '2026-10-28T21:02:00.000Z', heavy: true }),
    service('socpub-test', 'socpublisher, тест', 'socpublisher', 48, 0.003, { since: '2026-10-28T21:59:00.000Z' }),
    service('zapcita-outreach', 'WhatsApp-рассылка', 'Zapcita', 57, 0.004),
    service('zapcita-mail', 'Почта', 'Zapcita', 31, 0.002),
    service('zapcita-bot', 'Бот', 'Zapcita', 29, 0.002),
    service('postgresql', 'PostgreSQL', null, 15, 0.001),
    service('zapcita-site', 'Сайт', 'Zapcita', 12, 0.001),
    service('nginx', 'nginx', 'все сайты', 2, 0.001),
    service('pult-collector', 'Пульт: сборщик', 'Пульт', 38, 0.006, { since: '2026-10-29T08:10:00.000Z' }),
  ],
  platform: { total: 5, ok: 5, failed: 0 },
  projects: [
    { id: 'zapcita', name: 'Zapcita', owner: 'основной бот · соцсети — SMM', status: 'ok', statusText: 'работает', stage: 'первые продажи, Богота', next: '01.11 — конец оферты',
      services: [{ name: 'Бот', state: 'active' }, { name: 'Почта', state: 'active' }, { name: 'WhatsApp-рассылка', state: 'active' }, { name: 'Сайт', state: 'active' }],
      commitsToday: null, lastCommit: null, facts: [{ label: 'Деньги', value: 'ProxyAPI 334,75 ₽' }], asks: [], updatedAt: '2026-10-29T07:12:00.000Z' },
    { id: 'socpublisher', name: 'socpublisher', owner: 'основной бот', status: 'warn', statusText: 'тест', stage: 'MVP в тестовых каналах', next: 'альфа в прод 30–31.10',
      services: [{ name: 'socpublisher, тест', state: 'active' }, { name: 'Проверки socpublisher', state: 'active' }],
      commitsToday: 3, lastCommit: { at: '2026-10-29T10:23:00.000Z', subject: 'Тесты: 6 037 зелёных' },
      facts: [{ label: 'Тесты', value: '6 037 зелёных · требований 294 из 555' }], asks: ['где боевой экземпляр'], updatedAt: '2026-10-29T10:24:00.000Z' },
    { id: 'infosecurity', name: 'infosecurity', owner: 'SMM-бот', status: 'warn', statusText: 'к проду', stage: '1 пост в тест-канале', next: 'запуск сегодня',
      services: [], commitsToday: 4, lastCommit: { at: '2026-10-29T09:58:00.000Z', subject: 'Сайт: лента выпусков' },
      facts: [{ label: 'Сбор', value: 'сбор X в норме · сайт строится' }], asks: ['прод-ВМ и боевые каналы'], updatedAt: '2026-10-29T09:30:00.000Z' },
    { id: 'meeting-tasks', name: 'Задачи с созвонов', owner: 'личный бот · твой сервер', status: 'unknown', statusText: 'нет связи', stage: 'выложен 27.10, ждёт первую встречу', next: 'PostgreSQL',
      services: [], commitsToday: null, lastCommit: null,
      facts: [{ label: 'Связь', value: 'статус на панель — вторым этапом' }, { label: 'Хранилище', value: 'файлы, копии раз в сутки' }],
      asks: ['доступ к базе', 'Deepgram'], updatedAt: '2026-10-27T15:00:00.000Z' },
    { id: 'campers', name: 'Кемперы', owner: 'SMM-бот', status: 'pause', statusText: 'пауза до весны', stage: 'аренда до марта–апреля', next: 'аудитория к сезону',
      services: [], commitsToday: null, lastCommit: null, facts: [{ label: 'Соцсети', value: 'ТГ, ВК, Инста, MAX — пусто' }], asks: [], updatedAt: '2026-10-22T12:00:00.000Z' },
    { id: 'land', name: 'Земля', owner: 'без бота', status: 'pause', statusText: 'пауза', stage: 'на паузе', next: null,
      services: [], commitsToday: null, lastCommit: null, facts: [], asks: [], updatedAt: null },
  ],
  asks: [
    { id: 'a-socpub-prod', project: 'socpublisher', bot: 'default', botName: 'Основной', text: 'socpublisher: где ставить боевой экземпляр — на этом сервере или на ВМ',
      blocks: 'прод socpublisher и infosecurity', since: '2026-10-28T21:45:00.000Z' },
    { id: 'a-infosec-vm', project: 'infosecurity', bot: 'SMM', botName: 'SMM', text: 'infosecurity: адрес и доступ к прод-ВМ, боевые каналы, кнопка ✔ на первые 3 дня',
      blocks: 'запуск infosecurity сегодня', since: '2026-10-29T10:00:00.000Z' },
    { id: 'a-meet-db', project: 'meeting-tasks', bot: 'personal', botName: 'Личный', text: 'Задачи с созвонов: доступ к серверу базы и решение про голос через Deepgram',
      blocks: 'переход на PostgreSQL и голосовые', since: '2026-10-27T09:30:00.000Z' },
  ],
  attention: [
    { key: 'svc-heavy:socpub-ci', level: 'serious', text: 'Проверки socpublisher без перерыва с 00:02: 4,4 ГБ памяти и около одного ядра', project: 'socpublisher', link: { tab: 'server' }, since: '2026-10-28T21:02:00.000Z' },
    { key: 'task-gap:socpub-dev', level: 'warn', text: '«socpublisher: разработчик» не запускался 28.10 с 11:00 до 01:00 — 15 ходов', project: 'socpublisher', link: { tab: 'tasks', id: 'socpub-dev' }, since: '2026-10-28T08:00:00.000Z' },
    { key: 'task-expensive:socpub-dev', level: 'warn', text: 'Самый дорогой фон — «socpublisher: разработчик»: 8,4 млн токенов за сутки', project: 'socpublisher', link: { tab: 'tasks', id: 'socpub-dev' }, since: null },
  ],
  subscription: { status: 'allowed', resetsAt: '2026-10-29T11:00:00.000Z', windowType: 'five_hour', overage: false, updatedAt: '2026-10-29T10:40:00.000Z' },
  balances: [
    { id: 'proxyapi', name: 'ProxyAPI', value: '334,75 ₽', ok: true, checkedAt: '2026-10-29T07:00:32.000Z', stale: false, note: null },
    { id: 'apify', name: 'Apify', value: '$0,005 из $5', ok: true, checkedAt: '2026-10-29T10:20:05.000Z', stale: false, note: null },
    { id: 'deepgram', name: 'Deepgram', value: '$199,92', ok: true, checkedAt: '2026-10-25T09:00:00.000Z', stale: true, note: null },
  ],
  upcoming: [
    { at: '2026-10-29T11:00:00.000Z', name: 'socpublisher: разработчик', taskId: 'socpub-dev' },
    { at: '2026-10-29T13:21:00.000Z', name: 'Сбор постов X', taskId: 'infosec-x' },
    { at: '2026-10-30T03:00:00.000Z', name: 'Резервная копия сервера', taskId: 'server-backup' },
    { at: '2026-10-30T05:00:00.000Z', name: 'socpublisher: утренняя сводка', taskId: 'socpub-digest' },
    { at: '2026-10-30T07:00:00.000Z', name: 'Баланс ProxyAPI', taskId: 'proxyapi-balance' },
    { at: '2026-11-01T05:44:00.000Z', name: 'Напоминание: оферта до 31.10 закончилась', taskId: 'offer-reminder' },
  ],
  sourceErrors: [],
};

/** «Тихий» снимок: задач, вопросов и тревог нет; зато есть ошибки источников (неброская строка внизу). */
export const quiet: Snapshot = {
  ...snapshot,
  bots: bots.map((b) => ({ ...b, now: { busy: false, since: null, kind: null, text: null, helpers: 0 }, timeline: b.timeline.filter((s) => !s.live && s.kind === 'chat'), bg24h: { tasks: 0, runs: 0, tokens: 0, minutes: 0 } })),
  tasks: [], tasksHidden: 0, asks: [], attention: [], upcoming: [],
  services: snapshot.services.map((s) => ({ ...s, heavy: false, memMb: s.id === 'socpub-ci' ? 120 : s.memMb })),
  projects: snapshot.projects.map((p) => ({ ...p, asks: [] })),
  balances: snapshot.balances.map((b) => (b.id === 'proxyapi' ? { ...b, value: '41,20 ₽', ok: false } : b)),
  subscription: null,
  sourceErrors: [{ source: 'deepgram', message: 'команда не ответила за 20 с' }, { source: 'pulse:socpublisher', message: 'файл пульса не найден' }],
};

// ---------- история ----------

function rng(seed: number) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const round1 = (v: number) => Math.round(v * 10) / 10;

function history24(): HistoryResponse {
  const mem = new Map(MEM.map(([h, v]) => [h, v]));
  return { range: '24h', points: CPU.map(([h, v]) => ({ t: atH(h), cpu: v, mem: mem.get(h) ?? 25, disk: 57, swap: 7.5 })) };
}

function synth(range: '7d' | '30d', stepMin: number, seed: number): HistoryResponse {
  const r = rng(seed);
  const days = range === '7d' ? 7 : 30;
  const points: HistoryResponse['points'] = [];
  const day24 = history24().points.map((p) => ({ t: Date.parse(p.t), cpu: p.cpu, mem: p.mem }));
  for (let t = NOW - days * 864e5; t <= NOW; t += stepMin * 60e3) {
    // Переезд на новый сервер 28.10 18:00–23:25 МСК — данных нет.
    if (t > Date.parse('2026-10-28T15:00:00Z') && t < Date.parse('2026-10-28T20:25:00Z')) continue;
    const near = day24.filter((p) => Math.abs(p.t - t) <= (stepMin / 2) * 60e3);
    if (near.length) {
      points.push({ t: iso(t), cpu: round1(near.reduce((n, p) => n + p.cpu, 0) / near.length), mem: round1(near.reduce((n, p) => n + p.mem, 0) / near.length), disk: 57, swap: 7.5 });
      continue;
    }
    const hourMsk = ((t / H + 3) % 24 + 24) % 24;
    const daily = 6 + 10 * Math.max(0, Math.sin(((hourMsk - 8) / 24) * 2 * Math.PI));
    const spike = r() < 0.06 ? 25 + r() * 45 : 0;
    const old = t < Date.parse('2026-10-28T15:00:00Z');
    const cpu = Math.min(100, daily + spike + r() * 6 + (old ? 4 : 0));
    const mem = Math.min(100, (old ? 36 : 22) + r() * 6 + spike / 4);
    const disk = 48 + (9 * (t - (NOW - days * 864e5))) / (days * 864e5);
    points.push({ t: iso(t), cpu: round1(cpu), mem: round1(mem), disk: round1(disk), swap: round1(old ? 12 + r() * 3 : 7 + r()) });
  }
  return { range, points };
}

function write(name: string, data: unknown) {
  writeFileSync(join(OUT, name), JSON.stringify(data, null, 1) + '\n');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  mkdirSync(OUT, { recursive: true });
  write('snapshot.json', snapshot);
  write('snapshot-quiet.json', quiet);
  write('history-24h.json', history24());
  write('history-7d.json', synth('7d', 30, 7));
  write('history-30d.json', synth('30d', 120, 30));
  console.log(`Фикстуры записаны в ${OUT}`);
}
