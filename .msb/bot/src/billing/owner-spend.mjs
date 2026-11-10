/**
 * Owner-day view of the existing state.costHistory and dailySpendLimit.
 * [Telegram report/settings](../telegram/screens/spend.mjs) and
 * [reminder admission](../autonomy/reminder-admission.mjs) share the day.
 * [Old behavior checks](../../tests/owner-spend.test.mjs),
 * [reference contract](../../tests/reference/parity-owner-spend-contract.txt).
 */
export const SPEND_LIMIT_CHOICES = Object.freeze([0, 10, 25, 50, 100, 200]);
export const SPEND_PAUSED = '🛑 Дневной лимит достигнут. /settings → изменить лимит или возобновить.';

export function savedSpendLimit(value) {
  const limit = typeof value === 'number' ? value :
    typeof value === 'string' && value.trim() ? Number(value) : NaN;
  return Number.isFinite(limit) ? limit : undefined;
}

export function ownerSpendDay(at, timezone) {
  const date = new Date(at);
  if (!Number.isFinite(date.getTime())) return;
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(date);
  } catch {
    return date.toISOString().slice(0, 10);
  }
}

export function savedOwnerSpend(state, at) {
  const day = ownerSpendDay(at, state.timezone);
  const history = state.costHistory ?? {};
  const recent = Object.entries(history)
    .filter(([date, amount]) => /^\d{4}-\d{2}-\d{2}$/.test(date) && Number.isFinite(amount))
    .sort(([left], [right]) => right.localeCompare(left))
    .slice(0, 7);
  return {
    day,
    today: Number.isFinite(history[day]) ? history[day] : undefined,
    limit: savedSpendLimit(state.dailySpendLimit),
    recent,
  };
}
