import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  actionSchedule, applyRules, buildTask, defaultExpect, expensiveFinding, findGaps, gapText, isActiveAction, parsePulse,
  runStats, scheduleFindings, slotStatuses, sortTasks, taskCommits, taskKind, topFinding, trailingGap,
} from '../../src/collector/sources/tasks.ts';
import { cleanTaskName, mapRunStatus, toRun, type ActionRec, type RunRec } from '../../src/collector/sources/journal.ts';
import { Problems } from '../../src/collector/util.ts';
import type { RunStatus, Task } from '../../src/shared/types.ts';
import { fixtureConfig, NOW } from './helpers.ts';

const H = 3_600_000;
const t = (s: string) => Date.parse(s);
const MSK = 'Europe/Moscow';

test('активные задачи: выключенные и отработавшие разовые — в свёрнутые', () => {
  const now = t('2026-10-29T10:45:00Z');
  const a = (x: Partial<ActionRec>): ActionRec => ({ id: 'x', ...x });
  assert.equal(isActiveAction(a({ enabled: true, trigger: { kind: 'cron', cron: '0 * * * *' } }), now), true);
  assert.equal(isActiveAction(a({ trigger: { kind: 'cron', cron: '0 * * * *' } }), now), true, 'enabled не задан — активна');
  assert.equal(isActiveAction(a({ enabled: false, trigger: { kind: 'cron', cron: '0 * * * *' } }), now), false);
  assert.equal(isActiveAction(a({ trigger: { kind: 'once', at: '2026-11-01T05:44:58Z' } }), now), true);
  assert.equal(isActiveAction(a({ trigger: { kind: 'once', at: '2026-10-29T10:00:00Z' } }), now), true, 'срок прошёл меньше часа назад');
  assert.equal(isActiveAction(a({ trigger: { kind: 'once', at: '2026-10-29T09:00:00Z' } }), now), false, 'срок прошёл больше часа назад');
  assert.equal(isActiveAction(a({ trigger: { kind: 'once', at: '2026-11-01T05:44:58Z' }, lastRunAt: '2026-10-29T07:00:00Z' }), now), false, 'уже отработала');
  assert.equal(isActiveAction(a({ trigger: { kind: 'when' } }), now), true);
});

test('имя задачи: без «Задача: » и хвостового «…»', () => {
  assert.equal(cleanTaskName('Задача: Баланс ProxyAPI (демо Zapcita)…'), 'Баланс ProxyAPI (демо Zapcita)');
  assert.equal(cleanTaskName('socpublisher: разработчик'), 'socpublisher: разработчик');
  assert.equal(cleanTaskName('Задача: Подготовь тексты...'), 'Подготовь тексты');
  assert.equal(cleanTaskName(undefined), 'без имени');
});

test('правила: проект — из первого совпавшего, остальные поля объединяются', () => {
  const cfg = fixtureConfig();
  assert.deepEqual(applyRules('Разработка демо', cfg.taskRules), { project: 'Демо', expect: 'итог этапа в чат', pulseFile: cfg.taskRules[1].pulseFile, repo: '/srv/demo' });
  assert.deepEqual(applyRules('Демо: ТРЕВОГА фона', cfg.taskRules), { project: 'Демо', expect: 'сообщит, если фон завис', pulseFile: null, repo: null });
  assert.deepEqual(applyRules('Что-то другое', cfg.taskRules), { project: null, expect: null, pulseFile: null, repo: null });
});

test('чего ждать по умолчанию и вид задачи', () => {
  assert.equal(defaultExpect({ id: 'x', task: { kind: 'reminder' }, output: { silentIfEmpty: true } }), 'текст в чат');
  assert.equal(defaultExpect({ id: 'x', trigger: { kind: 'when' }, output: { silentIfEmpty: true } }), 'сообщит при событии');
  assert.equal(defaultExpect({ id: 'x', trigger: { kind: 'cron' }, output: { silentIfEmpty: true } }), 'пишет, только если есть что сообщить');
  assert.equal(defaultExpect({ id: 'x', trigger: { kind: 'cron' } }), null);
  assert.equal(taskKind({ id: 'x', task: { kind: 'digest' } }), 'digest');
  assert.equal(taskKind({ id: 'x', requestedKind: 'draft' }), 'draft');
  assert.equal(taskKind({ id: 'x', task: { kind: 'странное' } }), 'other');
});

test('расписание задачи словами', () => {
  const now = NOW;
  assert.deepEqual(actionSchedule({ id: 'x', trigger: { kind: 'cron', cron: '0 * * * *', timezone: MSK } }, MSK, now, null).schedule,
    { type: 'cron', text: 'каждый час', cron: '0 * * * *', timezone: MSK });
  assert.equal(actionSchedule({ id: 'x', trigger: { kind: 'cron', cron: '0 5 * * *', timezone: 'UTC' } }, MSK, now, null).schedule.text, 'ежедневно 08:00');
  assert.deepEqual(actionSchedule({ id: 'x', trigger: { kind: 'once', at: '2026-11-01T05:44:58Z' } }, MSK, now, null),
    { schedule: { type: 'once', text: 'разово' }, spec: null, tz: MSK, atMs: t('2026-11-01T05:44:58Z') });
  assert.equal(actionSchedule({ id: 'x', trigger: { kind: 'when', check: { kind: 'path' } } }, MSK, now, null).schedule.text, 'по событию: файл');
  assert.equal(actionSchedule({ id: 'x', trigger: { kind: 'when', check: { kind: 'service' } } }, MSK, now, null).schedule.text, 'по событию: служба');
  assert.equal(actionSchedule({ id: 'x', trigger: { kind: 'when', check: { kind: 'inbox' } } }, MSK, now, null).schedule.text, 'по событию');
  // «recurring» с cron — тоже расписание
  assert.equal(actionSchedule({ id: 'x', trigger: { kind: 'recurring', cron: '0 20 * * *' } }, MSK, now, null).schedule.text, 'ежедневно 20:00');
  const p = new Problems();
  const bad = actionSchedule({ id: 'x', name: 'Кривая', trigger: { kind: 'cron', cron: '0 8 * *', timezone: 'Марс' } }, MSK, now, p);
  assert.deepEqual(bad.schedule, { type: 'cron', text: '0 8 * *', cron: '0 8 * *', timezone: MSK });
  assert.equal(bad.spec, null);
  assert.deepEqual(p.list.map(e => e.source), ['задача «Кривая»', 'задача «Кривая»']);
});

test('статусы ходов', () => {
  assert.equal(mapRunStatus('ok'), 'ok');
  assert.equal(mapRunStatus('skipped'), 'silent');
  assert.equal(mapRunStatus('failed'), 'error');
  assert.equal(mapRunStatus(undefined), 'error');
  const r: RunRec = { ts: '2026-10-29T10:00:34.488Z', actionId: 'a', status: 'skipped', detail: 'нечего сообщить', tokensIn: 1_504_828, tokensOut: 13_700, durationMs: 308_164, meteredUsd: 1.5482392, delegated: 2 };
  assert.deepEqual(toRun(r), { at: '2026-10-29T10:00:34.488Z', status: 'silent', durationSec: 308, tokens: 1_518_528, helpers: 2, usd: 1.5482, detail: 'нечего сообщить' });
  assert.deepEqual(toRun({ ts: '2026-10-29T10:00:00Z', status: 'ok' }), { at: '2026-10-29T10:00:00.000Z', status: 'ok', durationSec: 0, tokens: 0, helpers: 0, usd: null, detail: null });
});

test('слоты: ход в [слот − 2 мин, следующий слот), один ход — один слот, открытое окно — не пропуск', () => {
  const slots = [0, 1, 2, 3, 4].map(i => t('2026-10-29T06:00:00Z') + i * H);
  const runs = [
    { ms: slots[0] - 90_000, status: 'ok' as RunStatus }, // за 1,5 мин до слота — засчитан
    { ms: slots[1] + 50 * 60_000, status: 'silent' as RunStatus }, // поздно, но до следующего слота
    { ms: slots[2] - 5 * 60_000, status: 'error' as RunStatus }, // за 5 мин до слота 2 — это ещё окно слота 1 (уже занят) → лишний
    { ms: slots[3] + 1000, status: 'ok' as RunStatus },
  ];
  const now = slots[4] + 30 * 60_000;
  assert.deepEqual(slotStatuses(slots, slots[4] + H, runs, now), ['ok', 'silent', 'missed', 'ok', null]);
  assert.deepEqual(slotStatuses(slots, slots[4] + H, runs, slots[4] + H), ['ok', 'silent', 'missed', 'ok', 'missed']);
  assert.deepEqual(slotStatuses([], null, runs, now), []);
});

test('пропуски: группы подряд, текущий пропуск', () => {
  const s = [0, 1, 2, 3, 4, 5, 6].map(i => i * H);
  const st: (RunStatus | null)[] = ['ok', 'missed', 'missed', 'silent', 'missed', 'missed', null];
  const gaps = findGaps(s, st);
  assert.deepEqual(gaps.map(g => [g.fromMs / H, g.toMs / H, g.missed]), [[1, 2, 2], [4, 5, 2]]);
  assert.equal(trailingGap(gaps, st), gaps[1]);
  assert.equal(trailingGap(gaps, ['ok', 'missed', 'missed', 'silent', 'missed', 'missed', 'ok']), null);
  assert.equal(trailingGap([], []), null);
});

test('тексты пропусков как на эталоне', () => {
  const g = { fromMs: t('2026-10-28T08:00:00Z'), toMs: t('2026-10-28T22:00:00Z'), missed: 15, endIdx: 0 };
  assert.equal(gapText(g, MSK), 'не запускался 28.10 с 11:00 до 01:00 — 15 ходов, причина в журнале не записана');
  assert.equal(gapText({ ...g, toMs: g.fromMs, missed: 1 }, MSK), 'не запускался 28.10 в 11:00 — 1 ход, причина в журнале не записана');
  assert.equal(gapText({ ...g, toMs: t('2026-10-29T22:00:00Z'), missed: 39 }, MSK), 'не запускался с 28.10 11:00 до 30.10 01:00 — 39 ходов, причина в журнале не записана');
});

test('внимание: ошибка, пульс, «не запускается», недавний пропуск', () => {
  const now = t('2026-10-29T10:45:00Z');
  const run = { at: '2026-10-29T10:00:30.000Z', status: 'error' as RunStatus, durationSec: 10, tokens: 0, helpers: 0, usd: null, detail: 'упал на шаге 2' };
  const pulse = parsePulse({ updatedAt: '2026-10-29T10:20:00Z', phase: 'работает', step: 'пишу тесты', nextUpdateBy: '2026-10-29T10:35:00Z' }, now);
  const slots = [0, 1, 2, 3, 4, 5, 6, 7].map(i => t('2026-10-29T03:00:00Z') + i * H);
  const st: (RunStatus | null)[] = ['ok', 'missed', 'missed', 'missed', 'silent', 'missed', 'missed', 'missed'];
  const f = scheduleFindings({ lastRun: run, pulse, gaps: findGaps(slots, st), statuses: st, missedRunsWarn: 3, nowMs: now, tz: MSK });
  assert.deepEqual(f.map(x => [x.kind, x.level, x.text]), [
    ['error', 'crit', 'последний ход закончился ошибкой: упал на шаге 2'],
    ['pulse', 'crit', 'пульс не обновлялся с 13:20 — ход мог зависнуть'],
    ['stopped', 'crit', 'не запускается с 11:00 — пропущено 3 хода'],
    ['gap', 'warn', 'не запускался 29.10 с 07:00 до 09:00 — 3 хода, причина в журнале не записана'],
  ]);
  assert.equal(topFinding(f)?.kind, 'error');
  assert.equal(topFinding([expensiveFinding(8_367_471)])?.text, 'самый дорогой фон: 8,4 млн токенов за сутки');
  assert.equal(topFinding([]), null);
  // пропуск короче порога и старый пропуск — не тревожат
  const old = [t('2026-10-27T03:00:00Z'), t('2026-10-27T04:00:00Z'), t('2026-10-27T05:00:00Z'), t('2026-10-27T06:00:00Z')];
  assert.deepEqual(scheduleFindings({ lastRun: null, pulse: null, gaps: findGaps(old, ['missed', 'missed', 'missed', 'ok']), statuses: ['missed', 'missed', 'missed', 'ok'], missedRunsWarn: 3, nowMs: now, tz: MSK }), []);
  assert.deepEqual(scheduleFindings({ lastRun: null, pulse: null, gaps: findGaps(slots, ['ok', 'missed', 'missed', 'ok', 'ok', 'ok', 'ok', 'ok']), statuses: ['ok', 'missed', 'missed', 'ok', 'ok', 'ok', 'ok', 'ok'], missedRunsWarn: 3, nowMs: now, tz: MSK }), []);
});

test('пульс: свежий, если ход закончен или срок следующего обновления (+5 мин) не прошёл', () => {
  const now = t('2026-10-29T10:45:00Z');
  const p = (x: Record<string, unknown>) => parsePulse({ updatedAt: '2026-10-29T10:20:00Z', ...x }, now);
  assert.equal(p({ phase: 'закончил', nextUpdateBy: '2026-10-29T10:00:00Z' }).fresh, true);
  assert.equal(p({ phase: 'Ход закончил', nextUpdateBy: null }).fresh, true);
  assert.equal(p({ phase: 'работает', nextUpdateBy: '2026-10-29T10:41:00Z' }).fresh, true, '+5 мин запаса');
  assert.equal(p({ phase: 'работает', nextUpdateBy: '2026-10-29T10:39:00Z' }).fresh, false);
  assert.equal(p({ phase: 'работает' }).fresh, false);
  assert.deepEqual(p({ phase: 'работает', text: 'шаг', nextUpdateBy: '2026-10-29T11:00:00Z' }),
    { updatedAt: '2026-10-29T10:20:00.000Z', phase: 'работает', text: 'шаг', nextBy: '2026-10-29T11:00:00.000Z', fresh: true });
  assert.throws(() => parsePulse({ phase: 'x' }, now), /нет updatedAt/);
});

/** Как на эталоне: «socpublisher: разработчик», каждый час с 26.10, пропуск 28.10 с 11:00 до 01:00 МСК. */
function referenceRuns(now: number): RunRec[] {
  const runs: RunRec[] = [];
  for (let s = t('2026-10-26T07:00:00Z'); s < now; s += H) {
    if (s >= t('2026-10-28T08:00:00Z') && s <= t('2026-10-28T22:00:00Z')) continue;
    runs.push({ ts: new Date(s + 30_000).toISOString(), actionId: 'conv-dev', name: 'socpublisher: разработчик', status: 'skipped', tokensIn: 690_000, tokensOut: 7_289, durationMs: 186_000, meteredUsd: 0.93 });
  }
  runs.push({ ts: '2026-10-29T09:00:00Z', actionId: 'other', status: 'ok' });
  return runs;
}

test('задача целиком: «12 из 24 — пропуск 28.10», как на эталоне', () => {
  const cfg = fixtureConfig({ taskRules: [{ match: '^socpublisher', project: 'socpublisher' }, { match: 'разработчик', expect: 'в чат — только итог этапа', repo: '/srv/demo' }] });
  const now = new Date('2026-10-29T10:45:00Z');
  const a: ActionRec = {
    id: 'conv-dev', name: 'socpublisher: разработчик', enabled: true,
    trigger: { kind: 'cron', cron: '0 * * * *', timezone: MSK }, task: { kind: 'prompt' },
    output: { silentIfEmpty: true, emptyIsValidOutcome: true }, createdAt: '2026-10-26T06:20:34.580Z',
  };
  const p = new Problems();
  const b = buildTask(a, referenceRuns(now.getTime()), { botId: 'default', botName: 'Основной', config: cfg, now, problems: p });
  const task = b.task;
  assert.match(task.id, /^[0-9a-f]{10}$/, 'id — 10 знаков хеша, не внутренний id платформы');
  assert.equal(task.project, 'socpublisher');
  assert.equal(task.expect, 'в чат — только итог этапа');
  assert.equal(b.repo, '/srv/demo');
  assert.deepEqual(task.schedule, { type: 'cron', text: 'каждый час', cron: '0 * * * *', timezone: MSK });
  assert.equal(task.stats24h.expected, 24);
  assert.equal(task.stats24h.runs, 12);
  assert.equal(task.stats24h.silent, 12);
  assert.equal(task.stats24h.missed, 12);
  assert.equal(task.slots24h.length, 24);
  assert.deepEqual(task.slots24h.slice(0, 12), Array(12).fill('missed'));
  assert.deepEqual(task.slots24h.slice(12), Array(12).fill('silent'));
  assert.deepEqual(task.gaps, [{ from: '2026-10-28T08:00:00.000Z', to: '2026-10-28T22:00:00.000Z', missed: 15 }]);
  assert.equal(task.attention, 'warn');
  assert.equal(task.attentionText, 'не запускался 28.10 с 11:00 до 01:00 — 15 ходов, причина в журнале не записана');
  assert.equal(task.nextRunAt, '2026-10-29T11:00:00.000Z');
  assert.equal(task.lastRun?.at, '2026-10-29T10:00:30.000Z');
  assert.equal(task.runs.length, task.runs.filter(r => r.status === 'silent').length, 'только ходы этой задачи');
  assert.equal(task.stats24h.tokens, 12 * 697_289);
  assert.equal(task.pulse, null);
  assert.deepEqual(p.list, []);
});

test('задача без файла пульса — пульс null и запись в ошибках источников', () => {
  const cfg = fixtureConfig({ taskRules: [{ match: '.', pulseFile: '/нет/такого/pulse.json' }] });
  const p = new Problems();
  const b = buildTask({ id: 'x', name: 'Разработка', trigger: { kind: 'when' } }, [], { botId: 'a', botName: 'А', config: cfg, now: NOW, problems: p });
  assert.equal(b.task.pulse, null);
  assert.deepEqual(p.list, [{ source: 'пульс «Разработка»', message: 'нет файла пульса' }]);
  assert.equal(b.task.stats24h.expected, null);
  assert.equal(b.task.nextRunAt, null);
});

test('статистика за сутки и порядок задач', () => {
  const now = t('2026-10-29T10:45:00Z');
  const runs = [
    { at: '2026-10-28T09:00:00Z', status: 'ok' as RunStatus, durationSec: 60, tokens: 5, helpers: 0, usd: 1, detail: null },
    { at: '2026-10-29T09:00:00Z', status: 'ok' as RunStatus, durationSec: 60, tokens: 100, helpers: 0, usd: 0.5, detail: null },
    { at: '2026-10-29T10:00:00Z', status: 'error' as RunStatus, durationSec: 30, tokens: 50, helpers: 0, usd: null, detail: null },
  ];
  assert.deepEqual(runStats(runs, now), { expected: null, runs: 2, ok: 1, silent: 0, error: 1, missed: 0, tokens: 150, minutes: 1.5, usd: 0.5 });
  const mk = (name: string, attention: Task['attention']) => ({ name, attention }) as Task;
  assert.deepEqual(sortTasks([mk('Я', null), mk('Б', 'warn'), mk('А', null), mk('В', 'crit')]).map(x => x.name), ['В', 'Б', 'А', 'Я']);
});

test('коммиты задачи: старые первыми, хеш 7 знаков', () => {
  assert.deepEqual(taskCommits([
    { at: '2026-10-29T10:23:00.000Z', hash: 'fbca3e5', subject: 'новый' },
    { at: '2026-10-29T06:17:00.000Z', hash: '33c6473', subject: 'старый' },
  ]).map(c => c.hash), ['33c6473', 'fbca3e5']);
});
