#!/usr/bin/env -S node --disable-warning=ExperimentalWarning
// Deepgram: остаток, ключи, расход по ключам. Только чтение служебных данных — бесплатно.
// Нужен DEEPGRAM_API_KEY с правами admin (ключ агента «AgentKey»): у ключа DemoApp (usage:write) доступа нет.

import { parseArgs } from 'node:util';
import { asUsageError, type Deps, getJson, main, plural, requireEnv, ToolError, UsageError, usd } from './lib.ts';

export const API = 'https://api.deepgram.com';
/** Больше 100 записей на страницу Deepgram не отдаёт (проверено 25.10.2026). */
export const PAGE_LIMIT = 100;
/** Защита от бесконечного цикла: 200 страниц = 20 000 запросов за период. */
export const MAX_PAGES = 200;

const HELP = `Deepgram: остаток, ключи и расход по ключам. Бесплатно.

  deepgram.ts [balance]              остаток проекта
  deepgram.ts keys                   ключи: имя, права, дата создания
  deepgram.ts usage [--from Д] [--to Д]
                                     расход по ключам за период (даты ГГГГ-ММ-ДД, UTC, включительно;
                                     по умолчанию — с 1-го числа текущего месяца по сегодня)
  --json                             машиночитаемый вывод

Окружение: DEEPGRAM_API_KEY (права admin), DEEPGRAM_PROJECT_ID — если у ключа больше одного проекта.`;

export interface Balance {
  amount: number;
  units: string;
}

export interface KeyInfo {
  id: string;
  name: string;
  scopes: string[];
  created: string;
}

export interface UsageRow {
  keyId: string;
  /** Имя ключа в Deepgram; удалённые ключи — «удалённый ключ <начало id>». */
  name: string;
  requests: number;
  seconds: number;
  usd: number;
}

export interface Usage {
  from: string;
  to: string;
  rows: UsageRow[];
  total: Omit<UsageRow, 'keyId' | 'name'>;
}

function headers(deps: Deps): Record<string, string> {
  return { Authorization: `Token ${requireEnv(deps.env, 'DEEPGRAM_API_KEY')}` };
}

export async function projectId(deps: Deps): Promise<string> {
  const fromEnv = deps.env.DEEPGRAM_PROJECT_ID?.trim();
  if (fromEnv) return fromEnv;
  const data = (await getJson(`${API}/v1/projects`, headers(deps), deps)) as {
    projects?: { project_id: string; name: string }[];
  };
  const list = data.projects ?? [];
  if (list.length === 1) return list[0]!.project_id;
  if (list.length === 0) throw new ToolError('Deepgram: ключ не видит ни одного проекта.');
  const names = list.map((p) => `${p.project_id} «${p.name}»`).join(', ');
  throw new ToolError(`Deepgram: у ключа ${list.length} проекта, укажи DEEPGRAM_PROJECT_ID: ${names}.`);
}

export async function balance(deps: Deps, project?: string): Promise<Balance[]> {
  const id = project ?? (await projectId(deps));
  const data = (await getJson(`${API}/v1/projects/${id}/balances`, headers(deps), deps)) as {
    balances?: { amount?: unknown; units?: unknown }[];
  };
  return (data.balances ?? []).map((b) => {
    if (typeof b.amount !== 'number') throw new ToolError(`Deepgram: в ответе нет суммы остатка: ${JSON.stringify(b).slice(0, 200)}`);
    return { amount: b.amount, units: typeof b.units === 'string' ? b.units : '?' };
  });
}

export async function keys(deps: Deps, project?: string): Promise<KeyInfo[]> {
  const id = project ?? (await projectId(deps));
  const data = (await getJson(`${API}/v1/projects/${id}/keys`, headers(deps), deps)) as {
    api_keys?: { api_key?: { api_key_id: string; comment?: string; scopes?: string[]; created?: string } }[];
  };
  return (data.api_keys ?? []).flatMap((k) =>
    k.api_key
      ? [{ id: k.api_key.api_key_id, name: k.api_key.comment ?? '', scopes: k.api_key.scopes ?? [], created: k.api_key.created ?? '' }]
      : [],
  );
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;

function nextDay(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

export function defaultRange(now: Date): { from: string; to: string } {
  const today = now.toISOString().slice(0, 10);
  return { from: `${today.slice(0, 8)}01`, to: today };
}

/** Настоящая дата календаря: V8 принимает «2026-02-30» и переносит на март, поэтому сверяем обратно. */
function isDate(value: string): boolean {
  if (!DATE.test(value)) return false;
  const ms = Date.parse(`${value}T00:00:00Z`);
  return !Number.isNaN(ms) && new Date(ms).toISOString().slice(0, 10) === value;
}

export function checkRange(from: string, to: string): void {
  for (const [flag, value] of [['--from', from], ['--to', to]] as const) {
    if (!isDate(value)) {
      throw new UsageError(`${flag}: нужна дата ГГГГ-ММ-ДД, получено «${value}»`);
    }
  }
  if (from > to) throw new UsageError(`--from (${from}) позже --to (${to})`);
}

interface RequestRecord {
  created?: string;
  api_key_id?: string;
  response?: { details?: { usd?: number; duration?: number } };
}

export async function usage(deps: Deps, from: string, to: string, project?: string): Promise<Usage> {
  checkRange(from, to);
  const id = project ?? (await projectId(deps));
  const names = new Map((await keys(deps, id)).map((k) => [k.id, k.name]));
  // У Deepgram конец периода не входит в выборку, поэтому end = следующий день; created ещё раз
  // сверяем сами — на случай, если граница у API поменяется.
  const end = nextDay(to);
  const byKey = new Map<string, UsageRow>();
  for (let page = 0; ; page++) {
    if (page >= MAX_PAGES) throw new ToolError(`Deepgram: больше ${MAX_PAGES * PAGE_LIMIT} запросов за период — сузь --from/--to.`);
    const url = `${API}/v1/projects/${id}/requests?start=${from}&end=${end}&limit=${PAGE_LIMIT}&page=${page}`;
    const data = (await getJson(url, headers(deps), deps)) as { requests?: RequestRecord[] };
    const list = data.requests ?? [];
    for (const r of list) {
      const day = (r.created ?? '').slice(0, 10);
      if (day < from || day >= end) continue;
      const keyId = r.api_key_id ?? '?';
      const row = byKey.get(keyId) ?? {
        keyId,
        name: names.get(keyId) || `удалённый ключ ${keyId.slice(0, 8)}`,
        requests: 0,
        seconds: 0,
        usd: 0,
      };
      row.requests += 1;
      row.seconds += r.response?.details?.duration ?? 0;
      row.usd += r.response?.details?.usd ?? 0;
      byKey.set(keyId, row);
    }
    if (list.length < PAGE_LIMIT) break;
  }
  const rows = [...byKey.values()].sort((a, b) => b.usd - a.usd || b.requests - a.requests);
  const total = rows.reduce((t, r) => ({ requests: t.requests + r.requests, seconds: t.seconds + r.seconds, usd: t.usd + r.usd }), {
    requests: 0,
    seconds: 0,
    usd: 0,
  });
  return { from, to, rows, total };
}

const REQUESTS = ['запрос', 'запроса', 'запросов'] as const;

function minutes(seconds: number): string {
  return `${(seconds / 60).toFixed(1).replace('.', ',')} мин`;
}

function ru(date: string): string {
  return `${date.slice(8, 10)}.${date.slice(5, 7)}.${date.slice(0, 4)}`;
}

function money(amount: number, units: string): string {
  return units === 'usd' ? usd(amount) : `${amount} ${units}`;
}

export function formatUsage(u: Usage): string {
  const head = `Deepgram, расход ${ru(u.from)}–${ru(u.to)} (UTC):`;
  if (u.rows.length === 0) return `${head}\n  запросов не было`;
  const line = (name: string, r: Omit<UsageRow, 'keyId' | 'name'>) =>
    `  ${name}: ${r.requests} ${plural(r.requests, REQUESTS)}, ${minutes(r.seconds)}, ${usd(r.usd)}`;
  return [head, ...u.rows.map((r) => line(r.name, r)), line('Итого', u.total)].join('\n');
}

export async function run(argv: string[], deps: Deps): Promise<string> {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: { json: { type: 'boolean' }, help: { type: 'boolean', short: 'h' }, from: { type: 'string' }, to: { type: 'string' } },
    });
  } catch (error) {
    asUsageError(error);
  }
  const { values, positionals } = parsed;
  if (values.help) return HELP;
  const command = positionals[0] ?? 'balance';
  if (positionals.length > 1) throw new UsageError(`Лишние аргументы: ${positionals.slice(1).join(' ')}`);
  if ((values.from || values.to) && command !== 'usage') throw new UsageError('--from и --to — только для usage');

  switch (command) {
    case 'balance': {
      const list = await balance(deps);
      if (values.json) return JSON.stringify({ balances: list });
      if (list.length === 0) return 'Deepgram: остатка нет (проект без средств).';
      return `Deepgram, остаток: ${list.map((b) => money(b.amount, b.units)).join(' + ')}`;
    }
    case 'keys': {
      const list = await keys(deps);
      if (values.json) return JSON.stringify({ keys: list });
      return ['Deepgram, ключи:', ...list.map((k) => `  ${k.name || '(без имени)'}: ${k.scopes.join(', ')}, создан ${k.created.slice(0, 10)}`)].join('\n');
    }
    case 'usage': {
      const range = defaultRange(deps.now ?? new Date());
      const u = await usage(deps, values.from ?? range.from, values.to ?? range.to);
      return values.json ? JSON.stringify(u) : formatUsage(u);
    }
    default:
      throw new UsageError(`Неизвестная команда «${command}»: balance, keys, usage`);
  }
}

main(import.meta.url, run);
