// Таймеры сервера (config.timers) как задачи без ИИ: расписание из systemd, последний ход по службе
// (или по файлу состояния скрипта), ходы — из журнала, если он доступен пользователю службы.

import type { Run, RunStatus, Task } from '../../shared/types.ts';
import type { TimerConfig } from '../../shared/config.ts';
import { clip, fmtUsd, plural } from '../../shared/format.ts';
import { parseCron } from '../../shared/cron.ts';
import { iso, isoMs, scrub, shortHash } from '../util.ts';
import { prop, systemdTime, timerSchedule, type Props } from './systemd.ts';
import { cronSlots, runStats, scheduleFindings, topFinding, type Finding } from './tasks.ts';

const DAY = 86_400_000;

/** Файл состояния скрипта таймера (формат x-status.json): последний ход и его итог. */
export function statusFileRun(data: unknown): Run | null {
  const d = (data ?? {}) as Record<string, unknown>;
  const at = isoMs(d.last_run) ?? isoMs(d.last_ok);
  if (at === null) return null;
  const ok = d.state === 'ok';
  const run = (d.run ?? {}) as Record<string, unknown>;
  let detail: string | null = null;
  if (ok) {
    const parts: string[] = [];
    if (typeof run.fetched === 'number') parts.push(`${run.fetched} ${plural(run.fetched, 'пост', 'поста', 'постов')}`);
    if (typeof run.est_cost_usd === 'number') parts.push(fmtUsd(run.est_cost_usd));
    detail = parts.join(' · ') || null;
  } else {
    detail = typeof d.last_error === 'string' ? clip(scrub(d.last_error), 200) : typeof d.state === 'string' ? `состояние: ${d.state}` : null;
  }
  return { at: iso(at), status: ok ? 'ok' : 'error', durationSec: 0, tokens: 0, helpers: 0, usd: null, detail };
}

/** Последний ход по свойствам службы. null — служба ещё не запускалась (после загрузки или переустановки). */
export function serviceRun(service: Props | undefined): Run | null {
  const start = systemdTime(prop(service, 'ExecMainStartTimestamp'));
  if (!start) return null;
  const state = prop(service, 'ActiveState');
  if (state === 'activating' || state === 'active') return null; // ход идёт, итога ещё нет
  const exit = systemdTime(prop(service, 'ExecMainExitTimestamp'));
  const result = prop(service, 'Result');
  const ok = result === 'success';
  const dur = exit ? Math.max(0, Math.round((Date.parse(exit) - Date.parse(start)) / 1000)) : 0;
  return { at: start, status: ok ? 'ok' : 'error', durationSec: dur, tokens: 0, helpers: 0, usd: null, detail: ok ? null : `результат: ${result || 'неизвестен'}` };
}

/** Ход службы и ход по файлу состояния — один и тот же, если начались в пределах 15 мин. */
export function mergeLastRun(svc: Run | null, file: Run | null): Run | null {
  if (!svc) return file;
  if (!file) return svc;
  const d = Math.abs(Date.parse(svc.at) - Date.parse(file.at));
  if (d <= 15 * 60_000) return { ...svc, detail: svc.status === 'ok' ? file.detail : svc.detail };
  return Date.parse(file.at) > Date.parse(svc.at) ? file : svc;
}

export interface TimerInput {
  cfg: TimerConfig;
  botName: string;
  timer: Props | undefined;
  service: Props | undefined;
  journal: Run[];
  statusData: unknown;
  serverTz: string;
  displayTz: string;
  missedRunsWarn: number;
  now: Date;
}

export function buildTimerTask(inp: TimerInput): { task: Task; findings: Finding[] } {
  const nowMs = inp.now.getTime();
  const schedule = timerSchedule(inp.timer, { serverTz: inp.serverTz, displayTz: inp.displayTz, fallback: inp.cfg.scheduleText, now: inp.now });
  const fileRun = inp.statusData == null ? null : statusFileRun(inp.statusData);
  const last = mergeLastRun(serviceRun(inp.service), fileRun);
  let runs: Run[] = inp.journal.filter(r => Date.parse(r.at) > nowMs - 30 * DAY);
  if (runs.length && last && Math.abs(Date.parse(runs[runs.length - 1].at) - Date.parse(last.at)) <= 15 * 60_000) {
    runs[runs.length - 1] = { ...runs[runs.length - 1], detail: runs[runs.length - 1].detail ?? last.detail };
  }
  const fromJournal = runs.length > 0;
  if (!fromJournal) runs = last && Date.parse(last.at) > nowMs - 30 * DAY ? [last] : [];
  const lastRun = runs[runs.length - 1] ?? last;

  const stats = runStats(runs, nowMs);
  let slots24h: RunStatus[] = runs.filter(r => Date.parse(r.at) > nowMs - DAY).map(r => r.status);
  let findings: Finding[] = [];
  let gaps: Task['gaps'] = [];

  const loadState = prop(inp.timer, 'LoadState');
  const activeState = prop(inp.timer, 'ActiveState');
  if (loadState && loadState !== 'loaded') findings.push({ kind: 'timer', level: 'crit', since: null, text: 'таймер не установлен' });
  else if (activeState && activeState !== 'active') findings.push({ kind: 'timer', level: 'crit', since: null, text: `таймер выключен (состояние: ${activeState})` });

  if (fromJournal && schedule.type === 'cron' && schedule.cron && schedule.timezone) {
    // пропуски считаем только по полному журналу: начало — первый известный ход
    const c = cronSlots(parseCron(schedule.cron), schedule.timezone, Date.parse(runs[0].at) - 2 * 60_000, runs, nowMs);
    slots24h = c.slots24h;
    stats.expected = c.slots24h.length;
    stats.missed = c.slots24h.filter(s => s === 'missed').length;
    gaps = c.gaps.map(g => ({ from: iso(g.fromMs), to: iso(g.toMs), missed: g.missed }));
    findings = findings.concat(scheduleFindings({ lastRun, pulse: null, gaps: c.gaps, statuses: c.statuses, missedRunsWarn: inp.missedRunsWarn, nowMs, tz: inp.displayTz }));
  } else {
    findings = findings.concat(scheduleFindings({ lastRun, pulse: null, gaps: [], statuses: [], missedRunsWarn: inp.missedRunsWarn, nowMs, tz: inp.displayTz }));
  }

  let next = activeState === 'active' ? systemdTime(prop(inp.timer, 'NextElapseUSecRealtime')) : null;
  // У монотонных таймеров (OnUnitActiveSec) systemd не отдаёт время по часам — считаем от последнего срабатывания.
  if (!next && activeState === 'active' && schedule.type === 'interval' && schedule.everySec) {
    const lastTrigger = systemdTime(prop(inp.timer, 'LastTriggerUSec'));
    if (lastTrigger) next = new Date(Math.max(Date.parse(lastTrigger) + schedule.everySec * 1000, nowMs)).toISOString();
  }
  const top = topFinding(findings);
  return {
    findings,
    task: {
      id: shortHash(inp.cfg.id),
      name: inp.cfg.name,
      bot: inp.cfg.bot,
      botName: inp.botName,
      project: inp.cfg.project,
      kind: 'timer',
      schedule,
      expect: inp.cfg.expect,
      noAi: true,
      lastRun,
      nextRunAt: next,
      stats24h: stats,
      slots24h,
      runs,
      gaps,
      attention: top?.level ?? null,
      attentionText: top?.text ?? null,
      pulse: null,
      commits: [],
    },
  };
}
