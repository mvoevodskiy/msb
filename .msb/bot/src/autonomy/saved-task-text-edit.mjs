/**
 * Owner text markers -> [existing action writer](./owner-task-update.mjs).
 * The task body is the only user field changed. [Scheduler completion](./reminder-store.mjs)
 * can settle an older attempt without replacing that body.
 * [Proof](../../tests/task-text-edit.test.mjs) covers Telegram and both races.
 */
import { randomUUID } from 'node:crypto';
import { ownsLocalSavedAction, readNativeJobMap } from './reminder-store.mjs';
import { selectSavedAction, unavailableSavedActionControl } from './saved-action-control.mjs';
import { planSavedTaskText, taskTextOperations } from './saved-task-text.mjs';
import { withOwnerTaskUpdate } from './owner-task-update.mjs';

const shownFirst = 'Сначала покажу текст, а заменю следующим сообщением: в этом ходу я писал бы новый текст по памяти, не видя показанного, и мог бы затереть то, что изменилось.';

export function editSavedTaskText(operation, query, input, context, shown) {
  const selector = query.trim();
  const body = input.trim();
  const copy = taskTextOperations[operation];
  if (!selector) return { error: copy.query };
  if (!body) return { error: copy.empty };
  return withOwnerTaskUpdate(context, async (records, save, scope) => {
    const selected = selectSavedAction(records, selector);
    if (!selected.action) return selected;
    const { action } = selected;
    if (operation === 'EDIT_TASK' && shown.some(value => selectSavedAction(records, value).action?.id === action.id)) {
      return { error: shownFirst };
    }
    const canEdit = async () => ownsLocalSavedAction(action, await readNativeJobMap(scope.env), scope.rail);
    if (!await canEdit()) {
      const error = action.migratedToOc ? unavailableSavedActionControl(action)
        : 'Изменение текста задачи «' + action.name + '» на этом движке пока недоступно.';
      return { error };
    }
    const change = planSavedTaskText(action, operation, body);
    if (change.error) return change;
    if (action.task[change.field] === change.text) return { action, timezone: scope.zone };
    const next = { ...action, task: { ...action.task, [change.field]: change.text }, taskTextRevision: randomUUID() };
    records[records.indexOf(action)] = next;
    await save(async () => {
      if (!await canEdit()) throw new Error('Action ownership changed before editing task text');
    });
    return { action: next, removed: change.removed, timezone: scope.zone };
  }, { unavailable: 'Изменение текста задач на этом движке пока не подключено.' });
}
