// Боты: чем заняты сейчас (агентские процессы в cgroup службы бота + незакрытый запрос в переписке),
// последний итог, работа за сутки и отрезки для полосы «кто что делал».

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Bot, BotNow, Span } from '../../shared/types.ts';
import { clip } from '../../shared/format.ts';
import { cronBetween, type CronSpec } from '../../shared/cron.ts';
import { iso, scrub } from '../util.ts';
import { cleanTaskName, mapRunStatus, STATUS_WORD, type DiaryRec, type RunRec, type TraceRec, type TranscriptRec } from './journal.ts';

const MIN = 60_000;
const DAY = 86_400_000;

// ---- Процессы ----

/** Only executable identities, never a provider name appearing in a shell prompt/path argument. */
function agentCommand(raw: string): { provider: string; wrapper: boolean } | null {
  const args = raw.split('\0').filter(Boolean);
  if (!args.length) return null;
  const base = (s: string) => s.slice(s.lastIndexOf('/') + 1);
  const executable = base(args[0]).replace(/\.exe$/i, '').toLowerCase();
  if (['claude', 'codex', 'qwen', 'cursor-agent'].includes(executable)) return { provider: executable, wrapper: false };
  if (!/^node(js)?$/.test(executable) || !args[1]) return null;
  if (/(^|\/)claude(-code)?(\/|$)|claude-code\/cli\.m?js$/.test(args[1])) return { provider: 'claude', wrapper: true };
  if (/(^|\/)@openai\/codex\/bin\/codex\.js$/.test(args[1])) return { provider: 'codex', wrapper: true };
  if (/(^|\/)@qwen-code\/qwen-code\/bundle\/cli\.js$/.test(args[1])) return { provider: 'qwen', wrapper: true };
  return null;
}
export function isAgentCmdline(raw: string): boolean { return agentCommand(raw) !== null; }

/** Поле 22 /proc/<pid>/stat — время старта в тиках с загрузки. Имя процесса в скобках может содержать пробелы. */
export function procStartTicks(stat: string): number | null {
  const rest = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/);
  const v = Number(rest[19]);
  return Number.isFinite(v) ? v : null;
}

export interface AgentProc { pid: number; startMs: number }

export function agentProcesses(opts: { procRoot: string; cgroupRoot: string; controlGroup: string; bootMs: number; clkTck: number }): AgentProc[] {
  const pids = readFileSync(join(opts.cgroupRoot, opts.controlGroup, 'cgroup.procs'), 'utf8').split('\n').map(Number).filter(n => n > 0);
  const out: (AgentProc & { provider: string; wrapper: boolean })[] = [];
  for (const pid of pids) {
    try {
      const command = agentCommand(readFileSync(join(opts.procRoot, String(pid), 'cmdline'), 'utf8'));
      if (!command) continue;
      const ticks = procStartTicks(readFileSync(join(opts.procRoot, String(pid), 'stat'), 'utf8'));
      if (ticks !== null) out.push({ pid, startMs: opts.bootMs + (ticks / opts.clkTck) * 1000, ...command });
    } catch { /* процесс успел завершиться */ }
  }
  // The npm Codex launcher remains alive beside its native worker; it is not a helper.
  const nativeCodex = out.some(p => p.provider === 'codex' && !p.wrapper);
  return out.filter(p => !(nativeCodex && p.provider === 'codex' && p.wrapper))
    .map(({ pid, startMs }) => ({ pid, startMs }));
}

// ---- Переписка ----

const firstTextLine = (s: string) => s.split('\n').map(l => l.trim()).find(Boolean) ?? '';

/** Незакрытый запрос: последнее сообщение пользователя после последнего ответа бота.
 *  Последнее, а не первое: ход, оборванный без ответа (лимит, сбой), оставляет «висящее» сообщение,
 *  а работает бот уже над следующим. */
export function pendingRequest(transcripts: TranscriptRec[]): { atMs: number; text: string } | null {
  const latestUser = transcripts.filter(r => r.role === 'user').at(-1);
  if (latestUser?.turnId) {
    if (transcripts.some(r => r.role === 'assistant' && r.turnId === latestUser.turnId)) return null;
    return { atMs: Date.parse(latestUser.ts), text: clip(scrub(firstTextLine(latestUser.text ?? '')), 120) };
  }
  let lastAnswer = -1;
  transcripts.forEach((r, i) => {
    if (r.role === 'assistant') lastAnswer = i;
  });
  const last = transcripts.slice(lastAnswer + 1).filter(r => r.role === 'user').at(-1);
  if (!last) return null;
  return { atMs: Date.parse(last.ts), text: clip(scrub(firstTextLine(last.text ?? '')), 120) };
}

const ENTITIES: Record<string, string> = { '&lt;': '<', '&gt;': '>', '&amp;': '&', '&quot;': '"', '&#39;': "'", '&nbsp;': ' ' };

/** Итог ответа из дневника: без HTML, без пометки «🟢 От тебя ничего не нужно» («🔴 Нужно от тебя: …» остаётся). */
export function cleanReply(summary: string): string {
  let s = summary
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/<[^>]*$/, '')
    .replace(/&(lt|gt|amp|quot|#39|nbsp);/g, m => ENTITIES[m]);
  // дневник склеивает сообщения хода: промежуточная реплика, потом отчёт с пометкой — берём отчёт
  const mark = s.search(/🟢|🔴/u);
  if (mark > 0) s = s.slice(mark);
  s = s.trim().replace(/^🟢\s*От тебя ничего не нужно[\s.,;:!—–-]*/iu, '');
  return clip(scrub(s), 120);
}

/** Последний ответ бота (по дневнику); длительность и число действий — из чат-журнала (запись в пределах ±60 с). */
export function lastResult(diary: DiaryRec[], traces: TraceRec[], transcripts: TranscriptRec[]): Bot['lastResult'] {
  // Пустой ответ бывает, когда ход оборвался (лимит, сбой) — это не итог, берём последний настоящий.
  const reply = [...diary].reverse().find(r => r.kind === 'agent_reply' && cleanReply(r.summary ?? '') !== '');
  if (!reply) return null;
  const at = Date.parse(reply.ts);
  let best: TraceRec | null = null;
  for (const t of traces) {
    if (reply.turnId ? t.turnId !== reply.turnId : t.turnId) continue;
    const d = Math.abs(Date.parse(t.ts) - at);
    if ((reply.turnId || d <= MIN) && (!best || d < Math.abs(Date.parse(best.ts) - at))) best = t;
  }
  let durationMin = best && typeof best.elapsedMs === 'number' ? best.elapsedMs / MIN : null;
  if (durationMin === null) {
    // запасной путь: от первого сообщения пользователя до этого ответа в переписке
    const idx = transcripts.findIndex(r => r.role === 'assistant' && (reply.turnId ? r.turnId === reply.turnId : !r.turnId && Math.abs(Date.parse(r.ts) - at) <= MIN));
    if (reply.turnId && idx >= 0) {
      const start = transcripts.find(r => r.role === 'user' && r.turnId === reply.turnId);
      if (start) durationMin = Math.max(0, Date.parse(transcripts[idx].ts) - Date.parse(start.ts)) / MIN;
    } else if (idx > 0) {
      let start = idx;
      while (start > 0 && transcripts[start - 1].role === 'user') start--;
      if (start < idx) durationMin = (Date.parse(transcripts[idx].ts) - Date.parse(transcripts[start].ts)) / MIN;
    }
  }
  // в переписке тот же ответ целиком, а в дневнике — обрезок; берём полный, если он нашёлся
  const full = transcripts.find(r => r.role === 'assistant' && (reply.turnId ? r.turnId === reply.turnId : !r.turnId && Math.abs(Date.parse(r.ts) - at) <= MIN) && r.text);
  return {
    at: iso(at),
    text: cleanReply(full?.text ?? reply.summary ?? ''),
    // контракт требует число; если длительность не нашлась ни в одном журнале — 0 (см. отчёт сборщика)
    durationMin: Math.round((durationMin ?? 0) * 10) / 10,
    actions: best && typeof best.toolCalls === 'number' ? best.toolCalls : null,
  };
}

// ---- Сейчас ----

export interface ScheduledTrigger { name: string; spec: CronSpec | null; tz: string; atMs: number | null }

export function botNow(procs: AgentProc[], pending: { atMs: number; text: string } | null, triggers: ScheduledTrigger[]): BotNow {
  if (!procs.length) return { busy: false, since: null, kind: null, text: null, helpers: 0 };
  const since = Math.min(...procs.map(p => p.startMs));
  const base = { busy: true, since: iso(since), helpers: Math.max(0, procs.length - 1) };
  if (pending && pending.atMs >= since - 10 * MIN) return { ...base, kind: 'chat', text: pending.text || null };
  const from = since - 3 * MIN;
  const to = since + MIN;
  const task = triggers.find(t =>
    (t.spec && cronBetween(t.spec, from, to + 1, t.tz).length > 0) || (t.atMs !== null && t.atMs >= from && t.atMs <= to));
  if (task) return { ...base, kind: 'task', text: clip(task.name, 120) };
  return { ...base, kind: 'chat', text: null };
}

// ---- Сутки ----

export function chat24h(traces: TraceRec[], nowMs: number): Bot['chat24h'] {
  const recent = traces.filter(t => Date.parse(t.ts) > nowMs - DAY && Date.parse(t.ts) <= nowMs);
  return { requests: recent.length, minutes: Math.round(recent.reduce((s, t) => s + (Number(t.elapsedMs) || 0), 0) / MIN) };
}

export function bg24h(runs: RunRec[], nowMs: number): Bot['bg24h'] {
  const recent = runs.filter(r => Date.parse(r.ts) > nowMs - DAY && Date.parse(r.ts) <= nowMs);
  return {
    tasks: new Set(recent.map(r => r.actionId ?? r.name)).size,
    runs: recent.length,
    tokens: recent.reduce((s, r) => s + (Number(r.tokensIn) || 0) + (Number(r.tokensOut) || 0), 0),
    minutes: Math.round(recent.reduce((s, r) => s + (Number(r.durationMs) || 0), 0) / MIN),
  };
}

/** Отрезки за 24 ч: чаты (из журнала чатов), фоновые ходы и то, что идёт сейчас (до момента сбора). */
export function timeline(traces: TraceRec[], runs: RunRec[], now: BotNow, nowMs: number): Span[] {
  const from = nowMs - DAY;
  const spans: Span[] = [];
  for (const t of traces) {
    const end = Date.parse(t.ts);
    const start = end - (Number(t.elapsedMs) || 0);
    if (end < from || start > nowMs) continue;
    spans.push({ start: iso(start), end: iso(end), kind: 'chat', label: clip(scrub(t.query ?? ''), 60) });
  }
  for (const r of runs) {
    const start = Date.parse(r.ts);
    const end = start + (Number(r.durationMs) || 0);
    if (end < from || start > nowMs) continue;
    const status = mapRunStatus(r.status);
    spans.push({ start: iso(start), end: iso(end), kind: 'bg', status, label: `${cleanTaskName(r.name)} · ${STATUS_WORD[status]}` });
  }
  if (now.busy && now.since) {
    const span: Span = { start: now.since, end: iso(nowMs), kind: now.kind === 'task' ? 'bg' : 'chat', live: true };
    if (now.text) span.label = clip(now.text, 60);
    spans.push(span);
  }
  return spans.sort((a, b) => a.start.localeCompare(b.start));
}

