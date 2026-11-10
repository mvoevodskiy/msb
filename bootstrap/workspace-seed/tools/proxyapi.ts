#!/usr/bin/env -S node --disable-warning=ExperimentalWarning
// ProxyAPI: остаток в рублях. Бесплатно. Ключ — PROXYAPI_KEY.

import { parseArgs } from 'node:util';
import { asUsageError, type Deps, getJson, main, requireEnv, rub, ToolError, UsageError } from './lib.ts';

export const BALANCE_URL = 'https://api.proxyapi.ru/proxyapi/balance';
/** Порог напоминания о пополнении. */
export const LOW_RUB = 50;

const HELP = `ProxyAPI: остаток в рублях. Бесплатно.

  proxyapi.ts [balance]   остаток; ниже ${LOW_RUB} ₽ — напоминание пополнить
  --json                  машиночитаемый вывод

Окружение: PROXYAPI_KEY.`;

export async function balance(deps: Deps): Promise<number> {
  const key = requireEnv(deps.env, 'PROXYAPI_KEY');
  const data = (await getJson(BALANCE_URL, { Authorization: `Bearer ${key}` }, deps)) as { balance?: unknown };
  if (typeof data.balance !== 'number' || !Number.isFinite(data.balance)) {
    throw new ToolError(`ProxyAPI: в ответе нет balance: ${JSON.stringify(data).slice(0, 200)}`);
  }
  return Math.round(data.balance * 100) / 100;
}

export async function run(argv: string[], deps: Deps): Promise<string> {
  let parsed;
  try {
    parsed = parseArgs({ args: argv, allowPositionals: true, options: { json: { type: 'boolean' }, help: { type: 'boolean', short: 'h' } } });
  } catch (error) {
    asUsageError(error);
  }
  const { values, positionals } = parsed;
  if (values.help) return HELP;
  const command = positionals[0] ?? 'balance';
  if (command !== 'balance' || positionals.length > 1) throw new UsageError(`Неизвестная команда «${positionals.join(' ')}»: только balance`);
  const value = await balance(deps);
  const low = value < LOW_RUB;
  if (values.json) return JSON.stringify({ balanceRub: value, low });
  return `ProxyAPI, остаток: ${rub(value)}${low ? ` — мало, пора пополнить (порог ${LOW_RUB} ₽)` : ''}`;
}

main(import.meta.url, run);
