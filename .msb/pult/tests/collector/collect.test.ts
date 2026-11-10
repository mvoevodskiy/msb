import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { Collector } from '../../src/collector/collect.ts';
import { SNAPSHOT_SCHEMA, type Snapshot } from '../../src/shared/types.ts';
import type { ExecResult } from '../../src/collector/util.ts';
import { FIX, NOW, fakeExec, fixtureConfig } from './helpers.ts';

function collector(exec = fakeExec(), cfg = fixtureConfig()) {
  return new Collector(cfg, {
    procRoot: join(FIX, 'proc'), cgroupRoot: join(FIX, 'cgroup'), diskPath: FIX, exec,
    env: { DEEPGRAM_API_KEY: 'тест' }, clock: () => NOW, firstCpuSampleMs: 0, serverTz: 'Etc/UTC',
  });
}

let cached: Snapshot | null = null;
async function snapshot(): Promise<Snapshot> {
  cached ??= await collector().collect();
  return cached;
}

test('снимок целиком: схема, время, сервер', async () => {
  const s = await snapshot();
  assert.equal(s.schema, SNAPSHOT_SCHEMA);
  assert.equal(s.host, 'Тестовый сервер');
  assert.equal(s.collectedAt, '2026-10-29T10:45:00.000Z');
  assert.ok(s.collectMs >= 0 && s.collectMs < 2000);
  assert.equal(s.server.memTotalMb, 9944);
  assert.equal(s.server.load1, 2.2);
  assert.equal(s.server.bootAt, '2026-10-29T00:00:00.000Z');
  assert.deepEqual(s.sourceErrors, [{ source: 'бот «Гамма»: фоновые задачи', message: 'файл повреждён (не JSON)' }]);
});

test('в снимок не попадают имена платформы, её пути, внутренние id и чужие ключи state.json', async () => {
  const json = JSON.stringify(await snapshot());
  for (const bad of ['msb', 'iia', 'jarvis', '.msb', '.iia', 'conv-prompt', 'do-not-leak', 'sessionSecret', '/system.slice', 'index.js']) {
    assert.ok(!json.toLowerCase().includes(bad.toLowerCase()), `в снимке есть «${bad}»`);
  }
});

test('боты: занятость, помощники, последний итог, сутки, отрезки', async () => {
  const [alpha, beta, gamma] = (await snapshot()).bots;
  assert.deepEqual(alpha.now, { busy: true, since: '2026-10-29T10:30:00.000Z', helpers: 1, kind: 'chat', text: 'Проверь сервер и расскажи, что с памятью' });
  assert.deepEqual(alpha.service, { state: 'active', since: '2026-10-28T20:25:21.000Z', restarts: 0, memMb: 238, cpuCores: 0.01 });
  assert.deepEqual(alpha.lastResult, { at: '2026-10-29T08:10:00.200Z', text: 'Отчёт готов: 3 задачи в норме, каталог … не трогал.', durationMin: 89, actions: 234 });
  assert.deepEqual(alpha.chat24h, { requests: 2, minutes: 99 });
  assert.deepEqual(alpha.bg24h, { tasks: 2, runs: 5, tokens: 5_037_600, minutes: 9 });
  assert.deepEqual(alpha.projects, ['Демо']);
  const live = alpha.timeline.filter(x => x.live);
  assert.deepEqual(live, [{ start: '2026-10-29T10:30:00.000Z', end: '2026-10-29T10:45:00.000Z', kind: 'chat', live: true, label: 'Проверь сервер и расскажи, что с памятью' }]);
  assert.equal(alpha.timeline.filter(x => x.kind === 'bg').length, 5);
  assert.equal(beta.now.busy, false);
  assert.equal(beta.lastResult?.text, '🔴 Нужно от тебя: ответить на 2 вопроса Пост вышел в тест-канале.');
  assert.equal(beta.service.memMb, 95, 'anon без kernel — так в memory.stat');
  assert.deepEqual(beta.bg24h, { tasks: 0, runs: 0, tokens: 0, minutes: 0 });
  assert.equal(gamma.service.state, 'failed');
  assert.equal(gamma.now.busy, false);
  assert.equal(gamma.lastResult, null);
});

test('задачи: активные с таймерами, требующие внимания сверху; неактивные — в счётчик', async () => {
  const s = await snapshot();
  assert.equal(s.tasksHidden, 3);
  assert.deepEqual(s.tasks.map(t => [t.name, t.bot, t.attention]), [
    ['Разработка демо', 'alpha', 'crit'],
    ['Демо: тревога фона', 'alpha', null],
    ['Напоминание: оферта закончилась', 'alpha', null],
    ['Резервная копия', 'server', null],
    ['Сбор постов X', 'beta', null],
  ]);
  const dev = s.tasks[0];
  assert.equal(dev.attentionText, 'последний ход закончился ошибкой: упал на шаге 2: нет файла …');
  assert.equal(dev.project, 'Демо');
  assert.equal(dev.expect, 'итог этапа в чат');
  assert.deepEqual(dev.slots24h, ['ok', 'silent', 'missed', 'missed', 'missed', 'silent', 'error']);
  assert.deepEqual(dev.stats24h, { expected: 7, runs: 4, ok: 1, silent: 2, error: 1, missed: 3, tokens: 5_032_100, minutes: 8.2, usd: 3.761 });
  assert.deepEqual(dev.gaps, [{ from: '2026-10-29T06:00:00.000Z', to: '2026-10-29T08:00:00.000Z', missed: 3 }]);
  assert.equal(dev.nextRunAt, '2026-10-29T11:00:00.000Z');
  assert.deepEqual(dev.pulse, { updatedAt: '2026-10-29T10:20:00.000Z', phase: 'работает', text: 'пишу тесты', nextBy: '2026-10-29T10:35:00.000Z', fresh: false });
  assert.deepEqual(dev.commits.map(c => c.hash), ['c1b2c3d', 'b1b2c3d', 'a1b2c3d']);
  const alarm = s.tasks[1];
  assert.deepEqual(alarm.schedule, { type: 'event', text: 'по событию: файл' });
  assert.equal(alarm.expect, 'сообщит, если фон завис');
  assert.deepEqual(alarm.slots24h, ['ok']);
  assert.equal(alarm.stats24h.expected, null);
  const reminder = s.tasks[2];
  assert.equal(reminder.expect, 'текст в чат');
  assert.equal(reminder.nextRunAt, '2026-11-01T05:44:58.222Z');
  assert.equal(reminder.project, null);
  const backup = s.tasks[3];
  assert.equal(backup.botName, 'Сервер');
  assert.equal(backup.schedule.text, 'ежедневно ~06:00');
  assert.equal(backup.runs.length, 2);
  const x = s.tasks[4];
  assert.equal(x.botName, 'Бета');
  assert.equal(x.lastRun?.detail, '29 постов · $0,005');
});

test('службы: необязательная без юнита скрыта, тяжёлая отмечена, по памяти', async () => {
  const s = await snapshot();
  assert.deepEqual(s.services.map(x => [x.id, x.state, x.memMb, x.heavy]), [
    ['heavy', 'active', 4505, true],
    ['web', 'active', 50, false],
    ['down', 'failed', null, false],
  ]);
  assert.deepEqual(s.platform, { total: 2, ok: 1, failed: 1 });
});

test('проекты, вопросы, подписка, остатки, ближайшие запуски', async () => {
  const s = await snapshot();
  assert.deepEqual(s.projects.map(p => p.id), ['tools', 'demo']);
  const demo = s.projects[1];
  assert.deepEqual(demo.services, [{ name: 'Проверки демо', state: 'active' }, { name: 'Сайт', state: 'active' }]);
  assert.equal(demo.commitsToday, 2);
  assert.deepEqual(demo.asks, ['Доступ к базе', 'Где ставить боевой экземпляр']);
  assert.deepEqual(s.asks.map(a => [a.id, a.botName]), [['a1', 'Бета'], ['a2', 'Альфа']]);
  assert.deepEqual(s.subscription, { status: 'allowed_warning', resetsAt: '2026-10-29T16:00:00.000Z', windowType: 'five_hour', overage: false, updatedAt: '2026-10-29T11:23:20.000Z' });
  assert.deepEqual(s.balances.map(b => [b.id, b.value, b.ok]), [['proxyapi', '334,75 ₽', true], ['apify', '$0,007 из $5', true], ['deepgram', '$199,90', true]]);
  assert.deepEqual(s.upcoming.map(u => [u.at, u.name]), [
    ['2026-10-29T11:00:00.000Z', 'Разработка демо'],
    ['2026-10-29T12:22:12.000Z', 'Сбор постов X'],
    ['2026-10-30T03:16:19.000Z', 'Резервная копия'],
    ['2026-11-01T05:44:58.222Z', 'Напоминание: оферта закончилась'],
  ]);
  assert.ok(s.upcoming.every(u => s.tasks.some(t => t.id === u.taskId)));
});

test('что требует внимания: по важности, со ссылками', async () => {
  const s = await snapshot();
  const dev = s.tasks[0].id;
  assert.deepEqual(s.attention.map(a => [a.key, a.level, a.text]), [
    ['bot:gamma:down', 'crit', 'Бот «Гамма» не работает (состояние: failed)'],
    ['service:down:down', 'crit', 'Служба «Почта» не работает (состояние: failed)'],
    [`task:${dev}:error`, 'crit', '«Разработка демо» последний ход закончился ошибкой: упал на шаге 2: нет файла …'],
    [`task:${dev}:pulse`, 'crit', '«Разработка демо» пульс не обновлялся с 13:20 — ход мог зависнуть'],
    ['service:heavy:heavy', 'serious', 'Проверки демо: 4,4 ГБ памяти и ≈0,9 ядра, работает с 00:02'],
    [`task:${dev}:gap`, 'warn', '«Разработка демо» не запускался 29.10 с 09:00 до 11:00 — 3 хода, причина в журнале не записана'],
    [`task:${dev}:expensive`, 'warn', 'Самый дорогой фон — «Разработка демо»: 5,0 млн токенов за сутки'],
    ['source:бот «Гамма»: фоновые задачи', 'warn', 'Не удалось прочитать: бот «Гамма»: фоновые задачи'],
  ]);
});

test('падение источника не роняет снимок: нет systemd, git и Deepgram', async () => {
  const fail = (): ExecResult => ({ code: 1, stdout: '', stderr: 'Failed to connect to bus', error: 'Failed to connect to bus' });
  const s = await collector(fakeExec({ systemctl: fail, git: fail, 'deepgram-fake': fail })).collect();
  assert.ok(s.sourceErrors.some(e => e.source === 'systemd' && e.message === 'Failed to connect to bus'));
  assert.ok(s.sourceErrors.some(e => e.source.startsWith('git')));
  assert.equal(s.bots.length, 3);
  assert.equal(s.bots[0].service.state, 'unknown');
  assert.equal(s.bots[0].now.busy, false, 'без cgroup процессы не читаем');
  assert.ok(s.tasks.length >= 5);
  assert.equal(s.balances.find(b => b.id === 'deepgram')?.value, 'нет данных');
  assert.ok(s.attention.some(a => a.key === 'source:systemd'));
});

test('процессор: второй тик считает по разнице с первым', async () => {
  const c = collector();
  const first = await c.collect();
  assert.equal(first.server.cpuPct, 0, 'один и тот же файл — разницы нет');
  const second = await c.collect();
  assert.equal(second.server.cpuPct, 0);
  assert.equal(second.balances.find(b => b.id === 'deepgram')?.value, '$199,90', 'из памяти процесса');
});
