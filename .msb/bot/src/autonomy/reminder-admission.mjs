/**
 * Old local Rz admission for a due once/reminder. Existing breaker and
 * [box journals](./box-runs.mjs) precede [Claude quota](./subscription-gate.mjs)
 * and owner/action spend. [Dispatcher](./reminder-dispatch.mjs) owns the claim.
 * [Old reference and fixtures](../../tests/reminder-limits.test.mjs).
 */
import path from 'node:path';
import { actionRoot } from '../paths.mjs';
import { readBoxRunTotals } from './box-runs.mjs';
import { readOptionalJson } from './record-file.mjs';
import { claudeQuotaRefusal } from './subscription-gate.mjs';

const estimate = 0.10;
const russianPlural = new Intl.PluralRules('ru');

function nonnegativeCap(value, fallback) {
  if (value === undefined || value === '') return fallback;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : fallback;
}

function runWord(count) {
  return { one: 'ход', few: 'хода', many: 'ходов' }[russianPlural.select(count)];
}

async function boxRefusal(at, env) {
  const usd = nonnegativeCap(env.AUTONOMY_DAILY_CAP_USD, 5);
  const runs = nonnegativeCap(env.AUTONOMY_DAILY_CAP_RUNS, 200);
  const tokens = nonnegativeCap(env.AUTONOMY_DAILY_CAP_TOKENS, 10_000_000);
  if (!(usd || runs || tokens)) return;
  const totals = await readBoxRunTotals(at, env);
  const scope = totals.activeJournals > 1 ? ' (весь сервер, ботов: ' + totals.activeJournals + ')' : '';
  if (usd && totals.costUsd >= usd) {
    return 'дневной предел расходов автономки исчерпан: израсходовано около $' +
      totals.costUsd.toFixed(2) + ' из $' + usd.toFixed(2) + scope;
  }
  if (usd && totals.costUsd + estimate > usd) {
    return 'ход выйдет за дневной предел расходов автономки: $' + (totals.costUsd + estimate).toFixed(2) +
      ' против $' + usd.toFixed(2) + scope;
  }
  if (runs && totals.runs >= runs) {
    return 'сегодня автономка сделала ' + totals.runs + ' ' + runWord(totals.runs) +
      ' — это весь дневной запас (' + runs + '). Завтра счётчик обнулится.' + scope;
  }
  if (tokens && totals.tokensIn >= tokens) {
    return 'сегодня автономка прочитала ' + Math.round(totals.tokensIn / 1000) + ' тысяч токенов за ' +
      totals.runs + ' ' + runWord(totals.runs) + ' — это весь дневной запас (' + Math.round(tokens / 1000) +
      ' тысяч). Завтра счётчик обнулится.' + scope;
  }
}

function ownerDay(at, timezone) {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(new Date(at));
  } catch {
    return at.slice(0, 10);
  }
}

function spendRefusal(action, state, at, reserveFraction) {
  const { maxUsdPerRun, maxUsdPerDay } = action.budget || {};
  if (maxUsdPerRun !== undefined && estimate > maxUsdPerRun) {
    return 'оценка хода $' + estimate.toFixed(2) + ' > лимита действия на ход $' + maxUsdPerRun;
  }
  // Old Rz does not pass an actionDayTotalUsd for the ordinary once path.
  if (maxUsdPerDay !== undefined && estimate > maxUsdPerDay) {
    return 'действие за день дойдёт до $' + estimate.toFixed(2) + ' > лимита $' + maxUsdPerDay;
  }
  if (state.costPaused) return 'дневной лимит расходов уже достигнут (costPaused)';
  const limit = Number(state.dailySpendLimit);
  if (!(limit > 0) || !Number.isFinite(limit)) return;
  const recorded = state.costHistory?.[ownerDay(at, state.timezone)];
  const spent = Number.isFinite(recorded) ? recorded : 0;
  const reserve = limit * reserveFraction;
  const ceiling = limit - reserve;
  if (spent + estimate > ceiling) {
    return 'автономка остановлена: израсходовано $' + spent.toFixed(2) + ', ход +$' + estimate.toFixed(2) +
      ' превысит потолок автономки $' + ceiling.toFixed(2) + ' (резерв $' + reserve.toFixed(2) + ' для диалога)';
  }
}

export async function readReminderRefusal(action, at, env = process.env) {
  const file = path.join(actionRoot(env), 'autonomy', 'breakers.json');
  const breakers = await readOptionalJson(file).catch(() => null);
  const breaker = breakers && Object.hasOwn(breakers, action.id) ? breakers[action.id] : null;
  if (breaker?.open && Date.parse(at) < Date.parse(breaker.backoffUntil)) {
    return { status: 'skipped', detail: 'breaker открыт до ' + breaker.backoffUntil };
  }
  const detail = await boxRefusal(at, env);
  if (detail) return { status: 'blocked', detail };
}

export function currentReminderRefusal(action, state, at, reserveFraction) {
  const detail = claudeQuotaRefusal(state, at, reserveFraction) ?? spendRefusal(action, state, at, reserveFraction);
  if (detail) return { status: 'blocked', detail };
}
