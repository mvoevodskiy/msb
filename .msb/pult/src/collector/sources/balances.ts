// Остатки на платных сервисах: ProxyAPI и Apify — из файлов, которые пишут их проверки;
// Deepgram — бесплатной командой из реестра инструментов, не чаще everyMin, результат держим в памяти процесса.

import type { Balance } from '../../shared/types.ts';
import { clip, fmtRub, fmtUsd } from '../../shared/format.ts';
import { firstLine, iso, isoMs, readJsonFile, scrub, type Exec } from '../util.ts';

const HOUR = 3_600_000;

const noData = (id: string, name: string, note: string, checkedAt: string | null = null): Balance =>
  ({ id, name, value: 'нет данных', ok: null, checkedAt, stale: false, note: clip(scrub(note), 160) });

function readOr(path: string): { data: Record<string, unknown> | null; error: string | null } {
  try {
    const d = readJsonFile(path);
    if (d === null) return { data: null, error: 'нет файла проверки' };
    if (typeof d !== 'object' || Array.isArray(d)) return { data: null, error: 'файл проверки не разобран' };
    return { data: d as Record<string, unknown>, error: null };
  } catch (e) {
    return { data: null, error: (e as Error).message };
  }
}

/** ProxyAPI: {checkedAt, ok, balanceRub, low}. Устарел — проверке больше 3 ч. */
export function proxyapiBalance(path: string, lowRub: number | null, nowMs: number): Balance {
  const { data, error } = readOr(path);
  if (!data) return noData('proxyapi', 'ProxyAPI', error ?? 'нет данных');
  const checked = isoMs(data.checkedAt);
  const checkedAt = checked === null ? null : iso(checked);
  if (typeof data.balanceRub !== 'number') return noData('proxyapi', 'ProxyAPI', data.ok === false ? 'последняя проверка не удалась' : 'в файле нет balanceRub', checkedAt);
  const low = typeof data.low === 'boolean' ? data.low : lowRub !== null ? data.balanceRub < lowRub : null;
  return {
    id: 'proxyapi', name: 'ProxyAPI', value: fmtRub(data.balanceRub),
    ok: low === null ? null : !low,
    checkedAt,
    stale: checked === null || nowMs - checked > 3 * HOUR,
    note: data.ok === false ? 'последняя проверка не удалась — показан прошлый остаток' : null,
  };
}

/** Apify: месяц из x-status.json → «$0,007 из $5»; норма — меньше 80 % лимита. Устарел — данным больше 12 ч. */
export function apifyBalance(path: string, nowMs: number): Balance {
  const { data, error } = readOr(path);
  if (!data) return noData('apify', 'Apify', error ?? 'нет данных');
  const month = (data.month ?? {}) as Record<string, unknown>;
  const checked = isoMs(data.last_run) ?? isoMs(data.last_ok);
  const checkedAt = checked === null ? null : iso(checked);
  const used = month.account_usage_usd;
  const limit = month.account_limit_usd;
  if (typeof used !== 'number' || typeof limit !== 'number' || limit <= 0) return noData('apify', 'Apify', 'в файле нет расхода и лимита за месяц', checkedAt);
  return {
    id: 'apify', name: 'Apify', value: `${fmtUsd(used)} из ${fmtUsd(limit)}`,
    ok: used < 0.8 * limit,
    checkedAt,
    stale: checked === null || nowMs - checked > 12 * HOUR,
    note: null,
  };
}

/** Вывод `deepgram.ts balance --json`: {"balances":[{"amount":199.9,"units":"usd"}]} → сумма в долларах. */
export function parseDeepgram(stdout: string): number {
  const d = JSON.parse(stdout) as { balances?: { amount?: unknown; units?: unknown }[] };
  const list = (d.balances ?? []).filter(b => typeof b.amount === 'number' && String(b.units ?? 'usd').toLowerCase() === 'usd');
  if (!list.length) throw new Error('в ответе нет остатка в долларах');
  return list.reduce((s, b) => s + (b.amount as number), 0);
}

export class DeepgramBalance {
  private readonly command: string[];
  private readonly everyMs: number;
  private readonly lowUsd: number | null;
  private readonly exec: Exec;
  private cache: { atMs: number; balance: Balance } | null = null;
  private lastOk: { atMs: number; amount: number } | null = null;
  private inflight: Promise<Balance> | null = null;

  constructor(cfg: { command: string[]; everyMin: number; lowUsd: number | null }, exec: Exec) {
    this.command = cfg.command;
    this.everyMs = cfg.everyMin * 60_000;
    this.lowUsd = cfg.lowUsd;
    this.exec = exec;
  }

  /**
   * Остаток не чаще everyMin. maxWaitMs — сколько ждать свежего ответа (API Deepgram отвечает 2–4 с):
   * не дождались — отдаём прошлый результат, а запрос дорабатывает в фоне и попадёт в следующий снимок.
   */
  async get(nowMs: number, env: NodeJS.ProcessEnv, maxWaitMs?: number): Promise<Balance> {
    if (this.cache && nowMs - this.cache.atMs < this.everyMs) return this.withStale(this.cache.balance, nowMs);
    if (!this.inflight) {
      this.inflight = this.fetch(env, nowMs).then(balance => {
        this.cache = { atMs: nowMs, balance };
        this.inflight = null;
        return balance;
      });
    }
    if (maxWaitMs === undefined) return this.inflight;
    let timer: NodeJS.Timeout | undefined;
    const late = new Promise<null>(r => {
      timer = setTimeout(() => r(null), maxWaitMs);
    });
    const fresh = await Promise.race([this.inflight, late]);
    clearTimeout(timer);
    if (fresh) return fresh;
    if (this.cache) return this.withStale(this.cache.balance, nowMs);
    return noData('deepgram', 'Deepgram', 'остаток запрашивается — будет в следующем снимке');
  }

  private withStale(b: Balance, nowMs: number): Balance {
    if (!this.lastOk || b.value === 'нет данных') return b;
    return { ...b, stale: nowMs - this.lastOk.atMs > 2 * this.everyMs };
  }

  private async fetch(env: NodeJS.ProcessEnv, nowMs: number): Promise<Balance> {
    if (!env.DEEPGRAM_API_KEY) return this.fallback('нет ключа DEEPGRAM_API_KEY');
    const [cmd, ...args] = this.command;
    const r = await this.exec(cmd, args, { timeoutMs: 20_000, env: { ...env, LC_ALL: 'C' } });
    if (r.code !== 0) return this.fallback(r.error ?? (firstLine(r.stderr) || 'команда не сработала'));
    let amount: number;
    try {
      amount = parseDeepgram(r.stdout);
    } catch (e) {
      return this.fallback(`ответ не разобран: ${(e as Error).message}`);
    }
    this.lastOk = { atMs: nowMs, amount };
    return {
      id: 'deepgram', name: 'Deepgram', value: fmtUsd(amount),
      ok: this.lowUsd === null ? amount > 0 : amount >= this.lowUsd,
      checkedAt: iso(nowMs), stale: false, note: null,
    };
  }

  /** Ошибка проверки: если раньше остаток был получен — показываем его как устаревший, иначе «нет данных». */
  private fallback(reason: string): Balance {
    if (!this.lastOk) return noData('deepgram', 'Deepgram', reason);
    return {
      id: 'deepgram', name: 'Deepgram', value: fmtUsd(this.lastOk.amount), ok: null,
      checkedAt: iso(this.lastOk.atMs), stale: true, note: clip(scrub(reason), 160),
    };
  }
}
