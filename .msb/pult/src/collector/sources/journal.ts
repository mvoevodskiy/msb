// Файлы бота в каталоге botsRoot/<botId>/: записи журналов и их чтение. Только чтение, ничего не пишем.
// traces/ГГГГ-ММ-ДД.jsonl — завершённые чат-запросы (ts — конец), transcripts/… — переписка,
// chat-diary.jsonl — итоги ответов, autonomy/runs.jsonl — фоновые ходы (ts ≈ начало), actions.json — задачи,
// state.json — из него берём ТОЛЬКО rateLimitInfo (остальное — внутреннее состояние платформы).

import { join } from 'node:path';
import { activeProvider } from './provider.ts';
import type { Run, RunStatus } from '../../shared/types.ts';
import { clip } from '../../shared/format.ts';
import { isoMs, iso, type Problems, readJsonFile, readJsonl, scrub, SourceFailure, utcDay } from '../util.ts';

export interface HistoryIdentity { turnId?: string; providerId?: string | null; status?: string }
export interface TraceRec extends HistoryIdentity { ts: string; query?: string; toolCalls?: number; elapsedMs?: number }
export interface TranscriptRec extends HistoryIdentity { ts: string; role?: string; text?: string }
export interface DiaryRec extends HistoryIdentity { ts: string; kind?: string; summary?: string }
export interface RunRec {
  ts: string;
  actionId?: string;
  name?: string;
  kind?: string;
  status?: string;
  detail?: unknown;
  tokensIn?: number;
  tokensOut?: number;
  durationMs?: number;
  meteredUsd?: number;
  delegated?: number;
}
export interface RateLimitInfo { resetsAt?: number; rateLimitType?: string; isUsingOverage?: boolean; status?: string; lastUpdatedAt?: number }
export interface ActionRec {
  id: string;
  name?: string;
  enabled?: boolean;
  trigger?: { kind?: string; cron?: string; timezone?: string; at?: string; everyMinutes?: number; check?: { kind?: string } };
  task?: { kind?: string };
  requestedKind?: string;
  output?: { silentIfEmpty?: boolean; emptyIsValidOutcome?: boolean };
  createdAt?: string;
  lastRunAt?: string | null;
  lastStatus?: string | null;
  disabledReason?: string | null;
}

export interface BotData {
  traces: TraceRec[];
  transcripts: TranscriptRec[];
  diary: DiaryRec[];
  runs: RunRec[];
  actions: ActionRec[];
  rate: RateLimitInfo | null;
}

const DAY = 86_400_000;
const hasTs = <T extends { ts?: unknown }>(r: T): boolean => isoMs(r.ts) !== null;
const byTs = <T extends { ts: string }>(a: T, b: T) => Date.parse(a.ts) - Date.parse(b.ts);

/** Дневные журналы за указанные даты UTC (нет файла — пусто). */
export function readDaily<T extends { ts: string }>(dir: string, days: string[]): T[] {
  return days.flatMap(d => readJsonl<T>(join(dir, `${d}.jsonl`)) ?? []).filter(hasTs).sort(byTs);
}

/** Всё, что нужно о боте, с отдельной обёрткой на каждый файл: битый файл не роняет остальные. */
export function readBotData(dir: string, nowMs: number, problems: Problems, botName: string): BotData {
  const days = [utcDay(nowMs - DAY), utcDay(nowMs)];
  const src = (what: string) => `бот «${botName}»: ${what}`;
  const traces = problems.guard(src('журнал чатов'), () => readDaily<TraceRec>(join(dir, 'traces'), days), []);
  const transcripts = problems.guard(src('переписка'), () => readDaily<TranscriptRec>(join(dir, 'transcripts'), days), []);
  const diary = problems.guard(src('дневник ответов'), () => (readJsonl<DiaryRec>(join(dir, 'chat-diary.jsonl'), 2 * 1024 * 1024) ?? []).filter(hasTs).sort(byTs), []);
  const runs = problems.guard(src('журнал фоновых ходов'), () => (readJsonl<RunRec>(join(dir, 'autonomy', 'runs.jsonl')) ?? []).filter(hasTs).sort(byTs), []);
  const actions = problems.guard(src('фоновые задачи'), () => {
    const data = readJsonFile(join(dir, 'actions.json'));
    if (data === null) return [];
    if (!Array.isArray(data)) throw new SourceFailure('ожидается список задач');
    return data.filter((a): a is ActionRec => !!a && typeof a === 'object' && typeof a.id === 'string');
  }, []);
  const rate = problems.guard(src('окно подписки'), () => {
    if (activeProvider(dir) !== 'claude') return null;
    const data = readJsonFile(join(dir, 'state.json')) as { rateLimitInfo?: unknown } | null;
    const r = data?.rateLimitInfo;
    return r && typeof r === 'object' ? (r as RateLimitInfo) : null;
  }, null);
  return { traces, transcripts, diary, runs, actions, rate };
}

// ---- Общие преобразования ----

/** ok — итог доставлен в чат, skipped — штатно промолчала, остальное — ошибка. */
export function mapRunStatus(status: string | undefined): RunStatus {
  if (status === 'ok') return 'ok';
  if (status === 'skipped') return 'silent';
  return 'error';
}

export const STATUS_WORD: Record<RunStatus, string> = { ok: 'итог в чат', silent: 'молча', error: 'ошибка', missed: 'пропуск' };

/** «Задача: Баланс ProxyAPI (демо Zapcita)…» → «Баланс ProxyAPI (демо Zapcita)». */
export function cleanTaskName(name: string | undefined): string {
  return scrub((name ?? '').replace(/^\s*Задача:\s*/u, '').replace(/\s*(…|\.\.\.)\s*$/u, '').trim()) || 'без имени';
}

const round = (n: number, d: number) => Math.round(n * 10 ** d) / 10 ** d;

export function toRun(r: RunRec): Run {
  const tokens = (Number(r.tokensIn) || 0) + (Number(r.tokensOut) || 0);
  return {
    at: iso(Date.parse(r.ts)),
    status: mapRunStatus(r.status),
    durationSec: Math.round((Number(r.durationMs) || 0) / 1000),
    tokens,
    helpers: Number(r.delegated) || 0,
    usd: typeof r.meteredUsd === 'number' ? round(r.meteredUsd, 4) : null,
    detail: typeof r.detail === 'string' && r.detail.trim() ? clip(scrub(r.detail), 200) : null,
  };
}
