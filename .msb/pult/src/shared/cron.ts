// Cron из 5 полей (минута час день месяц день-недели) и время в часовом поясе IANA — без библиотек, на Intl.
// Поддержано: *, */n, a, a-b, a-b/n, a/n, списки через запятую; день недели 0–7 (0 и 7 — воскресенье).
// Имён (MON, JAN) и @-сокращений нет. Как в классическом cron: если ограничены и день месяца, и день недели,
// срабатывание — при совпадении любого из них.

export class CronError extends Error {}

export interface CronSpec {
  source: string;
  minutes: number[];
  hours: number[];
  days: number[];
  months: number[];
  /** 0 — воскресенье; 7 приведено к 0. */
  weekdays: number[];
  /** Поле начинается с «*» — не ограничивает (для правила «день месяца ИЛИ день недели»). */
  dayStar: boolean;
  weekdayStar: boolean;
  monthStar: boolean;
}

const FIELDS = [
  { name: 'минуты', min: 0, max: 59 },
  { name: 'часы', min: 0, max: 23 },
  { name: 'день месяца', min: 1, max: 31 },
  { name: 'месяц', min: 1, max: 12 },
  { name: 'день недели', min: 0, max: 7 },
] as const;

function parseField(text: string, idx: number, expr: string): number[] {
  const f = FIELDS[idx];
  const out = new Set<number>();
  for (const part of text.split(',')) {
    const m = /^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/.exec(part);
    if (!m) throw new CronError(`cron «${expr}»: не понимаю поле «${f.name}» (${text})`);
    let lo: number;
    let hi: number;
    if (m[1] === '*') {
      lo = f.min;
      hi = f.max;
    } else {
      const [a, b] = m[1].split('-').map(Number);
      lo = a;
      // «a/n» — от a до конца диапазона с шагом n
      hi = b ?? (m[2] ? f.max : a);
    }
    const step = m[2] ? Number(m[2]) : 1;
    if (lo < f.min || hi > f.max || lo > hi) throw new CronError(`cron «${expr}»: поле «${f.name}» вне диапазона ${f.min}–${f.max} (${part})`);
    if (step < 1) throw new CronError(`cron «${expr}»: шаг в поле «${f.name}» должен быть не меньше 1`);
    for (let v = lo; v <= hi; v += step) out.add(idx === 4 && v === 7 ? 0 : v);
  }
  return [...out].sort((a, b) => a - b);
}

export function parseCron(expr: string): CronSpec {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) throw new CronError(`cron «${expr}»: ожидается 5 полей (минута час день месяц день-недели), а их ${parts.length}`);
  const [mi, h, d, mo, wd] = parts.map((p, i) => parseField(p, i, expr));
  return {
    source: parts.join(' '),
    minutes: mi, hours: h, days: d, months: mo, weekdays: wd,
    dayStar: parts[2].startsWith('*'),
    weekdayStar: parts[4].startsWith('*'),
    monthStar: parts[3].startsWith('*'),
  };
}

// ---- Часовые пояса ----

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(tz: string): Intl.DateTimeFormat {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23',
      year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric',
    });
    formatters.set(tz, f);
  }
  return f;
}

export function isValidTimeZone(tz: string): boolean {
  try {
    formatter(tz);
    return true;
  } catch {
    return false;
  }
}

export interface ZonedParts { y: number; mo: number; d: number; h: number; mi: number; s: number; /** 0 — воскресенье */ dow: number }

/** Настенные часы момента ms в поясе tz. */
export function zonedParts(ms: number, tz: string): ZonedParts {
  const p: Record<string, number> = {};
  for (const part of formatter(tz).formatToParts(new Date(ms))) {
    if (part.type !== 'literal') p[part.type] = Number(part.value);
  }
  const dow = new Date(Date.UTC(p.year, p.month - 1, p.day)).getUTCDay();
  return { y: p.year, mo: p.month, d: p.day, h: p.hour, mi: p.minute, s: p.second, dow };
}

// Смещение пояса меняется только на границах четвертей часа — кешируем по 15-минутным корзинам.
const offsetCache = new Map<string, number>();
const BUCKET = 15 * 60_000;

/** Смещение пояса tz от UTC в момент ms, в миллисекундах (Москва: +3 ч). */
export function tzOffsetMs(ms: number, tz: string): number {
  if (tz === 'UTC' || tz === 'Etc/UTC') return 0;
  const key = `${tz}|${Math.floor(ms / BUCKET)}`;
  const hit = offsetCache.get(key);
  if (hit !== undefined) return hit;
  const p = zonedParts(ms, tz);
  const off = Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s) - Math.floor(ms / 1000) * 1000;
  if (offsetCache.size > 50_000) offsetCache.clear();
  offsetCache.set(key, off);
  return off;
}

/** Момент UTC (мс) для настенного времени в поясе tz. В «дыре» перевода часов — ближайшее допустимое. */
export function zonedToUtc(y: number, mo: number, d: number, h: number, mi: number, tz: string): number {
  const wall = Date.UTC(y, mo - 1, d, h, mi);
  let t = wall - tzOffsetMs(wall, tz);
  const o2 = tzOffsetMs(t, tz);
  if (o2 !== wall - t) t = wall - o2;
  return t;
}

// ---- Срабатывания ----

function dayMatches(spec: CronSpec, mo: number, d: number, dow: number): boolean {
  if (!spec.months.includes(mo)) return false;
  const dm = spec.days.includes(d);
  const wm = spec.weekdays.includes(dow);
  if (spec.dayStar || spec.weekdayStar) return dm && wm;
  return dm || wm;
}

/** Срабатывания не раньше fromMs, по возрастанию, в пределах maxDays суток. */
function* fires(spec: CronSpec, fromMs: number, tz: string, maxDays: number): Generator<number> {
  const p = zonedParts(fromMs, tz);
  let last = -Infinity;
  for (let i = 0; i <= maxDays; i++) {
    const day = new Date(Date.UTC(p.y, p.mo - 1, p.d + i));
    const y = day.getUTCFullYear();
    const mo = day.getUTCMonth() + 1;
    const d = day.getUTCDate();
    if (!dayMatches(spec, mo, d, day.getUTCDay())) continue;
    for (const h of spec.hours) {
      for (const mi of spec.minutes) {
        const t = zonedToUtc(y, mo, d, h, mi, tz);
        if (t >= fromMs && t > last) {
          last = t;
          yield t;
        }
      }
    }
  }
}

const asSpec = (s: CronSpec | string): CronSpec => (typeof s === 'string' ? parseCron(s) : s);

/** Следующее срабатывание строго после after; null — если в ближайшие 5 лет его нет (например, 31 февраля). */
export function cronNext(spec: CronSpec | string, after: Date | number, tz: string): Date | null {
  const from = (typeof after === 'number' ? after : after.getTime()) + 1;
  for (const t of fires(asSpec(spec), from, tz, 366 * 5)) return new Date(t);
  return null;
}

/** Все срабатывания в [from, to), по возрастанию. */
export function cronBetween(spec: CronSpec | string, from: Date | number, to: Date | number, tz: string): Date[] {
  const a = typeof from === 'number' ? from : from.getTime();
  const b = typeof to === 'number' ? to : to.getTime();
  const out: Date[] = [];
  if (b <= a) return out;
  for (const t of fires(asSpec(spec), a, tz, Math.ceil((b - a) / 86_400_000) + 2)) {
    if (t >= b) break;
    out.push(new Date(t));
  }
  return out;
}

// ---- Человекочитаемый текст ----

const WEEKDAY_PLURAL = ['по воскресеньям', 'по понедельникам', 'по вторникам', 'по средам', 'по четвергам', 'по пятницам', 'по субботам'];
const WEEKDAY_SHORT = ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'];

/** Шаг n, если значения ровно покрывают весь диапазон с шагом n (0,15,30,45 → 15); иначе null. */
function evenStep(values: number[], size: number): number | null {
  if (values.length < 1) return null;
  const n = values.length === 1 ? size : values[1] - values[0];
  if (n <= 0 || size % n !== 0 || values.length !== size / n || values[0] >= n) return null;
  return values.every((v, i) => v === values[0] + i * n) ? n : null;
}

function weekdayText(days: number[]): string | null {
  const key = days.join(',');
  if (key === '0,1,2,3,4,5,6') return '';
  if (key === '1,2,3,4,5') return 'по будням';
  if (key === '0,6') return 'по выходным';
  if (days.length === 1) return WEEKDAY_PLURAL[days[0]];
  // понедельник первым, воскресенье в конце — как привычно
  return [...days].sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7)).map(d => WEEKDAY_SHORT[d]).join(', ');
}

const hhmm = (min: number) => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;

function joinTimes(times: string[]): string {
  return times.length <= 1 ? times.join('') : `${times.slice(0, -1).join(', ')} и ${times[times.length - 1]}`;
}

export interface CronTextOptions {
  /** Пояс, в котором записан cron. */
  tz?: string;
  /** Пояс, в котором показывать время (обычно Europe/Moscow). Если отличается от tz — время пересчитывается. */
  displayTz?: string;
  /** Срабатывание со случайной задержкой (таймер systemd) — перед временем ставится «~». */
  approx?: boolean;
  /** Момент, на который считать разницу поясов; по умолчанию — сейчас. */
  now?: Date;
}

/**
 * «каждый час», «каждые 2 ч», «каждые 30 мин», «ежедневно 08:00», «по будням 09:00», «по понедельникам 09:00»;
 * чего не умеем сказать по-человечески — сам cron.
 */
export function cronText(expr: string, opts: CronTextOptions = {}): string {
  let spec: CronSpec;
  try {
    spec = parseCron(expr);
  } catch {
    return expr.trim();
  }
  const raw = spec.source;
  if (!spec.dayStar || !spec.monthStar) return raw;
  const days = weekdayText(spec.weekdays);
  if (days === null) return raw;
  const prefix = (s: string) => (days ? `${days} ${s}` : s);

  const minStep = evenStep(spec.minutes, 60);
  const hourStep = evenStep(spec.hours, 24);
  if (hourStep === 1 && minStep !== null && minStep < 60) {
    return prefix(minStep === 1 ? 'каждую минуту' : `каждые ${minStep} мин`);
  }
  if (spec.minutes.length === 1 && hourStep !== null && hourStep < 24) {
    return prefix(hourStep === 1 ? 'каждый час' : `каждые ${hourStep} ч`);
  }
  if (spec.minutes.length * spec.hours.length > 6) return raw;

  let times = spec.hours.flatMap(h => spec.minutes.map(m => h * 60 + m));
  const { tz, displayTz } = opts;
  if (tz && displayTz && tz !== displayTz) {
    const at = (opts.now ?? new Date()).getTime();
    const shift = Math.round((tzOffsetMs(at, displayTz) - tzOffsetMs(at, tz)) / 60_000);
    const shifted = times.map(t => t + shift);
    // день недели при переходе через полночь сдвинулся бы — тогда честно показываем cron с поясом
    if (days && shifted.some(t => t < 0 || t >= 1440)) return `${raw} (${tz})`;
    times = shifted.map(t => ((t % 1440) + 1440) % 1440);
  }
  times = [...new Set(times)].sort((a, b) => a - b);
  const text = joinTimes(times.map(t => (opts.approx ? '~' : '') + hhmm(t)));
  return days ? `${days} ${text}` : `ежедневно ${text}`;
}
