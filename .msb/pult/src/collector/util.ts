// Общие кирпичи сборщика: запуск команд с таймаутом, чтение JSON/JSONL без падений на битых строках,
// короткий хеш id, вычистка следов платформы ботов из любых текстов, которые идут в снимок.

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, fstatSync, openSync, readFileSync, readSync } from 'node:fs';
import type { SourceError } from '../shared/types.ts';

export interface ExecResult {
  /** Код выхода; null — процесс не запустился или убит по таймауту. */
  code: number | null;
  stdout: string;
  stderr: string;
  /** Что пошло не так — по-русски, одной строкой. */
  error: string | null;
}

export type Exec = (cmd: string, args: string[], opts?: { timeoutMs?: number; env?: NodeJS.ProcessEnv }) => Promise<ExecResult>;

/** systemctl и git печатают время в поясе процесса — фиксируем UTC и язык C, чтобы разбирать однозначно. */
export const execCmd: Exec = (cmd, args, opts = {}) =>
  new Promise(resolve => {
    const timeoutMs = opts.timeoutMs ?? 10_000;
    execFile(cmd, args, {
      timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024, encoding: 'utf8',
      env: opts.env ?? { ...process.env, TZ: 'UTC', LC_ALL: 'C', LANG: 'C' },
    }, (err, stdout, stderr) => {
      if (!err) return resolve({ code: 0, stdout, stderr, error: null });
      const e = err as NodeJS.ErrnoException & { killed?: boolean; code?: number | string };
      let error: string;
      if (e.code === 'ENOENT') error = `команда не найдена: ${cmd}`;
      else if (e.killed) error = `${cmd} не ответил за ${Math.round(timeoutMs / 1000)} с`;
      else error = firstLine(stderr) || `${cmd} завершился с кодом ${e.code}`;
      resolve({ code: typeof e.code === 'number' ? e.code : null, stdout: stdout ?? '', stderr: stderr ?? '', error });
    });
  });

export const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

export function firstLine(s: string): string {
  return (s.split('\n').find(l => l.trim()) ?? '').trim();
}

/** Короткий стабильный id для снимка: внутренние id платформы наружу не уходят. */
export function shortHash(id: string): string {
  return createHash('sha1').update(id).digest('hex').slice(0, 10);
}

// Любой токен с именем платформы (msb-bot@…, ~/.msb/…, iia/jarvis) заменяется на «…».
const PLATFORM_RE = /[^\s"'«»()<>,;]*(?<![a-z])(?:msb|iia|jarvis)(?![a-z])[^\s"'«»()<>,;]*/gi;

export function scrub(text: string): string {
  return text.replace(PLATFORM_RE, '…');
}

export function scrubOrNull(text: string | null | undefined): string | null {
  return text == null ? null : scrub(text);
}

/** Ошибки источников: одна строка, без стека и без путей платформы. */
export class Problems {
  readonly list: SourceError[] = [];

  add(source: string, err: unknown): void {
    const message = scrub(firstLine(errText(err)) || 'неизвестная ошибка');
    if (!this.list.some(p => p.source === source && p.message === message)) this.list.push({ source: scrub(source), message });
  }

  /** Выполнить источник; упал — запись в список и запасное значение. */
  guard<T>(source: string, fn: () => T, fallback: T): T {
    try {
      return fn();
    } catch (e) {
      this.add(source, e);
      return fallback;
    }
  }

  async guardAsync<T>(source: string, fn: () => Promise<T>, fallback: T): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      this.add(source, e);
      return fallback;
    }
  }
}

/** Ошибка, текст которой уже годится для людей. */
export class SourceFailure extends Error {}

function errText(err: unknown): string {
  if (err instanceof SourceFailure) return err.message;
  const e = err as NodeJS.ErrnoException;
  if (e?.code === 'ENOENT') return 'нет файла';
  if (e?.code === 'EACCES' || e?.code === 'EPERM') return 'нет доступа';
  if (err instanceof SyntaxError) return 'файл повреждён (не JSON)';
  return e?.message ?? String(err);
}

/** Прочитать JSON; null — файла нет. Остальные ошибки — исключение с понятным текстом. */
export function readJsonFile(path: string): unknown {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw e;
  }
  try {
    return JSON.parse(raw);
  } catch {
    throw new SourceFailure('файл повреждён (не JSON)');
  }
}

/** Хвост файла не длиннее maxBytes (первая, возможно обрезанная, строка отбрасывается). null — файла нет. */
export function readTail(path: string, maxBytes: number): string | null {
  let fd: number;
  try {
    fd = openSync(path, 'r');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw e;
  }
  try {
    const size = fstatSync(fd).size;
    const start = Math.max(0, size - maxBytes);
    const buf = Buffer.alloc(size - start);
    let off = 0;
    while (off < buf.length) {
      const n = readSync(fd, buf, off, buf.length - off, start + off);
      if (n <= 0) break;
      off += n;
    }
    const text = buf.subarray(0, off).toString('utf8');
    return start > 0 ? text.slice(text.indexOf('\n') + 1) : text;
  } finally {
    closeSync(fd);
  }
}

/** JSONL: по объекту на строку, битые строки пропускаются. null — файла нет. */
export function readJsonl<T = Record<string, unknown>>(path: string, maxBytes = 16 * 1024 * 1024): T[] | null {
  const text = readTail(path, maxBytes);
  if (text === null) return null;
  return parseJsonl<T>(text);
}

export function parseJsonl<T = Record<string, unknown>>(text: string): T[] {
  const out: T[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const v = JSON.parse(line);
      if (v && typeof v === 'object' && !Array.isArray(v)) out.push(v as T);
    } catch { /* битая строка — пропускаем */ }
  }
  return out;
}

/** Время из ISO-строки; NaN → null. */
export function isoMs(v: unknown): number | null {
  if (typeof v !== 'string' && typeof v !== 'number') return null;
  const t = typeof v === 'number' ? v : Date.parse(v);
  return Number.isFinite(t) ? t : null;
}

export const iso = (ms: number) => new Date(ms).toISOString();

/** «ГГГГ-ММ-ДД» по UTC — так названы дневные журналы ботов. */
export const utcDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);
