// Общее для инструментов: запуск команды, HTTP-запрос JSON, ошибки и числа по-русски.
// Каждый инструмент экспортирует run(argv, deps) → текст: тесты зовут его с подменным fetch и env.

import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export type Env = Readonly<Record<string, string | undefined>>;

export interface Deps {
  env: Env;
  fetch?: typeof fetch;
  now?: Date;
  timeoutMs?: number;
}

/** Ожидаемая ошибка: печатается текстом без стека, код выхода 1. */
export class ToolError extends Error {}

/** Неверный вызов: печатается с подсказкой про --help, код выхода 2. */
export class UsageError extends Error {}

export const DEFAULT_TIMEOUT_MS = 20_000;

function host(url: string): string {
  return new URL(url).hostname;
}

export async function getJson(url: string, headers: Record<string, string>, deps: Deps): Promise<unknown> {
  const doFetch = deps.fetch ?? fetch;
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let res: Response;
  try {
    res = await doFetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    const err = error as Error;
    if (err.name === 'TimeoutError' || err.name === 'AbortError') {
      throw new ToolError(`${host(url)}: нет ответа за ${Math.round(timeoutMs / 1000)} с`);
    }
    throw new ToolError(`${host(url)}: сеть недоступна (${err.message})`);
  }
  const text = await res.text();
  // Тело ошибки обрезаем: сервисы не возвращают в нём ключ, но длинный ответ засоряет вывод.
  if (!res.ok) throw new ToolError(`${host(url)}: HTTP ${res.status} ${text.slice(0, 300)}`);
  try {
    return JSON.parse(text);
  } catch {
    throw new ToolError(`${host(url)}: ответ не JSON: ${text.slice(0, 200)}`);
  }
}

export function requireEnv(env: Env, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new ToolError(`Нет переменной окружения ${name}: добавь её в /settings → «Переменные окружения».`);
  return value;
}

/** 199.91986 → «199,92»; суммы меньше 0,01 — с четырьмя знаками, чтобы не превращались в 0. */
export function decimal(n: number): string {
  const digits = n !== 0 && Math.abs(n) < 0.01 ? 4 : 2;
  return n.toFixed(digits).replace('.', ',');
}

export function usd(n: number): string {
  return `$${decimal(n)}`;
}

export function rub(n: number): string {
  return `${decimal(n)} ₽`;
}

/** plural(5, ['запрос', 'запроса', 'запросов']) → «запросов». */
export function plural(n: number, forms: readonly [string, string, string]): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return forms[0];
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return forms[1];
  return forms[2];
}

/** Запуск из командной строки; при импорте (тесты) ничего не делает. */
export function main(moduleUrl: string, run: (argv: string[], deps: Deps) => Promise<string>): void {
  const entry = process.argv[1];
  if (!entry || pathToFileURL(realpathSync(entry)).href !== moduleUrl) return;
  run(process.argv.slice(2), { env: process.env }).then(
    (out) => {
      process.stdout.write(out.endsWith('\n') ? out : `${out}\n`);
    },
    (error: unknown) => {
      if (error instanceof UsageError) {
        process.stderr.write(`${error.message}\nСправка: --help\n`);
        process.exitCode = 2;
      } else if (error instanceof ToolError) {
        process.stderr.write(`${error.message}\n`);
        process.exitCode = 1;
      } else {
        process.stderr.write(`${(error as Error)?.stack ?? String(error)}\n`);
        process.exitCode = 1;
      }
    },
  );
}

/** Ошибки parseArgs (неизвестный флаг, нет значения) → UsageError. */
export function asUsageError(error: unknown): never {
  const code = (error as { code?: string }).code;
  if (typeof code === 'string' && code.startsWith('ERR_PARSE_ARGS')) throw new UsageError((error as Error).message);
  throw error;
}
