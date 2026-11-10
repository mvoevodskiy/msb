import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyze, type AnalyzeInput } from '../../src/collector/analyze.ts';
import { SNAPSHOT_SCHEMA, type Bot, type Service } from '../../src/shared/types.ts';
import { expensiveFinding } from '../../src/collector/sources/tasks.ts';
import { NOW, fixtureConfig } from './helpers.ts';

const T = fixtureConfig().thresholds;

function input(patch: Partial<AnalyzeInput['snapshot']> = {}, extra: Partial<AnalyzeInput> = {}): AnalyzeInput {
  return {
    snapshot: {
      schema: SNAPSHOT_SCHEMA, host: 'x', collectedAt: NOW.toISOString(), collectMs: 0,
      server: { cores: 8, cpuPct: 27, iowaitPct: 10, load1: 2.2, memTotalMb: 9944, memUsedMb: 3100, memCacheMb: 5500, memAvailMb: 6600, swapTotalMb: 4096, swapUsedMb: 300, diskTotalGb: 77, diskUsedGb: 44, bootAt: NOW.toISOString() },
      bots: [], tasks: [], tasksHidden: 0, services: [], platform: { total: 0, ok: 0, failed: 0 }, projects: [], asks: [],
      subscription: null, balances: [], upcoming: [], sourceErrors: [],
      ...patch,
    },
    services: [],
    tasks: [],
    thresholds: T,
    tz: 'Europe/Moscow',
    now: NOW,
    ...extra,
  };
}

const bot = (id: string, name: string, state: string) => ({ id, name, service: { state, since: '2026-10-29T09:00:00.000Z' } }) as Bot;
const heavy: Service = { id: 'socpub-ci', name: 'Проверки socpublisher', project: 'socpublisher', heavy: true, state: 'active', since: '2026-10-28T21:02:51.000Z', restarts: 0, memMb: 4505, cpuCores: 0.89 };

test('всё в норме — пусто', () => {
  assert.deepEqual(analyze(input()), []);
});

test('бот не работает, служба не работает или не установлена; необязательные — молчат', () => {
  const a = analyze(input({ bots: [bot('SMM', 'SMM', 'failed'), bot('default', 'Основной', 'active')] }, {
    services: [
      { id: 'mail', name: 'Почта', optional: false, loaded: true, state: 'failed', since: '2026-10-29T09:30:00.000Z' },
      { id: 'collector', name: 'Пульт: сборщик', optional: false, loaded: false, state: 'inactive', since: null },
      { id: 'web', name: 'Пульт: веб', optional: true, loaded: false, state: 'inactive', since: null },
      { id: 'nginx', name: 'nginx', optional: false, loaded: true, state: 'active', since: null },
    ],
  }));
  assert.deepEqual(a.map(x => [x.key, x.level, x.text, x.link.tab]), [
    ['bot:SMM:down', 'crit', 'Бот «SMM» не работает (состояние: failed)', 'bots'],
    ['service:mail:down', 'crit', 'Служба «Почта» не работает (состояние: failed)', 'server'],
    ['service:collector:down', 'crit', 'Служба «Пульт: сборщик» не установлена', 'server'],
  ]);
  assert.equal(a[0].since, '2026-10-29T09:00:00.000Z');
});

test('память и диск по порогам', () => {
  const s = input().snapshot.server;
  const a = analyze(input({ server: { ...s, memUsedMb: 9200, diskUsedGb: 70 } }));
  assert.deepEqual(a.map(x => [x.key, x.text]), [
    ['server:mem', 'Память сервера занята на 93 %: 9,0 ГБ из 9,7 ГБ'],
    ['server:disk', 'Диск заполнен на 91 %: свободно 7 ГБ'],
  ]);
});

test('тяжёлая служба — как на эталоне', () => {
  const a = analyze(input({ services: [heavy, { ...heavy, id: 'light', heavy: false }] }));
  assert.deepEqual(a.map(x => [x.key, x.level, x.text]), [
    ['service:socpub-ci:heavy', 'serious', 'Проверки socpublisher: 4,4 ГБ памяти и ≈0,9 ядра, работает с 00:02'],
  ]);
});

test('задачи: текст с именем, ссылка на карточку; самый дорогой фон', () => {
  const a = analyze(input({}, {
    tasks: [{
      taskId: 'abc1234567', taskName: 'socpublisher: разработчик', project: 'socpublisher',
      findings: [
        { kind: 'gap', level: 'warn', since: '2026-10-28T08:00:00.000Z', text: 'не запускался 28.10 с 11:00 до 01:00 — 15 ходов, причина в журнале не записана' },
        expensiveFinding(8_367_471),
      ],
    }, { taskId: 'def', taskName: 'Сводка', project: null, findings: [{ kind: 'error', level: 'crit', since: null, text: 'последний ход закончился ошибкой: 401' }] }],
  }));
  assert.deepEqual(a.map(x => [x.key, x.level, x.text, x.project, x.link]), [
    ['task:def:error', 'crit', '«Сводка» последний ход закончился ошибкой: 401', null, { tab: 'tasks', id: 'def' }],
    ['task:abc1234567:gap', 'warn', '«socpublisher: разработчик» не запускался 28.10 с 11:00 до 01:00 — 15 ходов, причина в журнале не записана', 'socpublisher', { tab: 'tasks', id: 'abc1234567' }],
    ['task:abc1234567:expensive', 'warn', 'Самый дорогой фон — «socpublisher: разработчик»: 8,4 млн токенов за сутки', 'socpublisher', { tab: 'tasks', id: 'abc1234567' }],
  ]);
});

test('подписка: исчерпано — предупреждение со временем сброса; allowed_warning и прошедший сброс — молчим', () => {
  const sub = { status: 'rejected', resetsAt: '2026-10-29T16:00:00.000Z', windowType: 'five_hour', overage: false, updatedAt: '2026-10-29T10:40:00.000Z' };
  assert.deepEqual(analyze(input({ subscription: sub })).map(x => [x.key, x.level, x.text]), [['subscription', 'warn', 'Окно подписки исчерпано, сброс в 19:00']]);
  assert.deepEqual(analyze(input({ subscription: { ...sub, status: 'allowed_warning' } })), []);
  assert.deepEqual(analyze(input({ subscription: { ...sub, resetsAt: '2026-10-29T10:00:00.000Z' } })), []);
});

test('ошибки источников; порядок по важности; ключи без времени и без повторов', () => {
  const a = analyze(input({
    services: [heavy],
    sourceErrors: [{ source: 'Deepgram', message: 'нет ключа' }, { source: 'Deepgram', message: 'другое' }],
    bots: [bot('SMM', 'SMM', 'inactive')],
  }));
  assert.deepEqual(a.map(x => [x.key, x.level]), [
    ['bot:SMM:down', 'crit'],
    ['service:socpub-ci:heavy', 'serious'],
    ['source:Deepgram', 'warn'],
  ]);
  assert.equal(a[2].text, 'Не удалось прочитать: Deepgram');
  assert.ok(a.every(x => !/\d\d:\d\d|\d{4}-/.test(x.key)));
});
