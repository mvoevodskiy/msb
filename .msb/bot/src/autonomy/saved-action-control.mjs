/**
 * Old z9/lg/cg selection and individual state changes for the [action store](./reminder-store.mjs).
 * [Conversation](../telegram/task-control-markers.mjs) sets a requested state.
 * The [card](../telegram/routes/autonomy.mjs) toggles the same stored fields.
 * [Run history](./saved-task-runs.mjs) shares matching with its own reply for ambiguities.
 * [Checks](../../tests/saved-task-control.test.mjs).
 */
import { spentReminder } from './reminder-schedule.mjs';

export function matchingSavedActions(records, query) {
  const candidates = records.filter(row => typeof row?.id === 'string' && typeof row.name === 'string');
  const exact = candidates.find(row => row.id === query);
  if (exact) return [exact];
  const needle = query.toLowerCase();
  return candidates.filter(row =>
    [row.name, row.task?.prompt ?? '', row.task?.text ?? ''].join('\n').toLowerCase().includes(needle));
}

export function selectSavedAction(records, query) {
  const matches = matchingSavedActions(records, query);
  if (!matches.length) return { error: 'Не нашёл задачу «' + query + '».' };
  if (matches.length > 1) return { error: 'Нашёл несколько — уточни:\n' + matches.map(row => '• ' + row.name).join('\n') };
  return { action: matches[0] };
}

export function unavailableSavedActionControl(action) {
  const name = '«' + action.name + '»';
  if (!action.migratedToOc) return 'Управление задачей ' + name + ' в этом маршруте пока не подключено.';
  if (action.disabledReason === 'migrated_to_oc') {
    return name + ' перенесена в OpenClaw при переходе: здесь она выключена, её запускает бот OpenClaw.';
  }
  return name + ' снята при переходе на OpenClaw: здесь она выключена, а в боте OpenClaw её надо завести заново.';
}

export function savedActionWithEnabled(action, enabled) {
  const next = { ...action, enabled };
  if (enabled) delete next.disabledReason;
  else next.disabledReason = 'owner';
  return next;
}

export function planSavedActionControl(action, enabled) {
  if (enabled && !action.enabled && action.disabledReason && action.disabledReason !== 'owner') {
    return { error: '«' + action.name + '» выключил не ты, а система (' + action.disabledReason +
      '). Верну, когда причина отпадёт.' };
  }
  if (enabled && spentReminder(action)) {
    return { error: '«' + action.name + '» уже сработала. Для нового запуска поставь её заново.' };
  }
  if (Boolean(action.enabled) === enabled) return { action, changed: false };
  return { action: savedActionWithEnabled(action, enabled), changed: true };
}
