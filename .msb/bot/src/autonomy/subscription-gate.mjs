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
