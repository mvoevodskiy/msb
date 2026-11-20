// Фоновые задачи ботов (actions.json + журнал ходов): расписание словами, слоты по cron, пропуски, пульс,
// коммиты и то, что требует внимания. Чистые функции — тестируются на синтетических данных.

import type { Level, Pulse, Run, RunStatus, Schedule, Task, TaskStats } from '../../shared/types.ts';
import type { PultConfig, TaskRule } from '../../shared/config.ts';
import { cronBetween, cronNext, cronText, isValidTimeZone, parseCron, type CronSpec } from '../../shared/cron.ts';
import { clip, fmtCount, fmtDate, fmtDateTime, fmtTime, fmtWhen, plural } from '../../shared/format.ts';
import { iso, isoMs, type Problems, readJsonFile, scrub, shortHash, SourceFailure } from '../util.ts';
import { cleanTaskName, toRun, type ActionRec, type RunRec } from './journal.ts';
import type { Commit } from './git.ts';

const MIN = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

/** Активная: не выключена и не разовая, которая уже отработала или чей срок прошёл больше часа назад. */
export function isActiveAction(a: ActionRec, nowMs: number): boolean {
  if (a.enabled === false) return false;
  if (a.trigger?.kind === 'once') {
    if (a.lastRunAt) return false;
    const at = isoMs(a.trigger.at);
    if (at !== null && at < nowMs - HOUR) return false;
  }
  return true;
}

export interface RuleHit { project: string | null; expect: string | null; pulseFile: string | null; repo: string | null }

/** Совпавшие правила объединяются: каждое поле берётся из первого совпавшего правила, где оно задано. */
export function applyRules(name: string, rules: TaskRule[]): RuleHit {
  const hit: RuleHit = { project: null, expect: null, pulseFile: null, repo: null };
  for (const r of rules) {
    if (!r.re.test(name)) continue;
    hit.project ??= r.project;
    hit.expect ??= r.expect;
    hit.pulseFile ??= r.pulseFile;
    hit.repo ??= r.repo;
  }
  return hit;
}

export function defaultExpect(a: ActionRec): string | null {
  if ((a.task?.kind ?? a.requestedKind) === 'reminder') return 'текст в чат';
  if (a.trigger?.kind === 'when') return 'сообщит при событии';
  if (a.output?.silentIfEmpty) return 'пишет, только если есть что сообщить';
  return null;
}

const KINDS = ['reminder', 'prompt', 'draft', 'digest'] as const;

export function taskKind(a: ActionRec): Task['kind'] {
  const k = a.task?.kind ?? a.requestedKind;
  return (KINDS as readonly string[]).includes(k ?? '') ? (k as Task['kind']) : 'other';
}

const EVENT_CHECK: Record<string, string> = { path: 'файл', service: 'служба', http: 'адрес' };

export interface ActionSchedule { schedule: Schedule; spec: CronSpec | null; tz: string; atMs: number | null }

export function actionSchedule(a: ActionRec, displayTz: string, now: Date, problems: Problems | null): ActionSchedule {
  const t = a.trigger ?? {};
  let tz = t.timezone || displayTz;
  if (!isValidTimeZone(tz)) {
    problems?.add(`задача «${cleanTaskName(a.name)}»`, `неизвестный часовой пояс ${tz}`);
    tz = displayTz;
  }
  if (typeof t.cron === 'string' && t.cron.trim()) {
    try {
      const spec = parseCron(t.cron);
      return { schedule: { type: 'cron', text: cronText(t.cron, { tz, displayTz, now }), cron: spec.source, timezone: tz }, spec, tz, atMs: null };
    } catch (e) {
      problems?.add(`задача «${cleanTaskName(a.name)}»`, e);
      return { schedule: { type: 'cron', text: t.cron.trim(), cron: t.cron.trim(), timezone: tz }, spec: null, tz, atMs: null };
    }
  }
  if (t.kind === 'once') return { schedule: { type: 'once', text: 'разово' }, spec: null, tz, atMs: isoMs(t.at) };
  const check = EVENT_CHECK[t.check?.kind ?? ''];
  return { schedule: { type: 'event', text: check ? `по событию: ${check}` : 'по событию' }, spec: null, tz, atMs: null };
}

// ---- Слоты и пропуски ----

/**
 * Статус каждого слота: ход считается сделанным, если начался в [слот − 2 мин, следующий слот).
 * Каждый ход засчитывается одному слоту. null — окно слота ещё открыто и хода пока нет (не пропуск).
 * runs — по возрастанию времени.
 */
export function slotStatuses(slots: number[], next: number | null, runs: { ms: number; status: RunStatus }[], nowMs: number): (RunStatus | null)[] {
  let j = 0;
  return slots.map((s, i) => {
    const end = i + 1 < slots.length ? slots[i + 1] : (next ?? Infinity);
    while (j < runs.length && runs[j].ms < s - 2 * MIN) j++;
    if (j < runs.length && runs[j].ms < end) return runs[j++].status;
    return end <= nowMs ? 'missed' : null;
  });
}

export interface Gap { fromMs: number; toMs: number; missed: number; endIdx: number }

export function findGaps(slots: number[], statuses: (RunStatus | null)[]): Gap[] {
  const gaps: Gap[] = [];
  let cur: Gap | null = null;
  statuses.forEach((st, i) => {
    if (st === 'missed') {
      if (cur) {
        cur.toMs = slots[i];
        cur.missed++;
        cur.endIdx = i;
      } else cur = { fromMs: slots[i], toMs: slots[i], missed: 1, endIdx: i };
    } else if (st !== null && cur) {
      gaps.push(cur);
      cur = null;
    }
  });
  if (cur) gaps.push(cur);
  return gaps;
}

/** Пропуск, который идёт прямо сейчас: после него не было ни одного хода. */
export function trailingGap(gaps: Gap[], statuses: (RunStatus | null)[]): Gap | null {
  const last = gaps[gaps.length - 1];
  if (!last) return null;
  return statuses.slice(last.endIdx + 1).every(s => s === null) ? last : null;
}

// ---- Внимание ----

export interface Finding {
  kind: 'error' | 'pulse' | 'stopped' | 'gap' | 'expensive' | 'timer';
  level: Level;
  /** Текст для строки задачи (без имени задачи). */
  text: string;
  since: string | null;
}

const LEVEL_ORDER: Record<Level, number> = { crit: 0, serious: 1, warn: 2 };

export function topFinding(findings: Finding[]): Finding | null {
  return findings.reduce<Finding | null>((best, f) => (!best || LEVEL_ORDER[f.level] < LEVEL_ORDER[best.level] ? f : best), null);
}

const runsWord = (n: number) => `${n} ${plural(n, 'ход', 'хода', 'ходов')}`;

export function gapText(g: Gap, tz: string): string {
  const span = g.missed === 1
    ? `${fmtDate(g.fromMs, tz)} в ${fmtTime(g.fromMs, tz)}`
    : g.toMs - g.fromMs < DAY
      ? `${fmtDate(g.fromMs, tz)} с ${fmtTime(g.fromMs, tz)} до ${fmtTime(g.toMs, tz)}`
      : `с ${fmtDateTime(g.fromMs, tz)} до ${fmtDateTime(g.toMs, tz)}`;
  return `не запускался ${span} — ${runsWord(g.missed)}, причина в журнале не записана`;
}

/** Ошибка последнего хода, несвежий пульс, текущий и недавний пропуски. «Самый дорогой» считается по всем задачам отдельно. */
export function scheduleFindings(opts: {
  lastRun: Run | null; pulse: Pulse | null; gaps: Gap[]; statuses: (RunStatus | null)[];
  missedRunsWarn: number; nowMs: number; tz: string;
}): Finding[] {
  const { lastRun, pulse, gaps, statuses, missedRunsWarn, nowMs, tz } = opts;
  const out: Finding[] = [];
  if (lastRun?.status === 'error') {
    out.push({ kind: 'error', level: 'crit', since: lastRun.at, text: lastRun.detail ? `последний ход закончился ошибкой: ${clip(lastRun.detail, 100)}` : 'последний ход закончился ошибкой' });
  }
  if (pulse && !pulse.fresh) {
    out.push({ kind: 'pulse', level: 'crit', since: pulse.updatedAt, text: `пульс не обновлялся с ${fmtWhen(pulse.updatedAt, nowMs, tz)} — ход мог зависнуть` });
  }
  const trailing = trailingGap(gaps, statuses);
  if (trailing && trailing.missed >= missedRunsWarn) {
    out.push({ kind: 'stopped', level: 'crit', since: iso(trailing.fromMs), text: `не запускается с ${fmtWhen(trailing.fromMs, nowMs, tz)} — пропущено ${runsWord(trailing.missed)}` });
  }
  const recent = gaps.filter(g => g !== trailing && g.missed >= missedRunsWarn && g.toMs >= nowMs - DAY).pop();
  if (recent) out.push({ kind: 'gap', level: 'warn', since: iso(recent.fromMs), text: gapText(recent, tz) });
  return out;
}

export function expensiveFinding(tokens24h: number): Finding {
  return { kind: 'expensive', level: 'warn', since: null, text: `самый дорогой фон: ${fmtCount(tokens24h)} токенов за сутки` };
}

// ---- Пульс ----

/** Файл пульса {updatedAt, phase, step|text, nextUpdateBy}: свежий, если ход закончен или срок следующего обновления (+5 мин) не прошёл. */
export function parsePulse(data: unknown, nowMs: number): Pulse {
  const d = (data ?? {}) as Record<string, unknown>;
  const updated = isoMs(d.updatedAt);
  if (updated === null) throw new SourceFailure('в файле пульса нет updatedAt');
  const phase = typeof d.phase === 'string' ? scrub(d.phase) : null;
  const textRaw = typeof d.step === 'string' ? d.step : typeof d.text === 'string' ? d.text : null;
  const nextBy = isoMs(d.nextUpdateBy);
  const fresh = (phase !== null && /закончил/iu.test(phase)) || (nextBy !== null && nowMs <= nextBy + 5 * MIN);
  return { updatedAt: iso(updated), phase, text: textRaw === null ? null : clip(scrub(textRaw), 200), nextBy: nextBy === null ? null : iso(nextBy), fresh };
}

// ---- Сборка задачи ----

export interface BuiltTask {
  task: Task;
  findings: Finding[];
  /** Для подсказки «что сейчас делает бот». */
  trigger: ActionSchedule;
}

export function emptyStats(): TaskStats {
  return { expected: null, runs: 0, ok: 0, silent: 0, error: 0, missed: 0, tokens: 0, minutes: 0, usd: 0 };
}

export function runStats(runs: Run[], nowMs: number): TaskStats {
  const s = emptyStats();
  for (const r of runs) {
    if (Date.parse(r.at) <= nowMs - DAY) continue;
    s.runs++;
    if (r.status === 'ok') s.ok++;
    else if (r.status === 'silent') s.silent++;
    else if (r.status === 'error') s.error++;
    s.tokens += r.tokens;
    s.minutes += r.durationSec / 60;
    s.usd += r.usd ?? 0;
  }
  s.minutes = Math.round(s.minutes * 10) / 10;
  s.usd = Math.round(s.usd * 1e4) / 1e4;
  return s;
}

/** Слоты, статусы, пропуски для задачи по cron. Слоты — с момента создания, но не старше 30 дней. */
export function cronSlots(spec: CronSpec, tz: string, createdMs: number | null, runs: Run[], nowMs: number) {
  const from = Math.max(createdMs ?? 0, nowMs - 30 * DAY);
  const slots = cronBetween(spec, from, nowMs + 1, tz).map(d => d.getTime());
  const next = cronNext(spec, nowMs, tz)?.getTime() ?? null;
  const statuses = slotStatuses(slots, next, runs.map(r => ({ ms: Date.parse(r.at), status: r.status })), nowMs);
  const gaps = findGaps(slots, statuses);
  const slots24h = statuses.filter((st, i): st is RunStatus => st !== null && slots[i] > nowMs - DAY);
  return { slots, statuses, gaps, slots24h, next };
}

export interface TaskBuildContext {
  botId: string;
  botName: string;
  config: PultConfig;
  now: Date;
  problems: Problems;
}

export function buildTask(a: ActionRec, botRuns: RunRec[], ctx: TaskBuildContext): BuiltTask & { repo: string | null } {
  const nowMs = ctx.now.getTime();
  const tz = ctx.config.timezone;
  const name = cleanTaskName(a.name);
  const rule = applyRules(name, ctx.config.taskRules);
  const trigger = actionSchedule(a, tz, ctx.now, ctx.problems);
  const runs = botRuns
    .filter(r => r.actionId === a.id && Date.parse(r.ts) > nowMs - 30 * DAY && Date.parse(r.ts) <= nowMs)
    .map(toRun);
  const lastRun = runs[runs.length - 1] ?? null;
  const stats = runStats(runs, nowMs);

  let slots24h: RunStatus[] = runs.filter(r => Date.parse(r.at) > nowMs - DAY).map(r => r.status);
  let gaps: Gap[] = [];
  let statuses: (RunStatus | null)[] = [];
  let nextRunAt: string | null = null;
  if (trigger.spec) {
    const c = cronSlots(trigger.spec, trigger.tz, isoMs(a.createdAt), runs, nowMs);
    slots24h = c.slots24h;
    gaps = c.gaps;
    statuses = c.statuses;
    stats.expected = c.slots24h.length;
    stats.missed = c.slots24h.filter(s => s === 'missed').length;
    nextRunAt = c.next === null ? null : iso(c.next);
  } else if (trigger.atMs !== null && trigger.atMs > nowMs) {
    nextRunAt = iso(trigger.atMs);
  }

  let pulse: Pulse | null = null;
  if (rule.pulseFile) {
    const file = rule.pulseFile;
    pulse = ctx.problems.guard(`пульс «${name}»`, () => {
      const data = readJsonFile(file);
      if (data === null) throw new SourceFailure('нет файла пульса');
      return parsePulse(data, nowMs);
    }, null);
  }

  const findings = scheduleFindings({ lastRun, pulse, gaps, statuses, missedRunsWarn: ctx.config.thresholds.missedRunsWarn, nowMs, tz });
  const top = topFinding(findings);
  const task: Task = {
    id: shortHash(a.id),
    name,
    bot: ctx.botId,
    botName: ctx.botName,
    project: rule.project,
    kind: taskKind(a),
    schedule: trigger.schedule,
    expect: rule.expect ?? defaultExpect(a),
    noAi: false,
    lastRun,
    nextRunAt,
    stats24h: stats,
    slots24h,
    runs,
    gaps: gaps.map(g => ({ from: iso(g.fromMs), to: iso(g.toMs), missed: g.missed })),
    attention: top?.level ?? null,
    attentionText: top?.text ?? null,
    pulse,
    commits: [],
  };
  return { task, findings, trigger, repo: rule.repo };
}

/** Коммиты за 30 дней для карточки задачи: старые первыми, как и ходы. */
export function taskCommits(commits: Commit[]): Task['commits'] {
  return [...commits].reverse().map(c => ({ at: c.at, hash: c.hash, subject: clip(scrub(c.subject), 200) }));
}

/** Пересчитать уровень задачи после добавления находки (например, «самый дорогой фон»). */
export function applyFindings(task: Task, findings: Finding[]): void {
  const top = topFinding(findings);
  task.attention = top?.level ?? null;
  task.attentionText = top?.text ?? null;
}

const LEVEL_RANK = (l: Level | null) => (l === null ? 3 : LEVEL_ORDER[l]);

/** Требующие внимания сверху, затем по имени. */
export function sortTasks(tasks: Task[]): Task[] {
  return tasks.sort((a, b) => LEVEL_RANK(a.attention) - LEVEL_RANK(b.attention) || a.name.localeCompare(b.name, 'ru'));
}
