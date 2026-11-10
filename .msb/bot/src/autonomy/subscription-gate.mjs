/**
 * Legacy Claude subscription check on an existing state snapshot.
 * [Reminder admission](./reminder-admission.mjs) calls it for the current rail.
 * Other providers retain their own quota sources.
 */
import { formatReminderClock } from './reminder-time.mjs';

export function claudeQuotaRefusal(state, at, reserveFraction) {
  if (state.extAuthBypass && state.extAuthBypass !== 'claude') return;
  const snapshot = state.rateLimitInfo;
  if (!snapshot) return;
  const resetsAt = Number(snapshot.resetsAt) * 1000;
  if (!(resetsAt > Date.parse(at)) || !Number.isFinite(new Date(resetsAt).getTime())) return;
  const next = formatReminderClock(resetsAt, state.timezone);
  const title = 'подписка Claude';
  if (snapshot.status === 'rejected') {
    return title + ': провайдер уже отказывает по лимиту. Фоновые задачи вернутся, когда окно обновится — ' + next;
  }
  if (snapshot.isUsingOverage) {
    return title + ' израсходована, ходы пошли бы в платную переплату сверх неё. Фоновые задачи ждут обновления окна — ' + next;
  }
  if (!Number.isFinite(snapshot.utilization)) return;
  const used = Math.round(snapshot.utilization * 100);
  if (snapshot.rateLimitType === 'five_hour') {
    const limit = 1 - reserveFraction;
    if (snapshot.utilization >= limit) {
      return title + ' израсходована на ' + used + '%. Фоновым задачам отведено ' + Math.round(limit * 100) +
        '% окна, остальное берегу тебе на разговор с ботом. Вернутся, когда окно обновится — ' + next;
    }
    return;
  }
  if (snapshot.utilization >= 0.98) {
    return title + ' (недельный запас) израсходована на ' + used +
      '% — почти всё. Остаток берегу тебе на разговор с ботом, фоновые задачи вернутся, когда запас обновится — ' + next;
  }
}

// Codex reports percentages and both windows in the scoped native read.
const codexQuotaFreshnessMs = 60_000;

export function codexQuotaRefusal(quota, state, atMs, reserveFraction) {
  if (state.extAuthBypass !== 'codex' || !quota) return;
  const title = 'подписка Codex';
  if (quota.ordinaryDenied === true) {
    return title + ': провайдер пока не разрешает обычное использование подписки.';
  }
  const age = atMs - quota.measuredAt;
  if (!(age >= 0 && age <= codexQuotaFreshnessMs)) return;
  if (quota.spendControlReached === true) return title + ': провайдер сообщил о пределе расходов аккаунта.';
  if (quota.rateLimitReached === true) return title + ': провайдер уже отказывает по общему лимиту Codex.';

  const ceiling = 1 - reserveFraction;
  const blocking = quota.windows?.filter(window => Number.isSafeInteger(window.resetAtMs) &&
    window.resetAtMs > atMs && Number.isFinite(new Date(window.resetAtMs).getTime()) &&
    Number.isFinite(window.usedPercent) && window.usedPercent >= 0 && window.usedPercent <= 100 &&
    ((window.minutes === 300 && window.usedPercent / 100 + reserveFraction >= 1) ||
     (window.minutes === 10080 && window.usedPercent >= 98)))
    .sort((left, right) => right.resetAtMs - left.resetAtMs)[0];
  if (!blocking) return;
  const next = formatReminderClock(blocking.resetAtMs, state.timezone);
  const used = Math.round(blocking.usedPercent);
  if (blocking.minutes === 300) {
    return title + ' израсходована на ' + used + '%. Фоновым задачам отведено ' + Math.round(ceiling * 100) +
      '% окна, остальное берегу тебе на разговор с ботом. Вернутся, когда окно обновится — ' + next;
  }
  return title + ' (недельный запас) израсходована на ' + used +
    '% — почти всё. Остаток берегу тебе на разговор с ботом, фоновые задачи вернутся, когда запас обновится — ' + next;
}
