// Службы и таймеры systemd: разбор `systemctl show` (блоки через пустую строку, свойства по ключам),
// память по cgroup без файлового кэша, расписания таймеров словами, ходы таймеров из журнала.

import { readFileSync, readlinkSync } from 'node:fs';
import { join } from 'node:path';
import type { Run, Schedule, ServiceHealth } from '../../shared/types.ts';
import { cronText, isValidTimeZone, parseCron } from '../../shared/cron.ts';
import { isoMs, type Exec, SourceFailure } from '../util.ts';

/** Свойства юнита; одно свойство может встречаться несколько раз (TimersCalendar). */
export type Props = Record<string, string[]>;

export const SHOW_PROPS = [
  'Id', 'LoadState', 'ActiveState', 'SubState', 'Result', 'ActiveEnterTimestamp', 'StateChangeTimestamp', 'NRestarts',
  'MemoryCurrent', 'CPUUsageNSec', 'ControlGroup', 'Unit', 'NextElapseUSecRealtime', 'LastTriggerUSec',
  'TimersCalendar', 'TimersMonotonic', 'RandomizedDelayUSec', 'ExecMainStartTimestamp', 'ExecMainExitTimestamp',
];

export function parseShow(text: string): Props[] {
  return text.split(/\n\s*\n/).map(block => {
    const p: Props = {};
    for (const line of block.split('\n')) {
      const i = line.indexOf('=');
      if (i <= 0) continue;
      (p[line.slice(0, i)] ??= []).push(line.slice(i + 1));
    }
    return p;
  }).filter(p => Object.keys(p).length > 0);
}

export const prop = (p: Props | undefined, key: string): string => p?.[key]?.[0] ?? '';

/** Один вызов `systemctl show` на все юниты. Ключ результата — имя юнита, как его спросили. */
export async function showUnits(exec: Exec, units: string[]): Promise<Map<string, Props>> {
  const out = new Map<string, Props>();
  const list = [...new Set(units)];
  if (!list.length) return out;
  const r = await exec('systemctl', ['show', ...list, ...SHOW_PROPS.flatMap(p => ['-p', p])]);
  if (r.code !== 0) throw new SourceFailure(r.error ?? 'systemctl show не сработал');
  const blocks = parseShow(r.stdout);
  if (blocks.length === list.length) {
    // systemctl печатает блоки в порядке аргументов; Id может отличаться от запроса у псевдонимов
    list.forEach((u, i) => out.set(u, blocks[i]));
  } else {
    for (const b of blocks) out.set(prop(b, 'Id'), b);
  }
  return out;
}

/** «Wed 2026-10-28 20:25:21 UTC» → ISO. Пусто, n/a, 0 — null. systemctl запускаем с TZ=UTC. */
export function systemdTime(s: string): string | null {
  const m = /(\d{4})-(\d\d)-(\d\d) (\d\d):(\d\d):(\d\d)(?:\.(\d+))?(?: (\S+))?\s*$/.exec(s.trim());
  if (!m) return null;
  const zone = m[8];
  if (zone && !/^(UTC|GMT|Z)$/i.test(zone)) return null;
  const msPart = m[7] ? Math.floor(Number(`0.${m[7]}`) * 1000) : 0;
  return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6], msPart)).toISOString();
}

const num = (s: string): number | null => (/^\d+$/.test(s) ? Number(s) : null);

/** anon + kernel из memory.stat, байты: память службы без файлового кэша. null — нет anon. */
export function parseMemoryStat(text: string): number | null {
  const v: Record<string, number> = {};
  for (const line of text.split('\n')) {
    const [k, n] = line.split(' ');
    if (k && n) v[k] = Number(n);
  }
  if (v.anon === undefined) return null;
  return v.anon + (v.kernel ?? 0);
}

export function cgroupMemBytes(cgroupRoot: string, controlGroup: string): number | null {
  if (!controlGroup) return null;
  try {
    return parseMemoryStat(readFileSync(join(cgroupRoot, controlGroup, 'memory.stat'), 'utf8'));
  } catch {
    return null;
  }
}

export interface UnitHealth extends ServiceHealth {
  loaded: boolean;
  loadState: string;
  result: string;
  controlGroup: string | null;
}

export function unitHealth(p: Props | undefined, cgroupRoot: string, nowMs: number): UnitHealth {
  const loadState = prop(p, 'LoadState') || 'unknown';
  const state = prop(p, 'ActiveState') || 'unknown';
  const active = state === 'active' || state === 'reloading';
  const enter = systemdTime(prop(p, 'ActiveEnterTimestamp'));
  const enterMs = isoMs(enter);
  const controlGroup = prop(p, 'ControlGroup') || null;
  let memMb: number | null = null;
  let cpuCores: number | null = null;
  if (active) {
    const bytes = (controlGroup ? cgroupMemBytes(cgroupRoot, controlGroup) : null) ?? num(prop(p, 'MemoryCurrent'));
    memMb = bytes === null ? null : Math.round(bytes / 1024 ** 2);
    const cpuNs = num(prop(p, 'CPUUsageNSec'));
    if (cpuNs !== null && enterMs !== null && nowMs > enterMs) cpuCores = Math.round((cpuNs / 1e6 / (nowMs - enterMs)) * 100) / 100;
  }
  return {
    state,
    since: active ? enter : systemdTime(prop(p, 'StateChangeTimestamp')),
    restarts: num(prop(p, 'NRestarts')) ?? 0,
    memMb,
    cpuCores,
    loaded: loadState === 'loaded',
    loadState,
    result: prop(p, 'Result'),
    controlGroup,
  };
}

// ---- Таймеры ----

/** Пояс, в котором systemd понимает OnCalendar: системный (/etc/localtime). */
export function serverTimeZone(): string {
  try {
    const m = /zoneinfo\/(.+)$/.exec(readlinkSync('/etc/localtime'));
    if (m && isValidTimeZone(m[1])) return m[1];
  } catch { /* не ссылка — читаем /etc/timezone */ }
  try {
    const tz = readFileSync('/etc/timezone', 'utf8').trim();
    if (isValidTimeZone(tz)) return tz;
  } catch { /* нет файла */ }
  return 'UTC';
}

/** «{ OnCalendar=*-*-* 03:00:00 ; next_elapse=… }» → {key, value}. */
export function timerEntry(s: string): { key: string; value: string } | null {
  const m = /^\{\s*(\w+)=(.*?)\s*;\s*next_elapse=.*\}\s*$/.exec(s.trim());
  return m ? { key: m[1], value: m[2] } : null;
}

const SPAN_UNITS: Record<string, number> = {
  us: 1e-6, usec: 1e-6, ms: 1e-3, msec: 1e-3, s: 1, sec: 1, second: 1, seconds: 1,
  m: 60, min: 60, minute: 60, minutes: 60, h: 3600, hr: 3600, hour: 3600, hours: 3600,
  d: 86400, day: 86400, days: 86400, w: 604800, week: 604800, weeks: 604800,
  M: 2_629_800, month: 2_629_800, months: 2_629_800, y: 31_557_600, year: 31_557_600, years: 31_557_600,
};

/** Промежуток systemd («15min», «1h 30min», «30s», «0») в секундах; null — не разобрать. */
export function parseTimespanSec(s: string): number | null {
  const t = s.trim();
  if (!t || t === 'infinity') return null;
  let total = 0;
  let rest = t;
  const re = /^\s*(\d+(?:\.\d+)?)\s*([a-zA-Z]*)/;
  while (rest.trim()) {
    const m = re.exec(rest);
    if (!m) return null;
    const unit = m[2] || 's';
    const k = SPAN_UNITS[unit] ?? SPAN_UNITS[unit.toLowerCase()];
    if (k === undefined) return null;
    total += Number(m[1]) * k;
    rest = rest.slice(m[0].length);
  }
  return Math.round(total);
}

export function intervalText(sec: number): string {
  if (sec > 0 && sec % 86400 === 0) return sec === 86400 ? 'раз в сутки' : `каждые ${sec / 86400} сут.`;
  if (sec > 0 && sec % 3600 === 0) return sec === 3600 ? 'каждый час' : `каждые ${sec / 3600} ч`;
  if (sec > 0 && sec % 60 === 0) return sec === 60 ? 'каждую минуту' : `каждые ${sec / 60} мин`;
  return `каждые ${sec} с`;
}

const DOW: Record<string, number> = { mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6, sun: 7 };

function calPart(text: string, names: boolean): string | null {
  const out: string[] = [];
  for (const raw of text.split(',')) {
    const x = names ? raw.toLowerCase().replace(/[a-z]+/g, w => String(DOW[w.slice(0, 3)] ?? 'x')) : raw;
    if (x === '*') out.push('*');
    else if (/^\*\/\d+$/.test(x)) out.push(x);
    else if (/^\d+\/\d+$/.test(x)) out.push(x.replace(/^0+(?=\d)/, ''));
    else if (/^\d+\.\.\d+$/.test(x)) out.push(x.split('..').map(Number).join('-'));
    else if (/^\d+$/.test(x)) out.push(String(Number(x)));
    else return null;
  }
  return out.join(',');
}

/**
 * OnCalendar в нормальной форме systemd («Mon..Fri *-*-* 09:00:00», «*-*-* 00/3:20:00») → cron из 5 полей.
 * Даты кроме «*-*-*» и секунды кроме 00 не поддержаны — тогда null.
 */
export function onCalendarToCron(spec: string): { cron: string; tz: string | null } | null {
  const tokens = spec.trim().split(/\s+/);
  let tz: string | null = null;
  if (tokens.length > 1 && !tokens[tokens.length - 1].includes(':') && isValidTimeZone(tokens[tokens.length - 1])) tz = tokens.pop()!;
  let dow = '*';
  if (tokens.length === 3) {
    const d = calPart(tokens.shift()!, true);
    if (d === null) return null;
    dow = d;
  }
  if (tokens.length !== 2 || tokens[0] !== '*-*-*') return null;
  const [h, m, s = '00'] = tokens[1].split(':');
  if (!/^0+$/.test(s)) return null;
  const hh = calPart(h, false);
  const mm = calPart(m, false);
  if (hh === null || mm === null) return null;
  const cron = `${mm} ${hh} * * ${dow}`;
  try {
    parseCron(cron);
  } catch {
    return null;
  }
  return { cron, tz };
}

/** Расписание таймера словами: календарь → как cron (с «~» при случайной задержке), интервал → «каждые 15 мин». */
export function timerSchedule(timer: Props | undefined, opts: { serverTz: string; displayTz: string; fallback: string | null; now: Date }): Schedule {
  const cal = (timer?.TimersCalendar ?? []).map(timerEntry).filter(e => e?.key === 'OnCalendar') as { key: string; value: string }[];
  const approx = (parseTimespanSec(prop(timer, 'RandomizedDelayUSec')) ?? 0) > 0;
  if (cal.length === 1) {
    const c = onCalendarToCron(cal[0].value);
    if (c) {
      const tz = c.tz ?? opts.serverTz;
      return { type: 'cron', cron: c.cron, timezone: tz, text: cronText(c.cron, { tz, displayTz: opts.displayTz, approx, now: opts.now }) };
    }
  }
  if (cal.length) return { type: 'cron', text: opts.fallback ?? cal.map(e => e.value).join('; ') };
  const mono = (timer?.TimersMonotonic ?? []).map(timerEntry).find(e => e && /^OnUnit(In)?activeUSec$/i.test(e.key));
  const every = mono ? parseTimespanSec(mono.value) : null;
  if (every) return { type: 'interval', everySec: every, text: intervalText(every) };
  return { type: 'interval', text: opts.fallback ?? 'по таймеру' };
}

/**
 * Ходы службы из `journalctl -o json` (сообщения самого systemd): Starting/Started открывают ход,
 * Finished/Deactivated successfully закрывают успехом, Failed with result — ошибкой.
 */
export function parseJournalRuns(text: string): Run[] {
  const runs: Run[] = [];
  let open: { start: number; detail: string | null } | null = null;
  const close = (end: number, ok: boolean, detail: string | null) => {
    if (!open) return;
    runs.push({
      at: new Date(open.start).toISOString(), status: ok ? 'ok' : 'error', durationSec: Math.max(0, Math.round((end - open.start) / 1000)),
      tokens: 0, helpers: 0, usd: null, detail: ok ? null : (detail ?? open.detail),
    });
    open = null;
  };
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let e: Record<string, unknown>;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    // вывод самой службы может содержать похожие слова — берём только сообщения systemd
    if (e.SYSLOG_IDENTIFIER !== 'systemd') continue;
    const msg = typeof e.MESSAGE === 'string' ? e.MESSAGE : '';
    const t = Number(e.__REALTIME_TIMESTAMP) / 1000;
    if (!msg || !Number.isFinite(t)) continue;
    let m: RegExpExecArray | null;
    if (/^Start(ing|ed) /.test(msg)) {
      if (!open) open = { start: t, detail: null };
    } else if ((m = /Main process exited, code=\w+, status=(\S+)/.exec(msg)) && open) {
      if (!/^0\//.test(m[1])) open.detail = `код выхода ${m[1]}`;
    } else if ((m = /Failed with result '([^']+)'/.exec(msg))) {
      close(t, false, open?.detail ?? `результат: ${m[1]}`);
    } else if (/Deactivated successfully|^Finished /.test(msg)) {
      close(t, true, null);
    }
  }
  return runs;
}

export async function journalRuns(exec: Exec, service: string): Promise<Run[]> {
  const r = await exec('journalctl', ['-u', service, '--since=-30d', '-o', 'json', '--output-fields=MESSAGE,SYSLOG_IDENTIFIER', '--no-pager', '-q'], { timeoutMs: 8000 });
  if (r.code !== 0) return [];
  return parseJournalRuns(r.stdout);
}
