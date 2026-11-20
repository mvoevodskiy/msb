// Время в часовом поясе владельца (PULT_TZ) для текстов Telegram, сводки и имён копий.
// В базе и API время — UTC (мс или ISO), в МСК переводим только здесь.

const fmtCache = new Map<string, Intl.DateTimeFormat>();

function formatter(tz: string): Intl.DateTimeFormat {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-GB', {
      timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    });
    fmtCache.set(tz, f);
  }
  return f;
}

export interface LocalParts { year: string; month: string; day: string; hour: number; minute: number }

export function localParts(ms: number, tz: string): LocalParts {
  const p: Record<string, string> = {};
  for (const part of formatter(tz).formatToParts(new Date(ms))) p[part.type] = part.value;
  return { year: p.year, month: p.month, day: p.day, hour: Number(p.hour), minute: Number(p.minute) };
}

/** ГГГГ-ММ-ДД в поясе tz — ключ «сегодня» для сводки и имя ежедневной копии. */
export function localDate(ms: number, tz: string): string {
  const p = localParts(ms, tz);
  return `${p.year}-${p.month}-${p.day}`;
}

export function hhmm(ms: number, tz: string): string {
  const p = localParts(ms, tz);
  return `${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`;
}

/** ДД.ММ */
export function ddmm(ms: number, tz: string): string {
  const p = localParts(ms, tz);
  return `${p.day}.${p.month}`;
}

/** «08:15», если в тот же день, что now, иначе «28.10 08:15». */
export function whenShort(ms: number, nowMs: number, tz: string): string {
  return localDate(ms, tz) === localDate(nowMs, tz) ? hhmm(ms, tz) : `${ddmm(ms, tz)} ${hhmm(ms, tz)}`;
}

/** Длительность для людей: «5 мин», «3 ч», «2 дн». */
export function ago(fromMs: number, nowMs: number): string {
  const min = Math.max(0, Math.floor((nowMs - fromMs) / 60_000));
  if (min < 60) return `${min} мин`;
  const h = Math.floor(min / 60);
  if (h < 48) return `${h} ч`;
  return `${Math.floor(h / 24)} дн`;
}

/** Русское множественное число: plural(3, ['решение', 'решения', 'решений']). */
export function plural(n: number, forms: [string, string, string]): string {
  const a = Math.abs(n) % 100;
  const b = a % 10;
  if (a > 10 && a < 20) return forms[2];
  if (b === 1) return forms[0];
  if (b >= 2 && b <= 4) return forms[1];
  return forms[2];
}

export function parseIso(v: unknown): number | null {
  if (typeof v !== 'string') return null;
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : t;
}
