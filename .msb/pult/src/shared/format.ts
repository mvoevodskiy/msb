// Готовые строки для снимка и текстов тревог: время в поясе панели (по умолчанию МСК), числа по-русски
// (запятая, разряды через пробел), единицы — сокращениями, как на эталонных экранах: «8,4 млн», «4,4 ГБ», «$0,005».

import { zonedParts } from './cron.ts';

export const PANEL_TZ = 'Europe/Moscow';

type When = Date | string | number;
const ms = (d: When) => (d instanceof Date ? d.getTime() : typeof d === 'number' ? d : Date.parse(d));
const two = (n: number) => String(n).padStart(2, '0');

/** «13:45» */
export function fmtTime(d: When, tz = PANEL_TZ): string {
  const p = zonedParts(ms(d), tz);
  return `${two(p.h)}:${two(p.mi)}`;
}

/** «28.10» */
export function fmtDate(d: When, tz = PANEL_TZ): string {
  const p = zonedParts(ms(d), tz);
  return `${two(p.d)}.${two(p.mo)}`;
}

/** «28.10 13:45» */
export function fmtDateTime(d: When, tz = PANEL_TZ): string {
  return `${fmtDate(d, tz)} ${fmtTime(d, tz)}`;
}

/** «13:45», если тот же день, что now (в поясе tz), иначе «28.10 13:45». */
export function fmtWhen(d: When, now: When, tz = PANEL_TZ): string {
  return fmtDate(d, tz) === fmtDate(now, tz) ? fmtTime(d, tz) : fmtDateTime(d, tz);
}

/**
 * Число по-русски: разряды через пробел, запятая. Округляется до maxDecimals знаков,
 * хвостовые нули убираются, но не меньше minDecimals знаков.
 */
export function fmtNumber(n: number, maxDecimals = 0, minDecimals = 0): string {
  if (!Number.isFinite(n)) return '—';
  const neg = n < 0;
  let [int, frac = ''] = Math.abs(n).toFixed(maxDecimals).split('.');
  frac = frac.replace(/0+$/, '');
  while (frac.length < minDecimals) frac += '0';
  int = int.replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  return (neg ? '-' : '') + int + (frac ? ',' + frac : '');
}

/** Количество: «512», «43 тыс.», «8,4 млн», «1,2 млрд». */
export function fmtCount(n: number): string {
  const a = Math.abs(n);
  if (a >= 1e9) return `${fmtNumber(n / 1e9, 1, 1)} млрд`;
  if (a >= 999_500) return `${fmtNumber(n / 1e6, 1, 1)} млн`;
  if (a >= 1000) return `${fmtNumber(Math.round(n / 1000))} тыс.`;
  return fmtNumber(Math.round(n));
}

/** Объём из мегабайт: «236 МБ», «1,0 ГБ», «4,4 ГБ». */
export function fmtMb(mb: number): string {
  if (Math.abs(mb) >= 1024) return `${fmtNumber(mb / 1024, 1, 1)} ГБ`;
  return `${fmtNumber(Math.round(mb))} МБ`;
}

/** Рубли: «334,75 ₽», «1 200 ₽». */
export function fmtRub(n: number): string {
  return `${Number.isInteger(n) ? fmtNumber(n) : fmtNumber(n, 2, 2)} ₽`;
}

/** Доллары: «$5», «$199,92», «$0,23», «$0,005»; совсем мало — «<$0,001». */
export function fmtUsd(n: number): string {
  const a = Math.abs(n);
  const sign = n < 0 ? '-' : '';
  if (a === 0) return '$0';
  if (Number.isInteger(n)) return `${sign}$${fmtNumber(a)}`;
  if (a >= 1) return `${sign}$${fmtNumber(a, 2, 2)}`;
  if (a < 0.0005) return '<$0,001';
  return `${sign}$${fmtNumber(a, 3, 2)}`;
}

/** Склонение: plural(5, 'ход', 'хода', 'ходов') → «ходов». */
export function plural(n: number, one: string, few: string, many: string): string {
  const a = Math.abs(n) % 100;
  const b = a % 10;
  if (a > 10 && a < 20) return many;
  if (b === 1) return one;
  if (b >= 2 && b <= 4) return few;
  return many;
}

/** Ядра процессора: «≈0,9 ядра», «≈2 ядра», «≈5 ядер». */
export function fmtCores(n: number): string {
  const r = Math.round(n * 10) / 10;
  if (!Number.isInteger(r)) return `≈${fmtNumber(r, 1, 1)} ядра`;
  return `≈${fmtNumber(r)} ${plural(r, 'ядро', 'ядра', 'ядер')}`;
}

/** Убрать переносы и лишние пробелы, обрезать до max символов с «…». */
export function clip(text: string, max: number): string {
  const chars = Array.from(text.replace(/\s+/g, ' ').trim());
  if (chars.length <= max) return chars.join('');
  return chars.slice(0, max - 1).join('').trimEnd() + '…';
}
